import test from 'node:test';
import assert from 'node:assert/strict';
import { hasNativeApprovalOptions, nativeApprovalOptions, nativeApprovalView, approvalRuleText, ambiguousApprovalScope } from '../src/nativeApprovalOptions.ts';

const id = value => value.repeat(64), request = { kind: 'command', choices: ['accept', 'cancel'] };
test('native list presence is independent of valid entries and never authorizes fallback legacy grants', () => {
  assert.equal(hasNativeApprovalOptions(request), false);
  for (const approvalOptions of [undefined, null, [], {}, [{ id: id('a'), kind: 'unknown', scope: 'once' }]])
    assert.equal(hasNativeApprovalOptions({ ...request, approvalOptions }), true);
});
test('grant ranges are exact, fully reviewable and opaque IDs do not carry native decision payloads', () => {
  const values = [
    { id: id('a'), kind: 'accept', scope: 'once' },
    { id: id('b'), kind: 'acceptForSession', scope: 'session' },
    { id: id('c'), kind: 'execpolicy', scope: 'rule', rule: ['git', 'diff', 'a b'] },
    { id: id('d'), kind: 'networkPolicy', scope: 'rule', host: 'example.test', action: 'allow' },
  ];
  assert.deepEqual(nativeApprovalOptions({ ...request, approvalOptions: values }), values);
  assert.equal(approvalRuleText(['git', 'diff', 'a b', '', 'line\nbreak']), 'git diff "a b" "" "line\\nbreak"');
  assert.equal(nativeApprovalView(request, values[0]).primary, true);
  assert.equal(nativeApprovalView(request, values[1]).primary, false);
});
test('malformed or unknown grant fields are rejected instead of being silently omitted from review', () => {
  const invalid = [
    { id: 'bad', kind: 'accept', scope: 'once' },
    { id: id('a'), kind: 'accept', scope: 'session' },
    { id: id('a'), kind: 'acceptForSession', scope: 'once' },
    { id: id('a'), kind: 'execpolicy', scope: 'rule', rule: [] },
    { id: id('a'), kind: 'execpolicy', scope: 'rule', rule: [{}] },
    { id: id('a'), kind: 'accept', scope: 'once', permissions: 'full' },
    { id: id('a'), kind: 'networkPolicy', scope: 'rule', host: 'example.test', action: { toString: false } },
    { id: id('a'), kind: 'networkPolicy', scope: 'rule', host: 'example.test', action: 'all' },
    { id: id('a'), kind: 'networkPolicy', scope: 'rule', host: 'example.test\nother', action: 'allow' },
  ];
  for (const option of invalid) assert.deepEqual(nativeApprovalOptions({ ...request, approvalOptions: [option] }), []);
  assert.deepEqual(nativeApprovalOptions({ ...request, approvalOptions: [
    { id: id('a'), kind: 'accept', scope: 'once' }, { id: id('a'), kind: 'acceptForSession', scope: 'session' },
  ] }), [], 'Ambiguous duplicate identities are not selectable');
});
test('directory scope overrides one-time presentation and permission grants stay tied to their request kind', () => {
  const file = { ...request, kind: 'file', approvalOptions: [{ id: id('a'), kind: 'accept', scope: 'session', grantRoot: '/synthetic/path' }] };
  const [option] = nativeApprovalOptions(file);
  const display = nativeApprovalView(file, option);
  assert.equal(display.label, '允许目录授权'); assert.equal(display.scope, '本会话'); assert.equal(display.primary, false);
  const continued = nativeApprovalOptions({ ...file, approvalOptions: [{ id: id('b'), kind: 'acceptForSession', scope: 'session', grantRoot: '/synthetic/path' }] });
  assert.equal(continued[0].grantRoot, '/synthetic/path');
  assert.equal(nativeApprovalView(file, continued[0]).value, '/synthetic/path');
  assert.deepEqual(nativeApprovalOptions({ ...request, approvalOptions: [{ id: id('a'), kind: 'permissionSession', scope: 'session' }] }), []);
});

test('cached grant descriptors reject invisible direction/control characters and lone surrogates without rejecting Chinese or emoji', () => {
  const hidden = ['\x00', '\t', '\n', '\x1f', '\x7f', '\x85', '\x9f', '\u061c', '\u200e', '\u200f',
    '\u2028', '\u2029', '\u202a', '\u202e', '\u2066', '\u2069', '\u206a', '\u206f', '\ud800', '\udfff'];
  for (const control of hidden) {
    assert.equal(ambiguousApprovalScope(`a${control}b`), true, JSON.stringify(control));
    assert.deepEqual(nativeApprovalOptions({ ...request, approvalOptions: [{ id: id('a'), kind: 'execpolicy', scope: 'rule', rule: ['git', `a${control}b`] }] }), []);
    assert.deepEqual(nativeApprovalOptions({ ...request, approvalOptions: [{ id: id('a'), kind: 'networkPolicy', scope: 'rule', host: `a${control}b.test`, action: 'allow' }] }), []);
    assert.deepEqual(nativeApprovalOptions({ ...request, kind: 'file', approvalOptions: [{ id: id('a'), kind: 'accept', scope: 'session', grantRoot: `/a${control}b` }] }), []);
  }
  for (const word of ['中文目录', '📁 folder', 'a b', '', '🙂']) assert.equal(ambiguousApprovalScope(word), false);
  assert.equal(nativeApprovalOptions({ ...request, approvalOptions: [{ id: id('a'), kind: 'execpolicy', scope: 'rule', rule: ['git', '中文目录', '📁 folder', ''] }] }).length, 1);
});
