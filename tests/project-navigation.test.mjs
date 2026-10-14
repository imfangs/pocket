import test from 'node:test';
import assert from 'node:assert/strict';
import { projectNavigationItems, UNASSIGNED_PROJECT } from '../src/projectNavigation.ts';

const project = (id, name, order, paths = []) => ({ id, name, order, paths, separator: false });

test('project navigation follows native order, preserves ties and empty projects, and removes separators and duplicate IDs', () => {
  const projects = [
    project('second', 'Second', 2),
    project('first', 'First', 0),
    project('tie', 'Empty project', 0),
    { ...project('separator', '———', 1), separator: true },
    project('second', 'A stale duplicate', -1),
  ];
  const before = structuredClone(projects);
  assert.deepEqual(projectNavigationItems(projects).map(item => item.id), ['first', 'tie', 'second']);
  assert.deepEqual(projects, before);
});

test('same names and shared directories never merge native project identities', () => {
  const items = projectNavigationItems([
    project('one', 'Shared', 0, ['/workspace/one']),
    project('two', 'Shared', 1, ['/workspace/two']),
    project('three', 'Different', 2, ['/workspace/two']),
  ]);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map(item => item.name), ['Shared', 'Shared', 'Different']);
  assert.equal(items[0].ariaLabel, 'Shared，/workspace/one');
  assert.equal(items[1].ariaLabel, 'Shared，/workspace/two');
  assert.equal(items[2].ariaLabel, 'Different');
  assert.match(items[2].title, /\/workspace\/two/);
});

test('identical names and paths or missing paths retain distinguishable accessible names', () => {
  for (const paths of [[], ['/workspace/shared']]) {
    const items = projectNavigationItems([project('one', 'Same', 0, paths), project('two', 'Same', 1, paths)]);
    assert.notEqual(items[0].ariaLabel, items[1].ariaLabel);
    assert.match(items[0].ariaLabel, /one/);
    assert.match(items[1].ariaLabel, /two/);
  }
});

test('unassigned entry appears only for active unassigned conversations, without their titles or counts', () => {
  const archived = { projectId: null, archived: true, separator: false };
  const separator = { projectId: null, archived: false, separator: true };
  const assigned = { projectId: 'one', archived: false, separator: false };
  assert.deepEqual(projectNavigationItems([], [archived, separator, assigned]), []);
  const items = projectNavigationItems([project('one', 'One', 0)], [
    { projectId: null, archived: false, separator: false, title: 'Private conversation' },
    { projectId: null, archived: false, separator: false },
  ]);
  assert.deepEqual(items.map(item => item.id), ['one', UNASSIGNED_PROJECT]);
  assert.deepEqual(items[1], { id: UNASSIGNED_PROJECT, name: '未归属项目', title: '未归属项目', ariaLabel: '未归属项目' });
  assert.doesNotMatch(JSON.stringify(items), /Private conversation|count/);
});

test('malformed ordering stays deterministic and blank names retain their project identity', () => {
  const items = projectNavigationItems([
    project('no-order', ' ', undefined),
    project('normal', 'Normal', 3),
    project('bad-order', 'Another', NaN),
  ]);
  assert.deepEqual(items.map(item => item.id), ['normal', 'no-order', 'bad-order']);
  assert.equal(items[1].name, 'no-order');
});
