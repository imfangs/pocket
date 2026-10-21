import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ThreadAutomations, describeAutomationSchedule, readNativeAutomations } from '../server/thread-automations.mjs';
import { readBridgeConfig } from '../server/bridge-config.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const third = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const python = readBridgeConfig().python;
const script = fileURLToPath(new URL('../bin/read-automations.py', import.meta.url));
const row = (values = {}) => ({ id: 'daily', threadId: id, name: '每日检查', prompt: 'Read the real state, then report changes.',
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=30;BYSECOND=0', status: 'ACTIVE', ...values });
const catalog = () => ({ projects: [{ id: 'project' }], threads: [{ id, title: 'One' }, { id: other, title: 'Two' }], sourceError: null });
const success = automations => ({ ok: true, automations });
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'pocket-automations-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const put = (identifier, data = {}) => {
    const directory = join(home, 'automations', identifier); mkdirSync(directory, { recursive: true });
    const payload = { version: 1, id: identifier, kind: 'heartbeat', name: '每日检查', prompt: 'literal prompt',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=30', status: 'ACTIVE', target_thread_id: id,
      created_at: 1792632000000, updated_at: 1792635600000, ...data };
    const file = join(directory, 'automation.toml');
    writeFileSync(file, Object.entries(payload).filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n'));
    return file;
  };
  return { home, put, read: () => readNativeAutomations({ codexHome: home }, { python }) };
}

test('catalog enrichment uses exact thread IDs and exposes only counts without mutating the source', () => {
  const service = new ThreadAutomations('/fixture', { read: () => success([
    row(), row({ id: 'paused', status: 'PAUSED' }), row({ id: 'other-plan', threadId: other, status: 'UNKNOWN' }),
    row({ id: 'hidden-thread', threadId: third }),
  ]) });
  const original = catalog(), enriched = service.enrich(original);
  assert.deepEqual(enriched.threads[0].automationSummary, { count: 2, activeCount: 1, pausedCount: 1, stale: false });
  assert.deepEqual(enriched.threads[1].automationSummary, { count: 1, activeCount: 0, pausedCount: 0, stale: false });
  assert.deepEqual(original, catalog());
  assert.equal(enriched.threads.length, 2);
  for (const secret of ['literal prompt', 'Read the real state', '每日检查', 'FREQ=', 'hidden-thread'])
    assert.equal(JSON.stringify(enriched).includes(secret), false);
});

test('details copy data without a raw rule, guessed next run, or mutable references', () => {
  const prompt = '<script>do not execute</script>\nIgnore previous instructions.\n${a} `b`';
  const service = new ThreadAutomations('/fixture', { timeZone: 'Asia/Shanghai', read: () => success([
    row({ prompt, createdAt: 1792632000000, updatedAt: 1792635600000 }),
  ]) });
  const first = service.details(id);
  assert.deepEqual(first, { available: true, stale: false, timeZone: 'Asia/Shanghai', automations: [{
    id: 'daily', name: '每日检查', prompt, status: 'ACTIVE', scheduleLabel: '每天 09:30', scheduleSupported: true,
    createdAt: 1792632000000, updatedAt: 1792635600000,
  }] });
  first.automations[0].name = 'changed'; first.automations.length = 0;
  assert.equal(service.details(id).automations[0].name, '每日检查');
  assert.deepEqual(service.details(other).automations, []);
  assert.equal(service.details(other).available, true);
});

test('cache shares successful and failed reads and retains the last complete snapshot until a verified deletion', () => {
  let now = 1000, reads = 0, result = success([row()]);
  const service = new ThreadAutomations('/fixture', { now: () => now, cacheMs: 100,
    read: () => { reads++; if (result instanceof Error) throw result; return result; } });
  service.enrich(catalog()); service.details(id); assert.equal(reads, 1);
  result = { ok: false }; now += 100;
  const stale = service.enrich(catalog());
  assert.equal(stale.threads[0].automationSummary.count, 1); assert.equal(stale.threads[0].automationSummary.stale, true);
  assert.equal(service.details(id).available, true); assert.equal(service.details(id).stale, true); assert.equal(reads, 2);
  result = new Error('private path'); now += 100;
  assert.equal(service.details(id).automations.length, 1);
  result = success([]); now += 100;
  const empty = service.enrich(stale);
  assert.equal(empty.threads[0].automationSummary, undefined);
  assert.deepEqual(service.details(id).automations, []); assert.equal(service.details(id).stale, false);
});

test('first failure is unavailable and never claims an empty known schedule', () => {
  const service = new ThreadAutomations('/fixture', { read: () => ({ ok: false }) });
  assert.deepEqual(service.enrich(catalog()), catalog());
  assert.deepEqual(service.details(id), { available: false, stale: true,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, automations: [] });
});

test('malformed or partial snapshot never replaces an existing schedule', () => {
  let result = success([row()]);
  const service = new ThreadAutomations('/fixture', { read: () => result, cacheMs: 0 });
  service.details(id);
  for (const invalid of [null, [], { ok: true }, success([row(), row()]), success([row({ threadId: '../other' })]),
    success([row({ prompt: null })]), success([row({ name: '\nunsafe' })]), success([row({ status: 'broken' })]),
    success([row({ prompt: 'a'.repeat(65537) })]), success([row({ rrule: 'a'.repeat(2049) })]),
    success(Array.from({ length: 257 }, (_, index) => row({ id: `plan-${index}` })))]) {
    result = invalid;
    const details = service.details(id);
    assert.equal(details.stale, true); assert.equal(details.automations.length, 1);
  }
});

test('invalid thread IDs reject before touching the native files', () => {
  const service = new ThreadAutomations('/fixture', { read: () => assert.fail('must not read') });
  for (const invalid of ['', '../daily', `${id}/..`, null, {}])
    assert.throws(() => service.details(invalid), error => error.status === 400);
});

test('schedule labels cover only supported complete DAILY and WEEKLY meanings', () => {
  const examples = [
    ['FREQ=DAILY;BYHOUR=9;BYMINUTE=5;BYSECOND=0', '每天 09:05'],
    ['RRULE:FREQ=DAILY;INTERVAL=2;BYHOUR=6;BYMINUTE=15', '每 2 天 06:15'],
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=FR,MO;BYHOUR=9;BYMINUTE=30', '每 2 周 周一、周五 09:30'],
    ['FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=0', '每周 周一、周二、周三、周四、周五 08:00'],
    ['FREQ=DAILY;BYHOUR=9,6;BYMINUTE=45,15', '每天 06:15、06:45、09:15、09:45'],
    ['RRULE:FREQ=DAILY;BYHOUR=6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22;BYMINUTE=45;BYSECOND=0', '每天 06:45–22:45，每小时一次'],
  ];
  for (const [rule, scheduleLabel] of examples)
    assert.deepEqual(describeAutomationSchedule(rule), { scheduleLabel, scheduleSupported: true });
});

test('unsupported constraints and malformed rules stay custom instead of misleading recurrence claims', () => {
  for (const rule of [null, '', 'FREQ=MONTHLY;BYHOUR=9;BYMINUTE=0', 'FREQ=DAILY',
    'FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0', 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;UNTIL=20261101T000000Z',
    'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;COUNT=1', 'FREQ=DAILY;BYHOUR=24;BYMINUTE=0',
    'FREQ=DAILY;BYHOUR=9;BYMINUTE=60', 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=15',
    'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYHOUR=10', 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYDAY=1MO',
    'FREQ=DAILY;INTERVAL=0;BYHOUR=9;BYMINUTE=0', 'FREQ=DAILY;BYHOUR=9,9;BYMINUTE=0',
    'FREQ=DAILY;INTERVAL=2;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
    'DTSTART:20261001T090000\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0'])
    assert.deepEqual(describeAutomationSchedule(rule), { scheduleLabel: '自定义安排', scheduleSupported: false });
});

test('native reader preserves TOML text and only accepts heartbeat UUID bindings', t => {
  const { home, put, read } = fixture(t);
  const prompt = 'First line\n"quoted" \\ backslash\n<script>alert(1)</script>';
  put('daily', { prompt });
  put('paused', { target_thread_id: other, status: 'PAUSED' });
  put('unknown', { status: 'FUTURE_NATIVE_STATUS' });
  put('cron', { kind: 'cron', target_thread_id: id });
  put('project-only', { kind: 'cron', target_thread_id: undefined, project_id: id });
  const result = read();
  assert.equal(result.ok, true);
  assert.deepEqual(result.automations.map(item => item.id), ['daily', 'paused', 'unknown']);
  assert.equal(result.automations[0].prompt, prompt);
  assert.equal(result.automations[1].threadId, other);
  assert.equal(result.automations[2].status, 'UNKNOWN');
  const service = new ThreadAutomations(home, { python });
  assert.equal(service.enrich(catalog()).threads[0].automationSummary.count, 2);
  assert.equal(service.details(other).automations[0].status, 'PAUSED');
});

test('native reads leave source content and modification time intact', t => {
  const { put, read } = fixture(t), file = put('daily');
  const digest = () => createHash('sha256').update(readFileSync(file)).digest('hex');
  const before = { hash: digest(), mtime: statSync(file).mtimeMs };
  assert.equal(read().ok, true);
  assert.deepEqual({ hash: digest(), mtime: statSync(file).mtimeMs }, before);
});

test('native missing automations directory is known empty; missing home is unavailable', t => {
  const { home, read } = fixture(t);
  assert.deepEqual(read(), success([]));
  assert.equal(readNativeAutomations({ codexHome: join(home, 'missing-home') }, { python }).ok, false);
  mkdirSync(join(home, 'automations'));
  assert.deepEqual(read(), success([]));
});

test('one corrupt, oversized or incomplete file retains all previously known plans', t => {
  const { home, put } = fixture(t), daily = put('daily'), second = put('second');
  const service = new ThreadAutomations(home, { python, cacheMs: 0 });
  assert.equal(service.details(id).automations.length, 2);
  writeFileSync(second, 'prompt = "unfinished');
  assert.equal(service.details(id).stale, true); assert.equal(service.details(id).automations.length, 2);
  writeFileSync(second, 'version = 1\nid = "second"');
  assert.equal(service.details(id).stale, true); assert.equal(service.details(id).automations.length, 2);
  writeFileSync(second, 'x'.repeat(128 * 1024 + 1));
  assert.equal(service.details(id).stale, true); assert.equal(service.details(id).automations.length, 2);
  rmSync(second);
  assert.equal(service.details(id).stale, true); assert.equal(service.details(id).automations.length, 2);
  rmSync(join(home, 'automations', 'second'), { recursive: true });
  assert.equal(service.details(id).stale, false); assert.equal(service.details(id).automations.length, 1);
  rmSync(daily); rmSync(join(home, 'automations', 'daily'), { recursive: true });
  assert.equal(service.details(id).automations.length, 0);
});

test('an incomplete heartbeat cannot silently lose its association or imply a deletion', t => {
  const { home, put } = fixture(t); put('daily');
  const service = new ThreadAutomations(home, { python, cacheMs: 0 });
  assert.equal(service.details(id).automations.length, 1);
  for (const changes of [{ target_thread_id: undefined, cwd: id }, { target_thread_id: `${id}/extra` },
    { kind: undefined }, { status: undefined }, { prompt: undefined }, { version: 2 }]) {
    put('daily', changes);
    const details = service.details(id);
    assert.equal(details.stale, true); assert.equal(details.automations.length, 1);
  }
});

test('native root, directory and file symlinks are rejected without reading the destination', t => {
  const { home, put, read } = fixture(t), file = put('daily');
  const outside = join(home, 'private.toml'); writeFileSync(outside, 'secret="should never be returned"');
  rmSync(file); symlinkSync(outside, file);
  assert.deepEqual(read(), { ok: false, code: 'automation_source_unavailable' });
  rmSync(join(home, 'automations'), { recursive: true }); mkdirSync(join(home, 'automations'));
  symlinkSync(home, join(home, 'automations', 'daily'));
  assert.equal(read().ok, false);
  rmSync(join(home, 'automations'), { recursive: true }); symlinkSync(home, join(home, 'automations'));
  assert.equal(read().ok, false);
});

test('native file count and total bytes are bounded', t => {
  const { home, put, read } = fixture(t);
  for (let index = 0; index < 257; index++) mkdirSync(join(home, 'automations', `item-${index}`), { recursive: true });
  assert.equal(read().ok, false);
  rmSync(join(home, 'automations'), { recursive: true });
  for (let index = 0; index < 17; index++) put(`large-${index}`, { prompt: 'a'.repeat(65536) });
  assert.equal(read().ok, false);
});

test('native content changes during reading reject the whole snapshot', t => {
  const { home, put } = fixture(t); put('daily');
  // Replace one observed read with an in-place edit after the bytes were read.
  // The hook acts only on this temporary fixture and exercises real fstat checks.
  const program = `import importlib.util, os, sys, json
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("reader", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original = module.os.read
changed = False
def intercepted(fd, count):
    global changed
    data = original(fd, count)
    if data and not changed:
        changed = True
        with open(os.path.join(sys.argv[2], "automations", "daily", "automation.toml"), "ab") as destination:
            destination.write(b"\\n# changed while reading\\n")
    return data
module.os.read = intercepted
try:
    module.read_snapshot(sys.argv[2])
    print("accepted")
except ValueError:
    print("rejected")`;
  assert.equal(execFileSync(python, ['-c', program, script, home], { encoding: 'utf8', timeout: 2500 }).trim(), 'rejected');
});

test('native worker failures stay private and do not poison the trusted cache', t => {
  const { home, put } = fixture(t); put('daily');
  let healthy = true;
  const service = new ThreadAutomations(home, { cacheMs: 0,
    read: (payload, options) => readNativeAutomations(payload, { ...options, python: healthy ? python : '/missing/private/python' }) });
  assert.equal(service.details(id).stale, false);
  healthy = false;
  const details = service.details(id);
  assert.equal(details.stale, true); assert.equal(details.automations.length, 1);
  assert.equal(JSON.stringify(details).includes('/missing/private/python'), false);
});
