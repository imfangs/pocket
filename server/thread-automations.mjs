import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AppError } from './store.mjs';
import { readBridgeConfig } from './bridge-config.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const automationId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const statuses = new Set(['ACTIVE', 'PAUSED', 'UNKNOWN']);
const weekdays = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const dayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const custom = () => ({ scheduleLabel: '自定义安排', scheduleSupported: false });
const pad = number => String(number).padStart(2, '0');

function numericList(value, maximum) {
  if (!/^\d{1,2}(,\d{1,2})*$/.test(value || '')) return null;
  const numbers = value.split(',').map(Number);
  if (numbers.some(number => number > maximum) || new Set(numbers).size !== numbers.length) return null;
  return numbers.sort((a, b) => a - b);
}

// Only describe rules whose complete meaning is supported. Never calculate a
// next run: the native scheduler owns its anchor, time zone and execution state.
export function describeAutomationSchedule(rule) {
  if (typeof rule !== 'string' || rule.length > 2048) return custom();
  const raw = rule.startsWith('RRULE:') ? rule.slice(6) : rule;
  const parts = raw.split(';'), fields = {};
  const allowed = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND']);
  for (const part of parts) {
    const match = /^([A-Z]+)=([A-Z0-9,]+)$/.exec(part);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(fields, match[1])) return custom();
    fields[match[1]] = match[2];
  }
  if (!['DAILY', 'WEEKLY'].includes(fields.FREQ) ||
      (fields.BYSECOND !== undefined && fields.BYSECOND !== '0') ||
      (fields.INTERVAL !== undefined && !/^[1-9]\d{0,3}$/.test(fields.INTERVAL))) return custom();
  const interval = Number(fields.INTERVAL || 1);
  const hours = numericList(fields.BYHOUR, 23), minutes = numericList(fields.BYMINUTE, 59);
  if (!hours || !minutes || hours.length * minutes.length > 24) return custom();
  const days = fields.BYDAY?.split(',');
  if (days && (days.some(day => !weekdays.includes(day)) || new Set(days).size !== days.length)) return custom();
  // Omitting WEEKLY's days would require the scheduler's unexposed start date.
  if ((fields.FREQ === 'WEEKLY' && !days) || (fields.FREQ === 'DAILY' && interval > 1 && days)) return custom();
  const labels = days?.slice().sort((a, b) => weekdays.indexOf(a) - weekdays.indexOf(b)).map(day => dayNames[weekdays.indexOf(day)]);
  const dayText = labels?.join('、');
  const frequency = fields.FREQ === 'WEEKLY'
    ? `${interval === 1 ? '每周' : `每 ${interval} 周`} ${dayText}`
    : days ? `每周 ${dayText}` : interval === 1 ? '每天' : `每 ${interval} 天`;
  const times = hours.flatMap(hour => minutes.map(minute => `${pad(hour)}:${pad(minute)}`));
  const consecutiveHours = minutes.length === 1 && hours.length > 3 && hours.every((hour, index) => index === 0 || hour === hours[index - 1] + 1);
  const timeText = consecutiveHours ? `${times[0]}–${times.at(-1)}，每小时一次` : times.join('、');
  return { scheduleLabel: `${frequency} ${timeText}`, scheduleSupported: true };
}

export function readNativeAutomations(payload, { python, timeoutMs = 2500 } = {}) {
  try {
    const command = python || readBridgeConfig().python;
    const stdout = execFileSync(command, [fileURLToPath(new URL('../bin/read-automations.py', import.meta.url))], {
      input: JSON.stringify(payload), encoding: 'utf8', timeout: timeoutMs,
      maxBuffer: 3 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout);
  } catch { return { ok: false }; }
}

function normalizeSnapshot(result) {
  if (result?.ok !== true || !Array.isArray(result.automations) || result.automations.length > 256) return null;
  const grouped = new Map(), seen = new Set();
  for (const row of result.automations) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !automationId.test(row.id) || seen.has(row.id) ||
        typeof row.threadId !== 'string' || !uuid.test(row.threadId) ||
        typeof row.name !== 'string' || !row.name.trim() || row.name.length > 240 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(row.name) ||
        typeof row.prompt !== 'string' || row.prompt.length > 65536 || !statuses.has(row.status) ||
        typeof row.rrule !== 'string' || row.rrule.length > 2048) return null;
    seen.add(row.id);
    const automation = { id: row.id, name: row.name, prompt: row.prompt, status: row.status,
      ...describeAutomationSchedule(row.rrule) };
    for (const key of ['createdAt', 'updatedAt']) {
      if (Number.isSafeInteger(row[key]) && row[key] >= 0 && row[key] <= 8640000000000000) automation[key] = row[key];
    }
    const rows = grouped.get(row.threadId) || [];
    rows.push(automation); grouped.set(row.threadId, rows);
  }
  for (const rows of grouped.values()) rows.sort((a, b) => a.id.localeCompare(b.id));
  return grouped;
}

export class ThreadAutomations {
  constructor(codexHome, { read = readNativeAutomations, now = Date.now, cacheMs = 15000, python, timeoutMs = 2500,
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '本机时区' } = {}) {
    Object.assign(this, { codexHome, read, now, cacheMs, python, timeoutMs, timeZone });
    this.snapshot = null;
    this.lastAttemptAt = null;
    this.stale = true;
  }
  refresh() {
    const now = this.now();
    if (this.lastAttemptAt !== null && now >= this.lastAttemptAt && now - this.lastAttemptAt < this.cacheMs) return;
    // Cache failures as well, so several open clients cannot retry in a loop.
    this.lastAttemptAt = now;
    let next = null;
    try { next = normalizeSnapshot(this.read({ codexHome: this.codexHome }, { python: this.python, timeoutMs: this.timeoutMs })); }
    catch { /* Keep the preceding complete snapshot; errors are not deletions. */ }
    this.stale = next === null;
    if (next !== null) this.snapshot = next;
  }
  enrich(catalog) {
    this.refresh();
    return { ...catalog, threads: catalog.threads.map(thread => {
      const { automationSummary: _previous, ...plain } = thread;
      const rows = this.snapshot?.get(thread.id);
      if (!rows?.length) return plain;
      return { ...plain, automationSummary: { count: rows.length,
        activeCount: rows.filter(row => row.status === 'ACTIVE').length,
        pausedCount: rows.filter(row => row.status === 'PAUSED').length,
        stale: this.stale } };
    }) };
  }
  details(threadId) {
    if (typeof threadId !== 'string' || !uuid.test(threadId)) throw new AppError('会话编号无效', 400);
    this.refresh();
    return { available: this.snapshot !== null, stale: this.stale, timeZone: this.timeZone,
      automations: (this.snapshot?.get(threadId) || []).map(row => ({ ...row })) };
  }
}
