import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(readFileSync(join(root, 'config/desktop-bridge.json'), 'utf8'));
const load = `import importlib.util,json,sys,time\n` +
  `spec=importlib.util.spec_from_file_location('task_statuses',${JSON.stringify(join(root, 'bin/task-statuses.py'))})\n` +
  `m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n` +
  `data=json.load(sys.stdin)\n`;

async function python(program, input, { onChild } = {}) {
  const child = spawn(config.python, ['-B', '-c', load + program], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  onChild?.(child);
  const output = [], errors = [];
  child.stdout.on('data', b => output.push(b));
  child.stderr.on('data', b => errors.push(b));
  const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
  child.stdin.end(JSON.stringify(input));
  const [code] = await once(child, 'close');
  clearTimeout(timer);
  assert.equal(code, 0, Buffer.concat(errors).toString());
  return JSON.parse(Buffer.concat(output).toString());
}

function fixtureHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'pocket-status-'));
  mkdirSync(join(home, 'sessions'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
const event = (type, turn = 'turn') => ({ type: 'event_msg', payload: { type, turn_id: turn } });
const context = turn => ({ type: 'turn_context', payload: { turn_id: turn } });
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
function rollout(home, threadId, rows = [event('task_started')]) {
  const path = join(home, 'sessions', `${threadId}.jsonl`);
  writeFileSync(path, lines([{ type: 'session_meta', payload: { id: threadId } }, ...rows]));
  return { threadId, path };
}
const state = (id, type = 'active', flags = []) => ({
  id, hostId: 'local', resumeState: 'resumed',
  threadRuntimeStatus: { type, activeFlags: flags }, hasUnreadTurn: false,
  turns: [{ items: [{ role: 'user', text: 'DO_NOT_EXPOSE_BODY_OR_SETTINGS' }] }],
});

async function desktop(t, home, snapshots, { ownerDelay = 0 } = {}) {
  mkdirSync(join(home, 'ipc'), { mode: 0o700 });
  const calls = [], sockets = new Set(), timers = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    const send = object => {
      if (socket.destroyed) return;
      const body = Buffer.from(JSON.stringify(object)), header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    };
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= pending.readUInt32LE(0) + 4) {
        const size = pending.readUInt32LE(0), message = JSON.parse(pending.subarray(4, size + 4));
        pending = pending.subarray(size + 4);
        calls.push(message);
        if (message.type === 'request') {
          const answer = () => send({ type: 'response', method: message.method, requestId: message.requestId,
            resultType: 'success', handledByClientId: 'real-owner',
            result: message.method === 'initialize' ? { clientId: 'pocket-fixture' } : {} });
          if (ownerDelay && message.method === 'thread-owner-discovery') {
            const timer = setTimeout(answer, ownerDelay); timers.add(timer);
          } else answer();
        }
        if (message.type === 'broadcast' && message.params?.following) {
          const id = message.params.conversationId;
          const frame = snapshot => ({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11,
            sourceClientId: 'real-owner', targetClientIds: ['pocket-fixture'], params: { hostId: 'local', conversationId: id,
              change: { type: 'snapshot', revision: 1, conversationState: snapshot } } });
          const value = snapshots[id];
          if (typeof value === 'function') value({ send, frame, id, socket });
          else if (value) send(frame(value));
        }
      }
    });
  });
  server.listen(join(home, 'ipc/ipc.sock'));
  await once(server, 'listening');
  chmodSync(join(home, 'ipc/ipc.sock'), 0o600);
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return calls;
}

async function observe(home, candidates, options = {}) {
  return python(`
import signal
signal.signal(signal.SIGTERM,m.interrupted)
result=m.execute(data['request'],
    discover=lambda home,allowed,deadline,app: {'available':True,'candidates':data['candidates']},
    verify=lambda: {},budget_seconds=data['budget'])
print(json.dumps(result))
`, { request: { codexHome: home, threadIds: options.threadIds ?? candidates.map(c => c.threadId),
    excludedThreadIds: options.excluded ?? [],
    ...(options.priorityThreadIds === undefined ? {} : { priorityThreadIds: options.priorityThreadIds }),
    ...(options.rotation === undefined ? {} : { rotation: options.rotation }) }, candidates, budget: options.budget ?? 4.7 }, { onChild: options.onChild });
}

const hotId = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

test('status discovery accepts only the original App descendants and write-open rollout descriptors', async () => {
  const value = await python(`
app={'main':'/app/ChatGPT','binary':'/app/codex'}
pids=m.app_process_ids(data['ps'],app)
print(json.dumps({'pids':sorted(pids),'paths':sorted(m.writable_rollouts(data['lsof'],pids))}))
`, { ps: '10 1 /app/ChatGPT\n11 10 /app/codex\n12 1 /app/codex\n13 10 /unrelated/codex\n14 11 /app/codex\n15 15 /app/codex\n',
    lsof: 'p11\nf4\nau\nn/allowed\nf5\nar\nn/read-only\nf6\nn/no-access\np12\nf4\naw\nn/terminal-cli\np14\nf8\naw\nn/descendant\n' });
  assert.deepEqual(value, { pids: [11, 14], paths: ['/allowed', '/descendant'] });
});

test('candidate discovery intersects allowed original root threads without exposing or changing source data', async t => {
  const home = fixtureHome(t), dbPath = join(home, 'state_5.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,archived INTEGER,source TEXT,thread_source TEXT,agent_path TEXT,updated_at INTEGER)');
  for (const [id, archived, source, agentPath] of [['allowed', 0, 'user', '/root'], ['excluded', 0, 'user', '/root'], ['archived', 1, 'user', '/root'], ['child', 0, 'subagent', '/root/sub']]) {
    db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run(id, rollout(home, id).path, archived, 'app', source, agentPath, 1);
  }
  db.close(); const before = readFileSync(dbPath);
  const value = await python(`
from pathlib import Path
from types import SimpleNamespace
def run(args,**kwargs):
    text='10 1 /app/main\\n11 10 /app/codex\\n' if args[0]=='/bin/ps' else data['lsof']
    return SimpleNamespace(returncode=0,stdout=text)
m.subprocess.run=run
print(json.dumps(m.discover_candidates(Path(data['home']),set(data['allowed']),time.monotonic()+3,{'main':'/app/main','binary':'/app/codex'})))
`, { home, allowed: ['allowed', 'archived', 'child'],
    lsof: 'p11\n' + ['allowed', 'excluded', 'archived', 'child'].map((id, i) => `f${i + 3}\nau\nn${join(home, 'sessions', `${id}.jsonl`)}\n`).join('') });
  assert.equal(value.available, true);
  assert.deepEqual(value.candidates.map(c => c.threadId), ['allowed']);
  assert.deepEqual(readFileSync(dbPath), before);
});

test('bounded lifecycle evidence never promotes an older turn completion over newer context or input', async () => {
  const cases = [
    [event('task_started'), context('turn'), event('task_complete')],
    [event('task_complete', 'old'), context('new'), event('task_complete', 'old')],
    [event('task_complete', 'old'), { type: 'event_msg', payload: { type: 'user_message', message: 'new' } }, event('task_complete', 'old')],
    [event('task_started', 'new'), event('turn_aborted', 'old')],
    [event('task_complete', 'old'), { type: 'response_item', payload: { role: 'user', content: [] } }],
    [event('task_complete', 'old'), { type: 'compacted', payload: {} }, event('task_complete', 'old')],
    [{ type: 'event_msg', payload: { type: 'task_complete' } }],
  ];
  const value = await python(`print(json.dumps([m.recorded_state(text) for text in data]))`, [
    ...cases.map(lines), lines([event('task_complete')]) + '{"incomplete":',
    '{"broken":\n' + lines([event('task_complete')]),
  ]);
  assert.deepEqual(value, ['ended', 'unknown', 'unknown', 'unconfirmed', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
});

test('tail checks preserve unknown long turns, verify identity and reject out-of-scope files', async t => {
  const home = fixtureHome(t), valid = rollout(home, 'long', [event('task_started')]);
  appendFileSync(valid.path, lines([{ type: 'response_item', payload: { text: 'x'.repeat(300000) } }]));
  const outside = join(home, 'outside.jsonl');
  writeFileSync(outside, lines([{ type: 'session_meta', payload: { id: 'outside' } }, event('task_complete')]));
  const value = await python(`
from pathlib import Path
home=Path(data['home'])
print(json.dumps([m.read_recorded_state(home,entry['threadId'],entry['path']) for entry in data['entries']]))
`, { home, entries: [valid, { ...valid, threadId: 'wrong' }, { threadId: 'outside', path: outside }] });
  assert.deepEqual(value, ['unknown', 'unknown', 'unknown']);
});

test('native read snapshots distinguish active, approval, input and idle, even when a running thread is already read', async t => {
  const home = fixtureHome(t);
  const candidates = ['run', 'approval', 'input', 'native-idle', 'ended'].map(id => rollout(home, id,
    id === 'ended' ? [event('task_complete')] : [event('task_started')]));
  const calls = await desktop(t, home, { run: state('run'), approval: state('approval', 'active', ['waitingOnApproval']),
    input: state('input', 'active', ['waitingOnUserInput']), 'native-idle': state('native-idle', 'idle') });
  const result = await observe(home, candidates);
  assert.equal(result.available, true);
  assert.equal(result.scannedCandidates, 5);
  assert.equal(result.checkedCandidates, 4);
  assert.deepEqual(result.states.map(s => s.status), ['running', 'waiting_approval', 'waiting_input', 'idle', 'idle']);
  assert.equal(JSON.stringify(result).includes('DO_NOT_EXPOSE'), false);
  assert.ok(result.states.every(s => Number.isInteger(s.checkedAt) && s.checkedAt <= result.checkedAt));
  assert.ok(calls.filter(c => c.type === 'request').every(c => ['initialize', 'thread-owner-discovery'].includes(c.method)));
  const following = calls.filter(c => c.method === 'thread-stream-following-changed');
  assert.deepEqual(following.map(c => [c.params.conversationId, c.params.following]),
    ['run', 'approval', 'input', 'native-idle'].flatMap(id => [[id, true], [id, false]]));
});

test('owner, host and thread identity are required and stale foreign snapshots cannot claim running', async t => {
  const home = fixtureHome(t), candidates = ['foreign', 'identity', 'host', 'version'].map(id => rollout(home, id));
  await desktop(t, home, {
    foreign: ({ send, frame, id }) => {
      send({ ...frame(state(id)), sourceClientId: 'previous-owner' });
      send(frame(state(id, 'idle')));
    },
    identity: ({ send, frame }) => send(frame(state('different-thread'))),
    host: ({ send, frame, id }) => send(frame({ ...state(id), hostId: 'remote' })),
    version: ({ send, frame, id }) => send({ ...frame(state(id)), version: 999 }),
  });
  const result = await observe(home, candidates);
  assert.deepEqual(result.states.map(s => s.status), ['idle', 'unknown', 'unknown', 'unknown']);
});

test('not-loaded, closed, unsupported and unresumed runtime snapshots never become running', async () => {
  const values = [state('one', 'notLoaded'), state('one', 'closed'), state('one', 'futureStatus'),
    { ...state('one'), resumeState: 'needs_resume' }, { ...state('one'), resumeState: 'closed' },
    { ...state('one'), threadRuntimeStatus: { type: 'active', activeFlags: 'invalid' } }, {}];
  const result = await python(`print(json.dumps([m.native_status(s) for s in data]))`, values);
  assert.deepEqual(result, values.map(() => 'unknown'));
});

test('a stalled owner respects the whole-call budget and later candidates stay unknown', async t => {
  const home = fixtureHome(t), candidates = ['slow', 'later'].map(id => rollout(home, id));
  candidates.push(rollout(home, 'ended', [event('task_complete')]));
  const calls = await desktop(t, home, {}, { ownerDelay: 2000 });
  const begin = performance.now(), result = await observe(home, candidates, { budget: 0.3 });
  assert.ok(performance.now() - begin < 1500);
  assert.equal(result.checkedCandidates, 1);
  assert.deepEqual(result.states.map(s => s.status), ['unknown', 'unknown', 'idle']);
  assert.equal(calls.some(c => c.params?.following), false);
});

test('a stalled snapshot immediately detaches and cannot reuse prior runtime observations', async t => {
  const home = fixtureHome(t), candidates = [rollout(home, 'stalled')];
  const calls = await desktop(t, home, {});
  const result = await observe(home, candidates, { budget: 0.3 });
  assert.equal(result.states[0].status, 'unknown');
  assert.deepEqual(calls.filter(c => c.method === 'thread-stream-following-changed').map(c => c.params.following), [true, false]);
});

test('SIGTERM during candidate A detaches A and never discovers or subscribes to candidate B', async t => {
  const home = fixtureHome(t), candidates = ['A', 'B'].map(id => rollout(home, id));
  let process;
  const calls = await desktop(t, home, {
    A: () => process.kill('SIGTERM'),
    B: state('B'),
  });
  const result = await observe(home, candidates, { onChild: child => { process = child; } });
  assert.equal(result.available, false);
  assert.equal(result.checkedCandidates, 1);
  assert.deepEqual(result.states.map(s => s.status), ['unknown', 'unknown']);
  assert.deepEqual(calls.filter(c => c.method === 'thread-owner-discovery').map(c => c.params.conversationId), ['A']);
  assert.deepEqual(calls.filter(c => c.method === 'thread-stream-following-changed').map(c => [c.params.conversationId, c.params.following]), [['A', true], ['A', false]]);
});

test('scope exclusions and the 32-candidate cap are enforced before any native subscriptions', async t => {
  const home = fixtureHome(t), candidates = Array.from({ length: 40 }, (_, i) => rollout(home, `t${i}`, [event('task_complete')]));
  const result = await observe(home, candidates, { excluded: ['t0'], threadIds: candidates.map(c => c.threadId).filter(id => id !== 't1') });
  assert.equal(result.scannedCandidates, 32);
  assert.equal(result.checkedCandidates, 0);
  assert.deepEqual(result.states.map(s => s.threadId), candidates.slice(2, 34).map(c => c.threadId));
  assert.ok(result.states.every(s => s.status === 'idle'));
});

test('hot hints include older discovered owners while retaining ordinary candidate slots', async t => {
  const home = fixtureHome(t), candidates = Array.from({ length: 60 }, (_, i) => rollout(home, hotId(i), [event('task_complete')]));
  const priorityThreadIds = candidates.slice(30).map(row => row.threadId);
  const result = await observe(home, candidates, { priorityThreadIds: [hotId(99), ...priorityThreadIds], excluded: [hotId(30)] });
  assert.equal(result.scannedCandidates, 32);
  assert.equal(result.checkedCandidates, 0);
  assert.deepEqual(result.states.map(row => row.threadId), [
    ...candidates.slice(31, 47).map(row => row.threadId),
    ...candidates.slice(0, 16).map(row => row.threadId),
  ]);
  assert.ok(result.states.every(row => row.status === 'idle'));
  assert.equal(result.states.some(row => row.threadId === hotId(30) || row.threadId === hotId(99)), false);
});

test('probe rotation gives both hot and ordinary owners a turn under a one-probe budget', async t => {
  const home = fixtureHome(t), candidates = Array.from({ length: 8 }, (_, i) => rollout(home, hotId(i)));
  const priorityThreadIds = candidates.slice(0, 4).map(row => row.threadId);
  const value = await python(`
attempts=[]
clock=[0.0]
m.time.monotonic=lambda: clock[0]
class Client:
    def __init__(self,path,deadline): self.deadline=deadline
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def status(self,thread_id):
        attempts.append(thread_id)
        clock[0]=self.deadline
        raise TimeoutError('slow owner')
results=[]
for rotation in range(8):
    results.append(m.execute({**data['request'],'rotation':rotation},
        discover=lambda *args: {'available':True,'candidates':data['candidates']},
        verify=lambda: {},client_factory=Client,budget_seconds=0.3))
print(json.dumps({'attempts':attempts,'results':results}))
`, { request: { codexHome: home, threadIds: candidates.map(row => row.threadId), priorityThreadIds }, candidates });
  assert.deepEqual(value.attempts, [0, 4, 1, 5, 2, 6, 3, 7].map(hotId));
  assert.ok(value.results.every(result => result.available && result.checkedCandidates === 1));
  assert.ok(value.results.every(result => result.states.every(row => row.status === 'unknown')));
});

test('rotation reaches hot candidates beyond the quota and keeps native probes interleaved', async () => {
  const candidates = Array.from({ length: 64 }, (_, index) => ({ threadId: hotId(index), path: '/fixture' }));
  const priorityThreadIds = candidates.slice(32).map(row => row.threadId);
  const value = await python(`
allowed={row['threadId'] for row in data['candidates']}
results=[]
for rotation in [0,1,2,32]:
    selected=m.select_candidates(data['candidates'],allowed,data['priorityThreadIds'],rotation)
    pending=[(candidate,{}) for candidate in selected]
    results.append({'selected':[row['threadId'] for row in selected],
                    'probes':[row[0]['threadId'] for row in m.probe_order(pending,data['priorityThreadIds'],rotation)]})
print(json.dumps(results))
`, { candidates, priorityThreadIds });
  assert.equal(value[0].selected.length, 32);
  assert.deepEqual(value[0].probes.slice(0, 6), [32, 0, 33, 1, 34, 2].map(hotId));
  assert.deepEqual(value[1].probes.slice(0, 6), [0, 32, 1, 33, 2, 34].map(hotId));
  assert.deepEqual(value[2].probes.slice(0, 2), [33, 1].map(hotId));
  assert.deepEqual(value[3].selected, [...Array.from({ length: 16 }, (_, i) => hotId(48 + i)),
    ...Array.from({ length: 16 }, (_, i) => hotId(16 + i))]);
});

test('an all-hot 32-owner set retains every running state on successive collections', async t => {
  const home = fixtureHome(t), candidates = Array.from({ length: 32 }, (_, i) => rollout(home, hotId(i)));
  const priorityThreadIds = candidates.map(row => row.threadId);
  const calls = await desktop(t, home, Object.fromEntries(priorityThreadIds.map(id => [id, state(id)])));
  for (const rotation of [0, 1]) {
    const result = await observe(home, candidates, { priorityThreadIds, rotation });
    assert.equal(result.scannedCandidates, 32);
    assert.equal(result.checkedCandidates, 32);
    assert.deepEqual(result.states.map(row => row.threadId).sort(), [...priorityThreadIds].sort());
    assert.ok(result.states.every(row => row.status === 'running'));
  }
  assert.ok(calls.filter(call => call.type === 'request').every(call => ['initialize', 'thread-owner-discovery'].includes(call.method)));
  assert.equal(calls.filter(call => call.method === 'thread-stream-following-changed' && call.params.following === false).length, 64);
});

test('hot owners fill unused ordinary slots while mixed batches preserve ordinary coverage', async () => {
  const candidates = Array.from({ length: 64 }, (_, index) => ({ threadId: hotId(index), path: '/fixture' }));
  const priorityThreadIds = candidates.slice(0, 32).map(row => row.threadId);
  const value = await python(`
results=[]
for ordinary_count in [0,1,5,15,16,32]:
    candidates=data['candidates'][:32+ordinary_count]
    selected=m.select_candidates(candidates,{row['threadId'] for row in candidates},data['priorityThreadIds'],0)
    results.append([row['threadId'] for row in selected])
print(json.dumps(results))
`, { candidates, priorityThreadIds });
  for (const [index, ordinaryCount] of [0, 1, 5, 15, 16, 32].entries()) {
    const reserved = Math.min(ordinaryCount, 16);
    assert.deepEqual(value[index], [
      ...candidates.slice(0, 32 - reserved).map(row => row.threadId),
      ...candidates.slice(32, 32 + reserved).map(row => row.threadId),
    ]);
  }
});

test('invalid internal priority and rotation inputs fail before owner discovery', async t => {
  const home = fixtureHome(t);
  const results = await python(`
def unexpected(*args): raise AssertionError('discovery must not run')
results=[m.execute({**data['base'],**invalid},verify=lambda: {},discover=unexpected) for invalid in data['invalid']]
print(json.dumps(results))
`, { base: { codexHome: home, threadIds: [hotId(1)] }, invalid: [
    { priorityThreadIds: 'invalid' }, { priorityThreadIds: ['not-uuid'] },
    { priorityThreadIds: Array.from({ length: 33 }, (_, i) => hotId(i)) },
    { rotation: true }, { rotation: -1 }, { rotation: 2147483648 }, { rotation: 1.5 },
  ] });
  assert.ok(results.every(result => !result.available && result.scannedCandidates === 0 && result.checkedCandidates === 0));
});

test('unsupported app identity fails before process discovery or owner access', async t => {
  const home = fixtureHome(t);
  const result = await python(`
def invalid_version(): raise ValueError('unsupported_app_identity')
def unexpected_discovery(*args): raise AssertionError('discovery must not run')
print(json.dumps(m.execute(data,verify=invalid_version,discover=unexpected_discovery)))
`, { codexHome: home, threadIds: ['one'], excludedThreadIds: [] });
  assert.deepEqual(Object.keys(result).sort(), ['available', 'checkedAt', 'checkedCandidates', 'scannedCandidates', 'states']);
  assert.equal(result.available, false);
  assert.deepEqual(result.states, []);
});
