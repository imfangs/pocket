import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readBridgeConfig } from '../server/bridge-config.mjs';

// Import only the pure projection/response adapter; this never starts Codex,
// connects to a desktop owner, or approves a real request.
const python = readBridgeConfig().python;
const adapter = fileURLToPath(new URL('../bin', import.meta.url));
const evaluate = input => {
  const result = spawnSync(python, ['-c', `import json,sys\nsys.path.insert(0,sys.argv[1])\nfrom request_actions import request_view,prepare_response\nx=json.load(sys.stdin)\ns=x['state']\nt=x.get('turns',[])\nr=request_view(s['requests'][0],s,t) if x['operation']=='view' else prepare_response(s,t,x['key'],x.get('decision'),x.get('answers'),option_id=x.get('optionId'))\nprint(json.dumps(r,ensure_ascii=False))`, adapter],
  { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const threadId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const command = extra => ({ id: 0, method: 'item/commandExecution/requestApproval', params: {
  threadId, turnId: 'turn', itemId: 'command', command: 'git status', cwd: '/fixture', ...extra,
} });
const state = request => ({ id: threadId, cwd: '/fixture', requests: [request] });
const view = (request, turns = []) => evaluate({ operation: 'view', state: state(request), turns });
const prepare = (request, shown, option, turns = [], extra = {}) => evaluate({
  operation: 'prepare', state: state(request), turns, key: shown.key, optionId: option?.id, ...extra,
});
const option = (shown, kind) => shown.approvalOptions?.find(value => value.kind === kind);
const prefix = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } };
const network = action => ({ applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test', action } } });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const legacyKey = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const opaqueId = (key, decision, kind) => legacyKey(['pocket-approval-option-v2', { conversationId: threadId, hostId: null }, key, decision, kind]);

test('command options preserve native order, exact payloads, and stable opaque identities', () => {
  const decisions = ['accept', 'acceptForSession', prefix, network('allow'), network('deny'), 'decline', 'cancel'];
  const request = command({ availableDecisions: decisions });
  const shown = view(request);
  assert.deepEqual(shown.choices, ['accept', 'cancel']);
  assert.deepEqual(shown.approvalOptions.map(value => value.kind), ['accept', 'acceptForSession', 'execpolicy', 'networkPolicy', 'networkPolicy', 'decline', 'cancel']);
  assert.deepEqual(view(request).approvalOptions, shown.approvalOptions);
  assert.equal(new Set(shown.approvalOptions.map(value => value.id)).size, decisions.length);
  for (const [index, decision] of decisions.entries()) {
    const selected = shown.approvalOptions[index];
    assert.match(selected.id, /^[a-f0-9]{64}$/);
    assert.deepEqual(prepare(request, shown, selected), ['thread-follower-command-approval-decision', { conversationId: threadId, requestId: 0, decision }]);
  }
  assert.deepEqual(option(shown, 'execpolicy').rule, ['git', 'status']);
  assert.equal(option(shown, 'execpolicy').scope, 'rule');
  assert.equal(option(shown, 'networkPolicy').host, 'example.test');
  assert.equal(option(shown, 'acceptForSession').scope, 'session');
});

test('missing optional command decisions retain native session support and only explicit proposed rules', () => {
  for (const extra of [{}, { availableDecisions: null }]) {
    const shown = view(command(extra));
    assert.deepEqual(shown.approvalOptions.map(value => value.kind), ['accept', 'acceptForSession', 'decline', 'cancel']);
    assert.equal(option(shown, 'execpolicy'), undefined);
    assert.equal(option(shown, 'networkPolicy'), undefined);
  }
  const request = command({ proposedExecpolicyAmendment: ['git'], proposedNetworkPolicyAmendments: [{ host: 'example.test', action: 'deny' }] });
  const shown = view(request);
  assert.deepEqual(option(shown, 'execpolicy').rule, ['git']);
  assert.equal(option(shown, 'networkPolicy').action, 'deny');
  assert.deepEqual(prepare(request, shown, option(shown, 'execpolicy'))[1].decision, { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git'] } });
});

test('native empty argument tokens remain exact without allowing an empty executable or command prefix', () => {
  const words = ['python3', '-c', ''], native = { acceptWithExecpolicyAmendment: { execpolicy_amendment: words } };
  for (const extra of [{ availableDecisions: [native, 'cancel'] }, { proposedExecpolicyAmendment: words }]) {
    const request = command({ command: "python3 -c ''", ...extra }), shown = view(request), selected = option(shown, 'execpolicy');
    assert.deepEqual(selected.rule, words);
    assert.deepEqual(prepare(request, shown, selected)[1].decision, native);
  }
  for (const invalid of [[], [''], ['', 'python3']]) {
    const native = { acceptWithExecpolicyAmendment: { execpolicy_amendment: invalid } };
    const request = command({ availableDecisions: [native, 'cancel'] }), shown = view(request);
    assert.equal(option(shown, 'execpolicy'), undefined);
    assert.equal(prepare(request, shown, { id: opaqueId(shown.key, native, 'execpolicy') }), null);
  }
});

test('explicit empty or malformed decision lists never become default grants', () => {
  for (const availableDecisions of [[], false, {}, 'acceptForSession']) {
    const shown = view(command({ availableDecisions, proposedExecpolicyAmendment: ['git'] }));
    assert.deepEqual(shown.approvalOptions, []);
    assert.deepEqual(shown.choices, []);
  }
  const shown = view(command({ availableDecisions: ['future', { acceptWithExecpolicyAmendment: { execpolicy_amendment: [] } }, network('future'), 'cancel'] }));
  assert.deepEqual(shown.approvalOptions.map(value => value.kind), ['cancel']);
});

test('human command checkpoints cannot offer session, command rules, or network grants', () => {
  for (const extra of [{}, { availableDecisions: ['acceptForSession', prefix, network('allow'), 'accept', 'decline', 'cancel'] }]) {
    const request = command({ ...extra, kind: 'humanCommand', proposedExecpolicyAmendment: ['git'] });
    const shown = view(request);
    assert.deepEqual(shown.approvalOptions.map(value => value.kind), ['accept', 'decline', 'cancel']);
  }
  const shown = view(command({ kind: 'futureKind' }));
  assert.equal(shown.approvalOptions.some(value => ['accept', 'acceptForSession', 'execpolicy', 'networkPolicy'].includes(value.kind)), false);
});

test('opaque choices reject arbitrary decisions, forged IDs, mixed inputs, and other requests', () => {
  const request = command({ availableDecisions: ['accept', 'acceptForSession', prefix, 'cancel'] });
  const shown = view(request), selected = option(shown, 'acceptForSession');
  assert.equal(prepare(request, shown, { id: '0'.repeat(64) }), null);
  assert.equal(prepare(request, shown, selected, [], { decision: 'acceptForSession' }), null);
  assert.equal(prepare(request, shown, selected, [], { answers: { question: 'yes' } }), null);
  assert.equal(evaluate({ operation: 'prepare', state: state(request), key: shown.key, decision: 'acceptForSession' }), null);
  assert.equal(evaluate({ operation: 'prepare', state: state(request), key: shown.key, decision: prefix }), null);
  assert.equal(prepare(command({ itemId: 'other', availableDecisions: ['acceptForSession'] }), shown, selected), null);
  assert.equal(prepare(request, shown, { id: selected.id.toUpperCase() }), null);
});

test('an explicitly different native thread cannot lend an approval to the followed owner', () => {
  const original = command({ availableDecisions: ['acceptForSession', 'cancel'] }), shown = view(original);
  const other = command({ threadId: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc', availableDecisions: ['acceptForSession', 'cancel'] });
  assert.equal(view(other), null);
  assert.equal(prepare(other, shown, option(shown, 'acceptForSession')), null);
});

test('rule, host, request metadata, and native availability changes revoke all old option IDs', () => {
  const original = command({ availableDecisions: ['accept', prefix, network('allow'), 'cancel'] });
  const shown = view(original);
  for (const changed of [
    command({ availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'push'] } }, network('allow'), 'cancel'] }),
    command({ availableDecisions: ['accept', prefix, { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'other.test', action: 'allow' } } }, 'cancel'] }),
    command({ availableDecisions: ['cancel'] }),
    command({ ...original.params, command: 'git push' }),
  ]) {
    for (const selected of shown.approvalOptions) assert.equal(prepare(changed, shown, selected), null);
  }
});

const file = extra => ({ id: 9, method: 'item/fileChange/requestApproval', params: { threadId, turnId: 'turn', itemId: 'file', ...extra } });
const fileTurns = [{ turnId: 'turn', items: [{ id: 'file', type: 'fileChange', changes: [{ path: '/fixture/file.txt', kind: 'update', diff: '-old\n+new' }] }] }];
test('reviewed file changes support session approval and retain the exact original patch identity', () => {
  const request = file(), shown = view(request, fileTurns);
  assert.deepEqual(shown.approvalOptions.map(value => value.kind), ['accept', 'acceptForSession', 'decline', 'cancel']);
  assert.ok(shown.details.includes('+new'));
  assert.deepEqual(prepare(request, shown, option(shown, 'acceptForSession'), fileTurns), ['thread-follower-file-approval-decision', { conversationId: threadId, requestId: 9, decision: 'acceptForSession' }]);
  const changed = [{ turnId: 'turn', items: [{ id: 'file', type: 'fileChange', changes: [{ path: '/fixture/file.txt', diff: '+different' }] }] }];
  assert.equal(prepare(request, shown, option(shown, 'acceptForSession'), changed), null);
});

test('file grantRoot is fully reviewable and never mislabeled as an ordinary one-time grant', () => {
  const request = file({ grantRoot: '/fixture/project' }), shown = view(request, fileTurns);
  assert.deepEqual(shown.choices, ['cancel']);
  assert.ok(shown.details.includes('/fixture/project'));
  for (const selected of shown.approvalOptions.filter(value => ['accept', 'acceptForSession'].includes(value.kind))) {
    assert.equal(selected.scope, 'session');
    assert.equal(selected.grantRoot, '/fixture/project');
    assert.equal(prepare(request, shown, selected, fileTurns)[0], 'thread-follower-file-approval-decision');
  }
  assert.ok(option(shown, 'acceptForSession'));
});

test('missing or oversized file changes never expose a grant hidden from the review surface', () => {
  const request = file();
  assert.deepEqual(view(request).approvalOptions.map(value => value.kind), ['decline', 'cancel']);
  const enormous = [{ turnId: 'turn', items: [{ id: 'file', type: 'fileChange', changes: [{ path: '/fixture/file.txt', diff: '+'.repeat(70000) }] }] }];
  const shown = view(request, enormous);
  assert.ok(shown.details.includes('Mac'));
  assert.equal(shown.approvalOptions.some(value => ['accept', 'acceptForSession'].includes(value.kind)), false);
  assert.equal(prepare(request, shown, { id: '1'.repeat(64) }, enormous), null);
});

test('optional malformed file items preserve the missing-change key and native refusals without breaking projection', () => {
  const request = file(), reviewed = view(request, fileTurns);
  const cases = [null, [null], [{ turnId: 'turn', items: null }], [{ turnId: 'turn', items: [null] }],
    [{ turnId: 'turn', items: {} }], [{ turnId: 'turn', items: 'unloaded' }], [{ turnId: 'other', items: null }]];
  for (const turns of cases) {
    const shown = view(request, turns);
    assert.equal(shown.key, legacyKey({ request, changes: null }));
    assert.deepEqual(shown.choices, ['cancel']);
    assert.deepEqual(shown.approvalOptions.map(value => value.kind), ['decline', 'cancel']);
    assert.ok(shown.details.includes('Mac'));
    assert.equal(prepare(request, reviewed, option(reviewed, 'acceptForSession'), turns), null);
    assert.equal(evaluate({ operation: 'prepare', state: state(request), turns, key: shown.key, decision: 'accept' }), null);
    assert.equal(prepare(request, shown, option(shown, 'cancel'), turns)[1].decision, 'cancel');
  }
  const mixed = [{ turnId: 'turn', items: [null, { type: 'futureItem' }, ...fileTurns[0].items] }];
  assert.equal(view(request, mixed).key, reviewed.key);
  assert.deepEqual(prepare(request, reviewed, option(view(request, mixed), 'acceptForSession'), mixed)[1].decision, 'acceptForSession');
});

const permissions = profile => ({ id: 'permissions', method: 'item/permissions/requestApproval', params: { threadId, turnId: 'turn', itemId: 'permission', cwd: '/fixture', permissions: profile } });
test('permission scopes grant only the exact reviewed native profile; denial grants nothing', () => {
  const profile = { network: { enabled: true }, fileSystem: { read: ['/fixture'], write: ['/fixture/output'], entries: [{ access: 'read', path: { type: 'path', path: '/fixture/a.txt' } }, { access: 'write', path: { type: 'glob_pattern', pattern: '/fixture/output/*.txt' } }], globScanMaxDepth: 2 } };
  const request = permissions(profile), shown = view(request);
  assert.deepEqual(shown.approvalOptions.map(value => value.kind), ['permissionTurn', 'permissionSession', 'cancel']);
  assert.deepEqual(prepare(request, shown, option(shown, 'permissionTurn'))[1].response, { permissions: profile, scope: 'turn' });
  assert.deepEqual(prepare(request, shown, option(shown, 'permissionSession'))[1].response, { permissions: profile, scope: 'session' });
  assert.deepEqual(prepare(request, shown, option(shown, 'cancel'))[1].response, { permissions: {}, scope: 'turn' });
  const changed = permissions({ ...profile, fileSystem: { write: ['/other'] } });
  assert.equal(prepare(changed, shown, option(shown, 'permissionSession')), null);
});

test('malformed or unknown permission fields cannot manufacture a grant', () => {
  for (const profile of [null, false, [], { shell: true }, { network: true }, { network: { enabled: 'true' } }, { network: { enabled: true, allHosts: true } },
    { fileSystem: { read: [7] } }, { fileSystem: { write: ['/fixture\u0000'] } }, { fileSystem: { globScanMaxDepth: true } },
    { fileSystem: { entries: [{ access: 'future', path: { type: 'path', path: '/fixture' } }] } },
    { fileSystem: { entries: [{ access: 'write', path: { type: 'future', path: '/fixture' } }] } },
    { fileSystem: { entries: [{ access: 'write', path: { type: 'special', value: { kind: 'unknown', path: '/fixture' } } }] } },
  ]) {
    const shown = view(permissions(profile));
    assert.deepEqual(shown.choices, ['cancel']);
    assert.deepEqual(shown.approvalOptions.map(value => value.kind), ['cancel']);
  }
});

test('bounded approval projections preserve only native refusals when any grant details overflow', () => {
  const request = command({ command: 'x'.repeat(70000), availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] });
  const shown = view(request);
  assert.ok(JSON.stringify(shown).length < 60000);
  assert.deepEqual(shown.approvalOptions.map(value => value.kind), ['decline', 'cancel']);
  assert.deepEqual(shown.choices, ['cancel']);
  assert.equal(prepare(request, shown, option(shown, 'cancel'))[1].decision, 'cancel');
  const onlyGrant = view(command({ command: 'x'.repeat(70000), availableDecisions: ['accept'] }));
  assert.deepEqual(onlyGrant.choices, []);
  assert.deepEqual(onlyGrant.approvalOptions, []);
});

test('empty native permission profiles keep presentation choices uniquely identified', () => {
  const request = permissions({}), shown = view(request);
  assert.equal(new Set(shown.approvalOptions.map(value => value.id)).size, shown.approvalOptions.length);
  assert.notEqual(option(shown, 'permissionTurn').id, option(shown, 'cancel').id);
  assert.deepEqual(prepare(request, shown, option(shown, 'cancel'))[1].response, { permissions: {}, scope: 'turn' });
});

test('known nullable permission overlays and special paths remain exact; malformed root scope gives no grant', () => {
  const profile = { network: { enabled: null }, fileSystem: { read: null, write: [], entries: [
    { access: 'write', path: { type: 'special', value: { kind: 'project_roots', subpath: 'output' } } },
    { access: 'read', path: { type: 'special', value: { kind: 'tmpdir' } } },
  ] } };
  const request = permissions(profile), shown = view(request);
  assert.deepEqual(prepare(request, shown, option(shown, 'permissionSession'))[1].response, { permissions: profile, scope: 'session' });
  for (const grantRoot of [false, 3, '', '/fixture\u0000hidden']) {
    const invalid = view(file({ grantRoot }), fileTurns);
    assert.deepEqual(invalid.choices, ['cancel']);
    assert.deepEqual(invalid.approvalOptions.map(value => value.kind), ['decline', 'cancel']);
  }
});

test('legacy missing-thread request keys stay stable while every approval option binds the followed conversation', () => {
  const otherThread = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
  for (const family of ['command', 'file', 'permissions']) {
    for (const nativeThread of ['missing', null]) {
      const request = family === 'command' ? command({ availableDecisions: ['acceptForSession', 'cancel'] })
        : family === 'file' ? file() : permissions({ network: { enabled: true } });
      if (nativeThread === 'missing') delete request.params.threadId;
      else request.params.threadId = nativeThread;
      const turns = family === 'file' ? fileTurns : [];
      const a = state(request), b = { ...a, id: otherThread };
      const shownA = evaluate({ operation: 'view', state: a, turns });
      const shownB = evaluate({ operation: 'view', state: b, turns });
      const oldKey = legacyKey(family === 'file' ? { request, changes: fileTurns[0].items[0].changes } : request);
      assert.equal(shownA.key, oldKey, 'Upgrade must retain existing accepted/unknown ledger associations');
      assert.equal(shownB.key, oldKey);
      assert.deepEqual(shownA.approvalOptions.map(value => value.kind), shownB.approvalOptions.map(value => value.kind));
      assert.equal(shownB.approvalOptions.some(value => shownA.approvalOptions.some(original => original.id === value.id)), false);
      for (const selected of shownA.approvalOptions) {
        assert.equal(evaluate({ operation: 'prepare', state: b, turns, key: shownA.key, optionId: selected.id }), null);
      }
      const own = shownB.approvalOptions[0];
      assert.equal(evaluate({ operation: 'prepare', state: b, turns, key: shownB.key, optionId: own.id })[1].conversationId, otherThread);
    }
  }
});

test('ambiguous control, separator, and bidi text cannot hide a grant offered by the backend', () => {
  const ambiguous = ['\u0001', '\u000b', '\u007f', '\u0085', '\u009f', '\u061c', '\u200e', '\u200f', '\u2028', '\u2029', '\u202a', '\u202e', '\u2066', '\u2069', '\u206f'];
  for (const character of ambiguous) {
    const rule = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', `sta${character}tus`] } };
    const host = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: `example${character}.test`, action: 'allow' } } };
    for (const [request, turns, native, kind] of [
      [command({ availableDecisions: ['accept', rule, 'decline', 'cancel'] }), [], rule, 'execpolicy'],
      [command({ availableDecisions: ['accept', host, 'decline', 'cancel'] }), [], host, 'networkPolicy'],
      [file({ grantRoot: `/fixture/${character}project` }), fileTurns, 'acceptForSession', 'acceptForSession'],
    ]) {
      const shown = view(request, turns);
      assert.equal(shown.approvalOptions.some(value => !['decline', 'cancel'].includes(value.kind)), false);
      assert.equal(shown.choices.includes('accept'), false);
      assert.equal(prepare(request, shown, { id: opaqueId(shown.key, native, kind) }, turns), null);
      assert.equal(evaluate({ operation: 'prepare', state: state(request), turns, key: shown.key, decision: 'accept' }), null);
    }
  }
});

test('ambiguous reason command cwd and permission detail text uniformly remove grants; normal multiline code stays exact', () => {
  for (const field of ['reason', 'command', 'cwd']) {
    const request = command({ [field]: `before\u202eafter`, availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] });
    const shown = view(request);
    assert.deepEqual(shown.approvalOptions.map(value => value.kind), ['decline', 'cancel']);
    assert.equal(prepare(request, shown, { id: opaqueId(shown.key, 'accept', 'accept') }), null);
    assert.equal(shown[field].includes('\u202e'), false);
  }
  const requested = permissions({ fileSystem: { read: ['/fixture/\u202epath'] } });
  assert.deepEqual(view(requested).approvalOptions.map(value => value.kind), ['cancel']);
  const diff = [{ turnId: 'turn', items: [{ id: 'file', type: 'fileChange', changes: [{ path: '/fixture/file.txt', diff: '+before\u202eafter' }] }] }];
  assert.deepEqual(view(file(), diff).approvalOptions.map(value => value.kind), ['decline', 'cancel']);
  const text = 'python3 - <<\'PY\'\n\tprint("你好 👋")\nPY';
  const normal = command({ command: text, reason: '多行代码', availableDecisions: ['accept', 'acceptForSession', 'cancel'] }), shown = view(normal);
  assert.equal(shown.key, legacyKey(normal));
  assert.equal(shown.command, text);
  assert.equal(prepare(normal, shown, option(shown, 'acceptForSession'))[1].decision, 'acceptForSession');
});

test('lone surrogates use deterministic tagged fallback keys and readable refusals without migrating valid UTF8 keys', () => {
  for (const bad of ['\ud800', '\udfff']) {
    for (const field of ['reason', 'command', 'cwd']) {
      const request = command({ [field]: `before${bad}after`, availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] });
      const shown = view(request);
      assert.match(shown.key, /^[a-f0-9]{64}$/);
      assert.equal(view(request).key, shown.key);
      assert.equal(/[\ud800-\udfff]/.test(JSON.stringify(shown)), false);
      assert.equal(shown[field].includes(bad), false);
      assert.deepEqual(shown.approvalOptions.map(value => value.kind), ['decline', 'cancel']);
      assert.equal(evaluate({ operation: 'prepare', state: state(request), key: shown.key, decision: 'accept' }), null);
      assert.equal(prepare(request, shown, option(shown, 'cancel'))[1].decision, 'cancel');
    }
  }
  const normal = command({ command: 'printf "你好😀"', reason: '可读 UTF8', cwd: '/fixture/中文' });
  assert.equal(view(normal).key, legacyKey(normal));
  const bad = command({ reason: 'before\ud800after' });
  assert.notEqual(view(bad).key, legacyKey(bad), 'Only malformed Unicode enters the tagged fallback key space');
});

test('question answers remain their own native path and reject approval option IDs', () => {
  const request = { id: 'question', method: 'item/tool/requestUserInput', params: { threadId, turnId: 'turn', questions: [{ id: 'answer', question: 'Choose?', options: null }] } };
  const shown = view(request);
  assert.deepEqual(shown.approvalOptions ?? [], []);
  assert.equal(evaluate({ operation: 'prepare', state: state(request), key: shown.key, optionId: '2'.repeat(64), answers: { answer: 'yes' } }), null);
  assert.equal(evaluate({ operation: 'prepare', state: state(request), key: shown.key, answers: { answer: 'yes' } })[0], 'thread-follower-submit-user-input');
});
