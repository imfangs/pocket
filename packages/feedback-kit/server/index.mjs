import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync, lstatSync, realpathSync } from 'node:fs';
import { mkdir, writeFile, rename, rm, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { FeedbackError, normalizeFeedbackInput, validateFeedbackId, validateMachineId, validateFeedbackTarget } from '../contracts.ts';

const SCHEMA = 1;
const HASH = /^[a-f0-9]{64}$/;
const defaults = Object.freeze({ maxReports: 1000, maxAssetBytes: 256 * 1024 * 1024,
  maxPendingSubmissions: 4, tickMs: 1000, operationTimeoutMs: 20000,
  webhookWaitMs: 120000, receiptPollMs: 5000, retryBaseMs: 2000, retryMaxMs: 300000,
  maxPublishAttempts: 12, maxActionAttempts: 40, maxInspectionAttempts: 200 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const identity = (machine, id) => `${machine}:${id}`;
const nowValid = value => Number.isSafeInteger(value) && value >= 0;
const imageExtension = mime => mime === 'image/png' ? 'png' : 'jpg';
function mimeOf(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  return null;
}
function fail(message, status = 400, code = 'invalid_feedback') { throw new FeedbackError(message, status, code); }
function codeOf(error, fallback) {
  return typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : fallback;
}
function targetSame(a, b) { return a.machineId === b.machineId && a.key === b.key; }
export function feedbackRequestId(sourceMachine, id) {
  const value = createHash('sha256').update(`feedback-query-v1\0${validateMachineId(sourceMachine)}\0${validateFeedbackId(id)}`).digest();
  // RFC 9562 custom UUID v8: the namespace and SHA-256 construction are ours.
  value[6] = (value[6] & 15) | 128; value[8] = (value[8] & 63) | 128;
  const hex = value.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Host adapters perform authentication and signature verification before submit,
 * confirm, or receiveRelay. Delivery is a durable IDEMPOTENT enqueue keyed by
 * requestId, never a direct non-idempotent model call. A lookup's not_found must
 * be authoritative ledger absence; network/HTTP ambiguity must throw instead.
 */
export function createFeedbackService(options) { return new FeedbackService(options); }

class FeedbackService {
  constructor({ db, directory, machineId, resolveTarget, validateImage, publish, deliver,
    inspectDelivery, relay, inspectRelay, limits = {}, now = Date.now } = {}) {
    if (!db || typeof resolveTarget !== 'function') throw new Error('Feedback storage and target resolver are required');
    Object.assign(this, { db, machineId: validateMachineId(machineId), resolveTarget, validateImage,
      publish, deliver, inspectDelivery, relay, inspectRelay, now });
    this.limits = { ...defaults, ...limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid feedback limit');
    this.root = join(directory, 'feedback-assets');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink() || !lstatSync(this.root).isDirectory()) throw new Error('Invalid feedback asset directory');
    chmodSync(this.root, 0o700); this.root = realpathSync(this.root);
    this.closed = false; this.started = false; this.timer = null; this.pumping = null;
    this.operations = new Set(); this.submissions = new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS feedback_records_v1(
      record_key TEXT PRIMARY KEY, id TEXT NOT NULL, source_machine TEXT NOT NULL, app_id TEXT NOT NULL,
      digest TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, input_json TEXT NOT NULL, target_json TEXT NOT NULL,
      asset_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      phase TEXT NOT NULL, public_status TEXT NOT NULL, confirmed_at INTEGER, published_at INTEGER,
      publish_attempts INTEGER NOT NULL DEFAULT 0, action_attempts INTEGER NOT NULL DEFAULT 0,
      inspection_attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL,
      started_delivery INTEGER NOT NULL DEFAULT 0, relay_import INTEGER NOT NULL DEFAULT 0,
      code TEXT, last_receipt_json TEXT,
      UNIQUE(source_machine,id));
      CREATE INDEX IF NOT EXISTS feedback_records_v1_due ON feedback_records_v1(phase,next_attempt,created_at);`);
  }
  assertOpen() { if (this.closed) fail('反馈服务正在关闭，请稍后核对', 503, 'feedback_closed'); }
  key(id, sourceMachine = this.machineId) { return identity(validateMachineId(sourceMachine), validateFeedbackId(id)); }
  row(id, sourceMachine = this.machineId) {
    this.assertOpen();
    const row = this.db.prepare('SELECT * FROM feedback_records_v1 WHERE record_key=?').get(this.key(id, sourceMachine));
    if (!row) fail('反馈记录尚未找到', 404, 'feedback_not_found');
    return row;
  }
  receipt(id, { sourceMachine = this.machineId } = {}) { return this.public(this.row(id, sourceMachine)); }
  public(row) {
    return { schemaVersion: SCHEMA, id: row.id, sourceMachine: row.source_machine, appId: row.app_id,
      digest: row.digest, requestId: row.request_id, status: row.public_status,
      createdAt: row.created_at, updatedAt: row.updated_at, ...(row.code ? { code: row.code } : {}) };
  }
  target(appId) {
    const raw = this.resolveTarget(appId);
    if (!raw) fail('这个应用尚未配置反馈处理目标', 409, 'feedback_target_missing');
    return validateFeedbackTarget(raw);
  }
  prepare(input, sourceMachine, target) {
    const assets = input.images.map(image => {
      const bytes = Buffer.from(image.base64, 'base64');
      if (bytes.toString('base64') !== image.base64 || mimeOf(bytes) !== image.mime) fail('截图内容与格式不符', 415, 'invalid_feedback_image');
      return { kind: image.kind, mime: image.mime, width: image.width, height: image.height,
        size: bytes.length, sha256: sha(bytes), bytes };
    });
    const { images: _images, ...text } = input;
    const stored = { ...text, images: assets.map(({ bytes: _bytes, ...image }) => image) };
    const digest = sha(JSON.stringify({ schemaVersion: SCHEMA, sourceMachine, target, input: stored }));
    return { stored, assets, digest };
  }
  async submit(raw) {
    this.assertOpen();
    const input = normalizeFeedbackInput(raw), target = this.target(input.appId);
    return this.persist(input, this.machineId, target, this.now(), false);
  }
  async receiveRelay(raw, trustedSourceMachine) {
    this.assertOpen();
    const source = validateMachineId(trustedSourceMachine);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        Object.keys(raw).some(key => !['schemaVersion', 'sourceMachine', 'digest', 'createdAt', 'target', 'input'].includes(key)) ||
        raw.schemaVersion !== SCHEMA || raw.sourceMachine !== source || source === this.machineId ||
        typeof raw.digest !== 'string' || !HASH.test(raw.digest) || !nowValid(raw.createdAt) || raw.createdAt > this.now() + 300000)
      fail('反馈转发格式无效', 400, 'invalid_feedback_relay');
    const input = normalizeFeedbackInput(raw.input), target = this.target(input.appId);
    if (target.machineId !== this.machineId || !targetSame(target, validateFeedbackTarget(raw.target)))
      fail('反馈处理目标已变化', 409, 'feedback_target_changed');
    const prepared = this.prepare(input, source, target);
    if (!same(prepared.digest, raw.digest)) fail('反馈内容校验未通过', 409, 'feedback_digest_mismatch');
    return this.persist(input, source, target, raw.createdAt, true, prepared);
  }
  async persist(input, source, target, createdAt, imported, prepared = this.prepare(input, source, target)) {
    const key = this.key(input.id, source);
    const old = this.db.prepare('SELECT * FROM feedback_records_v1 WHERE record_key=?').get(key);
    if (old) {
      if (!same(old.digest, prepared.digest)) fail('这个反馈编号已用于其他内容', 409, 'feedback_conflict');
      return this.public(old);
    }
    const existing = this.submissions.get(key);
    if (existing) {
      if (!same(existing.digest, prepared.digest)) fail('这个反馈正在保存其他内容', 409, 'feedback_conflict');
      return existing.promise;
    }
    if (this.submissions.size >= this.limits.maxPendingSubmissions) fail('反馈正在保存，请稍后重试', 503, 'feedback_busy');
    const promise = this.persistNew(input, source, target, createdAt, imported, prepared).finally(() => this.submissions.delete(key));
    this.submissions.set(key, { digest: prepared.digest, promise });
    return promise;
  }
  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  quota(newBytes) {
    const value = this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(asset_bytes),0) AS bytes FROM feedback_records_v1').get();
    if (value.count >= this.limits.maxReports || value.bytes + newBytes > this.limits.maxAssetBytes)
      fail('反馈空间已满，请先处理已有记录', 413, 'feedback_storage_full');
  }
  async directoryFor(source, id) {
    const parent = join(this.root, source);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const value = await lstat(parent);
    if (!value.isDirectory() || value.isSymbolicLink() || realpathSync(parent) !== parent)
      fail('反馈存储位置无效', 500, 'feedback_storage_invalid');
    return join(parent, id);
  }
  async persistNew(input, source, target, createdAt, imported, { stored, assets, digest }) {
    const assetBytes = assets.reduce((sum, asset) => sum + asset.size, 0);
    this.quota(assetBytes);
    const destination = await this.directoryFor(source, input.id);
    const temporary = join(this.root, `.pending-${randomUUID()}`);
    let moved = false;
    try {
      await mkdir(temporary, { mode: 0o700 });
      for (const image of assets) {
        const path = join(temporary, `${image.kind}.${imageExtension(image.mime)}`);
        await writeFile(path, image.bytes, { flag: 'wx', mode: 0o600 });
        if (typeof this.validateImage !== 'function') fail('图片校验暂不可用，可先发送文字反馈', 503, 'feedback_image_validator_missing');
        let dimensions;
        try { dimensions = await this.validateImage(path, { mime: image.mime, width: image.width, height: image.height }); }
        catch { fail('截图无法读取，请换一张图片', 415, 'invalid_feedback_image'); }
        this.assertOpen();
        if (dimensions?.width !== image.width || dimensions?.height !== image.height)
          fail('截图尺寸与内容不符', 415, 'invalid_feedback_image');
      }
      if (assets.length === 2 && (assets[0].width !== assets[1].width || assets[0].height !== assets[1].height))
        fail('原图与标注图尺寸不一致', 400, 'invalid_feedback_image');
      await writeFile(join(temporary, 'manifest.json'), JSON.stringify({ schemaVersion: SCHEMA, sourceMachine: source, id: input.id, digest, input: stored, target }), { flag: 'wx', mode: 0o600 });
      this.assertOpen();
      let previous;
      try { previous = await lstat(destination); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous) {
        if (!previous.isDirectory() || previous.isSymbolicLink()) fail('反馈文件位置冲突', 409, 'feedback_files_conflict');
        await this.verifyStoredFiles(destination, stored, digest);
      } else { await rename(temporary, destination); moved = true; }
      this.assertOpen();
      const now = this.now();
      const row = this.transaction(() => {
        const existing = this.db.prepare('SELECT * FROM feedback_records_v1 WHERE record_key=?').get(this.key(input.id, source));
        if (existing) {
          if (!same(existing.digest, digest)) fail('这个反馈编号已用于其他内容', 409, 'feedback_conflict');
          return existing;
        }
        this.quota(assetBytes);
        this.db.prepare(`INSERT INTO feedback_records_v1(record_key,id,source_machine,app_id,digest,request_id,input_json,target_json,asset_bytes,
          created_at,updated_at,phase,public_status,confirmed_at,next_attempt,relay_import)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(this.key(input.id, source), input.id, source, input.appId, digest,
          feedbackRequestId(source, input.id), JSON.stringify(stored), JSON.stringify(target), assetBytes, createdAt, now,
          imported ? 'dispatch' : 'publish', imported ? 'sending' : 'received', imported ? now : null, now, Number(imported));
        return this.row(input.id, source);
      });
      this.wake(); return this.public(row);
    } catch (error) {
      // A committed record is never removed. A complete directory can also be
      // adopted by an identical retry after a crash between rename and SQL.
      if (moved && !this.closed) {
        const row = this.db.prepare('SELECT 1 FROM feedback_records_v1 WHERE record_key=?').get(this.key(input.id, source));
        if (!row) await rm(destination, { recursive: true, force: true });
      }
      throw error;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  async readSafe(path, expected) {
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { fail('反馈截图已变化或不可读取', 409, 'feedback_image_changed'); }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== expected.size) fail('反馈截图已变化', 409, 'feedback_image_changed');
      const bytes = await handle.readFile();
      if (sha(bytes) !== expected.sha256 || mimeOf(bytes) !== expected.mime) fail('反馈截图已变化', 409, 'feedback_image_changed');
      const after = await handle.stat();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
        fail('反馈截图正在变化', 409, 'feedback_image_changed');
      return bytes;
    } finally { await handle.close(); }
  }
  async verifyStoredFiles(directory, input, digest) {
    let manifest, handle;
    try {
      handle = await open(join(directory, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 65536) fail('反馈文件位置待核对', 409, 'feedback_files_conflict');
      manifest = JSON.parse(await handle.readFile('utf8'));
    }
    catch { fail('反馈文件位置待核对', 409, 'feedback_files_conflict'); }
    finally { await handle?.close(); }
    if (!same(manifest.digest, digest) || JSON.stringify(manifest.input) !== JSON.stringify(input))
      fail('反馈文件位置已用于其他内容', 409, 'feedback_files_conflict');
    for (const image of input.images) await this.readSafe(join(directory, `${image.kind}.${imageExtension(image.mime)}`), image);
  }
  async record(row, verifyImages = true) {
    const input = JSON.parse(row.input_json), target = JSON.parse(row.target_json);
    const directory = verifyImages ? await this.directoryFor(row.source_machine, row.id) : join(this.root, row.source_machine, row.id);
    if (verifyImages) {
      let info;
      try { info = await lstat(directory); }
      catch { fail('反馈文件位置不可读取', 409, 'feedback_storage_invalid'); }
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory)
        fail('反馈文件位置无效', 409, 'feedback_storage_invalid');
    }
    const images = [];
    for (const image of input.images) {
      const path = join(directory, `${image.kind}.${imageExtension(image.mime)}`);
      if (verifyImages) await this.readSafe(path, image);
      images.push({ ...image, path });
    }
    this.assertOpen();
    return { id: row.id, sourceMachine: row.source_machine, appId: row.app_id, digest: row.digest,
      requestId: row.request_id, createdAt: row.created_at, target, note: input.note,
      reason: input.reason, context: input.context, annotations: input.annotations, autoDirect: input.autoDirect, images };
  }
  async relayPayload(row, record) {
    const stored = JSON.parse(row.input_json);
    const images = [];
    for (const image of record.images) {
      const bytes = await this.readSafe(image.path, image);
      images.push({ kind: image.kind, mime: image.mime, width: image.width, height: image.height, base64: bytes.toString('base64') });
    }
    return { schemaVersion: SCHEMA, sourceMachine: row.source_machine, digest: row.digest, createdAt: row.created_at,
      target: record.target, input: { ...stored, images } };
  }
  async readImage(id, kind, { sourceMachine = this.machineId } = {}) {
    if (!['original', 'annotated'].includes(kind)) fail('截图类型无效');
    const record = await this.record(this.row(id, sourceMachine));
    const image = record.images.find(image => image.kind === kind);
    if (!image) fail('截图不存在', 404, 'feedback_image_missing');
    return { kind: image.kind, mime: image.mime, sha256: image.sha256, size: image.size,
      width: image.width, height: image.height, bytes: await this.readSafe(image.path, image) };
  }
  confirm({ id, digest }) {
    this.assertOpen();
    if (typeof digest !== 'string' || !HASH.test(digest)) fail('反馈摘要无效');
    const row = this.row(id);
    if (!same(row.digest, digest)) fail('反馈内容校验未通过', 409, 'feedback_digest_mismatch');
    if (row.confirmed_at !== null) return this.public(row);
    const now = this.now();
    this.db.prepare(`UPDATE feedback_records_v1 SET confirmed_at=?,phase='dispatch',public_status='sending',code=NULL,
      next_attempt=?,updated_at=? WHERE record_key=? AND confirmed_at IS NULL`).run(now, now, now, row.record_key);
    this.wake(); return this.receipt(id);
  }
  retry(id, { sourceMachine = this.machineId } = {}) {
    const row = this.row(id, sourceMachine);
    if (row.phase !== 'attention') return this.public(row);
    const phase = row.confirmed_at === null ? 'publish' : row.started_delivery ? 'inspect' : 'dispatch';
    this.db.prepare(`UPDATE feedback_records_v1 SET phase=?,public_status=?,next_attempt=?,updated_at=?,code=NULL,
      publish_attempts=0,action_attempts=0,inspection_attempts=0 WHERE record_key=?`).run(phase,
      phase === 'publish' ? 'received' : 'sending', this.now(), this.now(), row.record_key);
    this.wake(); return this.receipt(id, { sourceMachine });
  }
  start() { this.assertOpen(); if (this.started) return; this.started = true; this.schedule(0); }
  stop() {
    if (this.closed) return;
    this.closed = true; this.started = false; clearTimeout(this.timer); this.timer = null;
    for (const controller of this.operations) controller.abort();
  }
  schedule(delay = this.limits.tickMs) {
    if (!this.started || this.closed || this.timer !== null) return;
    this.timer = setTimeout(() => { this.timer = null; void this.tick().catch(() => {}).finally(() => this.schedule()); }, delay);
    this.timer.unref?.();
  }
  wake() { if (this.started && !this.closed) { clearTimeout(this.timer); this.timer = null; this.schedule(0); } }
  async operation(callback) {
    this.assertOpen();
    const controller = new AbortController(); this.operations.add(controller);
    let timer, abort;
    const timeout = new Promise((_, reject) => {
      abort = () => reject(new FeedbackError('反馈操作已暂停', 503, this.closed ? 'feedback_closed' : 'feedback_timeout'));
      controller.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => controller.abort(), this.limits.operationTimeoutMs); timer.unref?.();
    });
    try { return await Promise.race([Promise.resolve().then(() => {
      if (this.closed || controller.signal.aborted) throw new FeedbackError('反馈操作已暂停', 503, 'feedback_closed');
      return callback(controller.signal);
    }), timeout]); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); this.operations.delete(controller); }
  }
  backoff(attempt) { return Math.min(this.limits.retryMaxMs, this.limits.retryBaseMs * 2 ** Math.min(Math.max(0, attempt - 1), 16)); }
  update(key, fields) {
    if (this.closed) return;
    const columns = Object.keys(fields), values = Object.values(fields);
    this.db.prepare(`UPDATE feedback_records_v1 SET ${columns.map(column => `${column}=?`).join(',')},updated_at=? WHERE record_key=?`)
      .run(...values, this.now(), key);
  }
  attention(row, code) { this.update(row.record_key, { phase: 'attention', public_status: 'needs_attention', code, next_attempt: this.now() }); }
  tick() {
    this.assertOpen();
    if (this.pumping) return this.pumping;
    const work = this.runTick().finally(() => { if (this.pumping === work) this.pumping = null; });
    this.pumping = work; return work;
  }
  async runTick() {
    const rows = this.db.prepare(`SELECT * FROM feedback_records_v1 WHERE phase IN('publish','webhook','dispatch','inspect')
      AND next_attempt<=? ORDER BY next_attempt,created_at,record_key LIMIT 4`).all(this.now());
    for (let row of rows) {
      if (this.closed) return;
      row = this.db.prepare('SELECT * FROM feedback_records_v1 WHERE record_key=?').get(row.record_key);
      try {
        if (row.phase === 'publish' || row.phase === 'webhook') await this.publishRow(row);
        else if (row.phase === 'dispatch') await this.dispatchRow(row);
        else if (row.phase === 'inspect') await this.inspectRow(row);
      } catch (error) {
        if (this.closed) return;
        const latest = this.db.prepare('SELECT * FROM feedback_records_v1 WHERE record_key=?').get(row.record_key);
        const attempt = latest.phase === 'inspect' ? latest.inspection_attempts : latest.action_attempts;
        if (error.status === 409 && ['feedback_image_changed', 'feedback_storage_invalid', 'feedback_target_changed', 'feedback_target_missing'].includes(error.code)) this.attention(latest, error.code);
        else this.update(row.record_key, { code: codeOf(error, 'feedback_temporarily_unavailable'), next_attempt: this.now() + this.backoff(attempt || 1) });
      }
    }
  }
  async publishRow(row) {
    if (row.confirmed_at !== null) return;
    if (row.publish_attempts >= this.limits.maxPublishAttempts) return this.attention(row, 'feedback_webhook_unconfirmed');
    if (typeof this.publish !== 'function') return this.attention(row, 'feedback_publisher_unavailable');
    const record = await this.record(row); if (this.closed) return;
    const latestBeforeClaim = this.row(row.id, row.source_machine);
    if (latestBeforeClaim.confirmed_at !== null || !['publish', 'webhook'].includes(latestBeforeClaim.phase)) return;
    const attempt = latestBeforeClaim.publish_attempts + 1, attemptId = randomUUID();
    // An earlier webhook can arrive while assets are being read. Never replace
    // its dispatch transition with a new publication attempt.
    const claim = this.db.prepare(`UPDATE feedback_records_v1 SET publish_attempts=?,phase='publish',next_attempt=?,updated_at=?
      WHERE record_key=? AND confirmed_at IS NULL AND phase IN('publish','webhook') AND publish_attempts=?`)
      .run(attempt, this.now() + this.backoff(attempt), this.now(), row.record_key, latestBeforeClaim.publish_attempts);
    if (!claim.changes) return;
    try {
      await this.operation(signal => this.publish(record, { attemptId, attempt, signal }));
      if (this.closed) return;
      const latest = this.db.prepare('SELECT * FROM feedback_records_v1 WHERE record_key=?').get(row.record_key);
      if (latest.confirmed_at !== null) { this.update(row.record_key, { published_at: this.now() }); return; }
      this.update(row.record_key, { phase: 'webhook', public_status: 'waiting_webhook', published_at: this.now(), code: null,
        next_attempt: this.now() + this.limits.webhookWaitMs });
    } catch (error) {
      if (this.closed) return;
      const latest = this.db.prepare('SELECT * FROM feedback_records_v1 WHERE record_key=?').get(row.record_key);
      if (latest.confirmed_at !== null) return;
      if (attempt >= this.limits.maxPublishAttempts) this.attention(latest, codeOf(error, 'feedback_publish_failed'));
      else this.update(row.record_key, { code: codeOf(error, 'feedback_publish_failed'), next_attempt: this.now() + this.backoff(attempt) });
    }
  }
  async dispatchRow(row) {
    if (row.confirmed_at === null) return;
    if (row.action_attempts >= this.limits.maxActionAttempts) return this.attention(row, 'feedback_delivery_unconfirmed');
    const record = await this.record(row); if (this.closed) return;
    if (!targetSame(record.target, this.target(row.app_id))) return this.attention(row, 'feedback_target_changed');
    const local = record.target.machineId === this.machineId;
    const callback = local ? this.deliver : this.relay;
    if (typeof callback !== 'function') return this.attention(row, 'feedback_delivery_unavailable');
    const payload = local ? record : await this.relayPayload(row, record); if (this.closed) return;
    // Persist intent before crossing the adapter. A crash/lost response resumes
    // by lookup, never by blindly invoking an external mutation again.
    this.update(row.record_key, { phase: 'inspect', started_delivery: 1, public_status: 'sending',
      action_attempts: row.action_attempts + 1, next_attempt: this.now() + this.limits.receiptPollMs, code: null });
    try {
      const receipt = await this.operation(signal => callback(payload, { signal }));
      if (!this.closed) this.applyReceipt(this.row(row.id, row.source_machine), receipt, local);
    } catch (error) {
      if (!this.closed) this.update(row.record_key, { code: codeOf(error, 'feedback_delivery_unknown'), next_attempt: this.now() + this.limits.receiptPollMs });
    }
  }
  async inspectRow(row) {
    if (row.inspection_attempts >= this.limits.maxInspectionAttempts) return this.attention(row, 'feedback_delivery_unconfirmed');
    // Receipt lookup needs identity, not another read/hash of all screenshot
    // bytes. The idempotent delivery path revalidates assets before using them.
    const record = await this.record(row, false); if (this.closed) return;
    const local = record.target.machineId === this.machineId, callback = local ? this.inspectDelivery : this.inspectRelay;
    if (typeof callback !== 'function') return this.attention(row, 'feedback_inspection_unavailable');
    this.update(row.record_key, { inspection_attempts: row.inspection_attempts + 1, next_attempt: this.now() + this.limits.receiptPollMs });
    const receipt = await this.operation(signal => callback(record, { signal }));
    if (!this.closed) this.applyReceipt(this.row(row.id, row.source_machine), receipt, local);
  }
  applyReceipt(row, receipt, local) {
    if (!receipt || typeof receipt.status !== 'string') fail('反馈回执尚未确认', 503, 'feedback_receipt_invalid');
    if (receipt.requestId !== undefined && receipt.requestId !== row.request_id || receipt.id !== undefined && receipt.id !== row.id ||
        receipt.digest !== undefined && !same(receipt.digest, row.digest) || receipt.sourceMachine !== undefined && receipt.sourceMachine !== row.source_machine)
      fail('反馈回执身份不匹配', 503, 'feedback_receipt_invalid');
    const status = receipt.status, code = typeof receipt.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(receipt.code) ? receipt.code : null;
    const saved = JSON.stringify({ status, ...(code ? { code } : {}) });
    if (status === 'accepted' || !local && status === 'delivered')
      return this.update(row.record_key, { phase: 'delivered', public_status: 'delivered', last_receipt_json: saved, code: null });
    if (['rejected', 'cancelled', 'not_queued', 'editing', 'needs_attention'].includes(status))
      return this.attention(row, code || `feedback_${status}`);
    if (status === 'not_found') {
      // This is only safe because the adapter is a durable idempotent enqueue
      // and an exact ledger lookup, as required by this module's interface.
      return this.update(row.record_key, { phase: 'dispatch', public_status: 'sending', code: null, last_receipt_json: saved,
        next_attempt: this.now() + this.backoff(row.action_attempts) });
    }
    if (!['queued', 'pending', 'unknown', 'received', 'waiting_webhook', 'sending'].includes(status))
      fail('反馈回执尚未确认', 503, 'feedback_receipt_invalid');
    return this.update(row.record_key, { phase: 'inspect', public_status: status === 'queued' || status === 'pending' ? 'queued' : 'sending',
      code: status === 'unknown' ? 'feedback_delivery_unknown' : code, last_receipt_json: saved,
      ...(status === 'unknown' ? {} : { inspection_attempts: 0 }),
      next_attempt: this.now() + (status === 'unknown' ? this.backoff(row.inspection_attempts || 1) : this.limits.receiptPollMs) });
  }
}
