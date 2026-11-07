import webpush from 'web-push';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, ECDH } from 'node:crypto';
import { AppError } from './store.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const DAY = 86400000;
const labels = { completed: '任务已完成', failed: '任务执行失败', attention: '任务需要你处理' };
export function notificationTitle(value) {
  const title = typeof value === 'string' ? value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim() : '';
  return title ? Array.from(title).slice(0, 120).join('') : 'Pocket';
}
export function validateSubscription(value) {
  try {
    const url = new URL(value.endpoint);
    const allowed = url.hostname === 'web.push.apple.com' || url.hostname.endsWith('.push.apple.com') ||
      ['fcm.googleapis.com', 'updates.push.services.mozilla.com'].includes(url.hostname);
    if (!allowed || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || value.endpoint.length > 2048) throw Error();
    const keys = value.keys;
    if (!keys || !/^[A-Za-z0-9_-]+$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]+$/.test(keys.auth)) throw Error();
    const publicKey = Buffer.from(keys.p256dh, 'base64url');
    if (publicKey.length !== 65 || publicKey[0] !== 4 || Buffer.from(keys.auth, 'base64url').length !== 16) throw Error();
    ECDH.convertKey(publicKey, 'prime256v1');
    return { endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth } };
  } catch { throw new AppError('通知订阅无效', 400); }
}
function stateOf(history) {
  if (history.source !== 'desktop') return null;
  return { turn: history.latestTurnId || null, status: history.latestTurnStatus || history.runtime,
    requests: [...(history.pendingRequests || []).map(r => r.key), ...(history.asyncQuestions || []).map(q => q.key)].sort(),
    active: history.runtime === 'active' };
}
export class Notifications {
  constructor(store, desktop, { send = webpush.sendNotification.bind(webpush), now = Date.now, subject = process.env.NAVIGATOR_PUSH_SUBJECT || 'https://pocket.invalid', machineId = 'local' } = {}) {
    if (typeof machineId !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(machineId)) throw new Error('Invalid Pocket machine ID');
    Object.assign(this, { store, desktop, send, now, subject, machineId, stopped: false });
    const path = join(store.directory, 'web-push-keys.json');
    try { this.keys = JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.keys = webpush.generateVAPIDKeys();
      writeFileSync(path, JSON.stringify(this.keys), { mode: 0o600, flag: 'wx' });
    }
    store.db.exec(`CREATE TABLE IF NOT EXISTS push_devices(id TEXT PRIMARY KEY,subscription TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS push_watches(thread_id TEXT PRIMARY KEY,state TEXT,source_updated INTEGER,touched_at INTEGER NOT NULL,checked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS push_deliveries(id TEXT NOT NULL,device_id TEXT NOT NULL,thread_id TEXT NOT NULL,kind TEXT NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,PRIMARY KEY(id,device_id));`);
  }
  config() { return { publicKey: this.keys.publicKey, scope: 'pocket', machineId: this.machineId, deviceCount: this.devices().length }; }
  devices() { return this.store.db.prepare('SELECT * FROM push_devices WHERE updated_at>?').all(this.now() - 30 * DAY); }
  subscriptionState(endpoint) { return { enabled: typeof endpoint === 'string' && !!this.store.db.prepare('SELECT id FROM push_devices WHERE id=? AND updated_at>?').get(hash(endpoint), this.now() - 30 * DAY) }; }
  subscribe(input) {
    const subscription = validateSubscription(input), id = hash(subscription.endpoint);
    if (!this.subscriptionState(subscription.endpoint).enabled && this.devices().length >= 10) throw new AppError('已达到 10 台通知设备上限', 409);
    const now = this.now();
    this.store.db.prepare('INSERT INTO push_devices VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET subscription=excluded.subscription,updated_at=excluded.updated_at')
      .run(id, JSON.stringify(subscription), now, now);
    return { enabled: true };
  }
  unsubscribe(endpoint) {
    if (typeof endpoint !== 'string' || endpoint.length > 2048) throw new AppError('通知订阅无效', 400);
    const id = hash(endpoint);
    this.store.db.prepare('DELETE FROM push_devices WHERE id=?').run(id);
    this.store.db.prepare('DELETE FROM push_deliveries WHERE device_id=?').run(id);
    return { enabled: false };
  }
  followSubmission(id, turnId) {
    if (this.desktop.isLifecycleBlocked?.(id)) return;
    if (this.stopped || !this.devices().length || typeof turnId !== 'string') return;
    const previous = this.store.db.prepare('SELECT * FROM push_watches WHERE thread_id=?').get(id);
    // An accepted submission is a baseline even if the first browser history read never completed.
    // Preserve actual pending requests until the owner confirms that they are resolved.
    const state = previous?.state ? JSON.parse(previous.state) : { turn: turnId, status: 'accepted', requests: [] };
    state.active = true;
    this.store.db.prepare('INSERT INTO push_watches VALUES(?,?,?,?,0) ON CONFLICT(thread_id) DO UPDATE SET state=excluded.state,touched_at=excluded.touched_at,checked_at=0')
      .run(id, JSON.stringify(state), previous?.source_updated ?? null, this.now());
    this.store.db.prepare('DELETE FROM push_watches WHERE thread_id NOT IN(SELECT thread_id FROM push_watches ORDER BY touched_at DESC LIMIT 100)').run();
  }
  watch(id, history) {
    if (this.desktop.isLifecycleBlocked?.(id)) return;
    if (this.stopped || !this.devices().length) return;
    const thread = this.store.thread(id), state = stateOf(history), now = this.now();
    const previous = this.store.db.prepare('SELECT * FROM push_watches WHERE thread_id=?').get(id);
    if (state) this.observe(id, state, previous?.state ? JSON.parse(previous.state) : null);
    this.store.db.prepare('INSERT INTO push_watches VALUES(?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET state=COALESCE(excluded.state,push_watches.state),source_updated=COALESCE(excluded.source_updated,push_watches.source_updated),touched_at=excluded.touched_at,checked_at=excluded.checked_at')
      .run(id, state ? JSON.stringify(state) : null, state ? thread.updatedAt : null, now, state ? now : previous?.checked_at || 0);
    this.store.db.prepare('DELETE FROM push_watches WHERE thread_id NOT IN(SELECT thread_id FROM push_watches ORDER BY touched_at DESC LIMIT 100)').run();
  }
  observe(id, next, previous) {
    const activeRequests = new Set(next.requests.map(key => hash(`${id}:attention:${key}`)));
    for (const delivery of this.store.db.prepare("SELECT id FROM push_deliveries WHERE thread_id=? AND kind='attention' AND status='pending'").all(id))
      if (!activeRequests.has(delivery.id)) this.store.db.prepare("UPDATE push_deliveries SET status='resolved' WHERE id=?").run(delivery.id);
    if (!previous) return; // Do not notify old completions when first opening a task.
    if (next.turn && ['completed', 'failed'].includes(next.status) && (next.turn !== previous.turn || next.status !== previous.status))
      this.enqueue(id, next.status, next.turn);
    for (const key of next.requests) if (!previous.requests.includes(key)) this.enqueue(id, 'attention', key);
  }
  enqueue(threadId, kind, key) {
    const now = this.now(), id = hash(`${threadId}:${kind}:${key}`);
    for (const device of this.devices()) this.store.db.prepare("INSERT OR IGNORE INTO push_deliveries(id,device_id,thread_id,kind,created_at,status,next_at) VALUES(?,?,?,?,?,'pending',?)")
      .run(id, device.id, threadId, kind, now, now);
  }
  async tick() {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const now = this.now();
      this.store.db.prepare('DELETE FROM push_watches WHERE touched_at<?').run(now - 7 * DAY);
      this.store.db.prepare('DELETE FROM push_deliveries WHERE created_at<?').run(now - 7 * DAY);
      this.store.db.prepare('DELETE FROM push_devices WHERE updated_at<?').run(now - 30 * DAY);
      if (!this.devices().length) return;
      await this.deliver();
      if (this.stopped) return;
      const candidates = this.store.db.prepare('SELECT * FROM push_watches ORDER BY checked_at ASC').all().filter(w => {
        let t; try { t = this.store.thread(w.thread_id); } catch { return false; }
        if (t.archived || t.missing || this.desktop.isLifecycleBlocked?.(w.thread_id) || now - w.checked_at < 10000) return false;
        const state = w.state ? JSON.parse(w.state) : null;
        return !state || state.active || state.requests.length || t.updatedAt !== w.source_updated;
      }).slice(0, 4);
      for (const watch of candidates) {
        if (this.stopped) return;
        try {
          const history = await this.desktop.history(watch.thread_id);
          if (this.stopped) return;
          const state = stateOf(history);
          if (state) {
            this.observe(watch.thread_id, state, watch.state ? JSON.parse(watch.state) : null);
            this.store.db.prepare('UPDATE push_watches SET state=?,source_updated=? WHERE thread_id=?').run(JSON.stringify(state), this.store.thread(watch.thread_id).updatedAt, watch.thread_id);
          }
        } catch { /* A failed read is not a task completion. */ }
        finally {
          if (!this.stopped) this.store.db.prepare('UPDATE push_watches SET checked_at=? WHERE thread_id=?').run(this.now(), watch.thread_id);
        }
      }
      await this.deliver();
    } finally { this.running = false; }
  }
  async deliver() {
    if (this.stopped) return;
    const now = this.now();
    this.store.db.prepare("UPDATE push_deliveries SET status='expired' WHERE status='pending' AND created_at<?").run(now - 10 * 60000);
    const rows = this.store.db.prepare("SELECT p.*,d.subscription FROM push_deliveries p JOIN push_devices d ON d.id=p.device_id WHERE p.status='pending' AND p.next_at<=? ORDER BY p.created_at LIMIT 12").all(now);
    for (const row of rows) {
      if (this.stopped) return;
      if (this.desktop.isLifecycleBlocked?.(row.thread_id)) continue;
      try {
        const thread = this.store.thread(row.thread_id);
        if (thread.archived || thread.missing) {
          this.store.db.prepare("UPDATE push_deliveries SET status='resolved' WHERE id=? AND device_id=?").run(row.id, row.device_id);
          continue;
        }
        if (row.kind === 'attention') {
          const fresh = stateOf(await this.desktop.history(row.thread_id));
          if (this.stopped) return;
          if (!fresh) {
            this.store.db.prepare('UPDATE push_deliveries SET next_at=? WHERE id=? AND device_id=?').run(this.now() + 30000, row.id, row.device_id);
            continue;
          }
          if (!fresh.requests.some(key => hash(`${row.thread_id}:attention:${key}`) === row.id)) {
            this.store.db.prepare("UPDATE push_deliveries SET status='resolved' WHERE id=? AND device_id=?").run(row.id, row.device_id);
            continue;
          }
        }
        await this.send(JSON.parse(row.subscription), JSON.stringify({ title: notificationTitle(this.store.thread(row.thread_id).title), body: labels[row.kind], machineId: this.machineId, threadId: row.thread_id, eventId: row.id }), {
          TTL: 120, urgency: row.kind === 'attention' ? 'high' : 'normal', timeout: 10000,
          vapidDetails: { subject: this.subject, ...this.keys },
        });
        if (this.stopped) return;
        this.store.db.prepare("UPDATE push_deliveries SET status='sent',attempts=attempts+1 WHERE id=? AND device_id=?").run(row.id, row.device_id);
      } catch (e) {
        if (this.stopped) return;
        if ([404, 410].includes(e.statusCode)) this.unsubscribe(JSON.parse(row.subscription).endpoint);
        else this.store.db.prepare('UPDATE push_deliveries SET status=?,attempts=attempts+1,next_at=? WHERE id=? AND device_id=?')
          .run(row.attempts >= 2 || (e.statusCode >= 400 && e.statusCode < 500 && e.statusCode !== 429) ? 'failed' : 'pending', this.now() + 30000 * (row.attempts + 1), row.id, row.device_id);
      }
    }
  }
  start() { this.stopped = false; this.timer = setInterval(() => void this.tick().catch(() => {}), 10000); this.timer.unref(); }
  stop() { this.stopped = true; clearInterval(this.timer); }
}
