import test from 'node:test';
import assert from 'node:assert/strict';
import { creationDirectories, creationDirectoryChoices, initialCreationDirectory, creationLocation, creationProjectChoices } from '../src/creationLocations.ts';

const locations = [
  { id: 'native-one', cwd: '/workspace/shared', label: 'Shared', projectId: 'project-one', projectName: 'Shared' },
  { id: 'native-two', cwd: '/workspace/shared', label: 'Shared', projectId: 'project-two', projectName: 'Shared' },
  { id: 'unassigned', cwd: '/workspace/shared', label: '/workspace/shared', projectId: null, projectName: null },
  { id: 'same-label-other-directory', cwd: '/other/shared', label: 'Shared', projectId: 'project-other', projectName: 'Shared' },
  { id: 'single', cwd: '/workspace/solo', label: 'Solo', projectId: 'project-solo', projectName: 'Solo' },
];

test('directories are unique by their full canonical cwd, retaining all original location combinations', () => {
  const directories = creationDirectories(locations);
  assert.deepEqual(directories.map(directory => directory.cwd), ['/workspace/shared', '/other/shared', '/workspace/solo']);
  assert.deepEqual(directories[0].locations.map(location => location.id), ['native-one', 'native-two', 'unassigned']);
  assert.equal(directories[1].locations[0], locations[3]);
});

test('directory labels start with the basename and add enough parent path to distinguish namesakes', () => {
  const choices = creationDirectoryChoices(creationDirectories(locations));
  assert.deepEqual(choices.map(choice => choice.label), ['shared · workspace', 'shared · other', 'solo']);
  assert.deepEqual(choices.map(choice => choice.directory.cwd), ['/workspace/shared', '/other/shared', '/workspace/solo']);
  const nested = creationDirectoryChoices(creationDirectories([
    { id: 'a', cwd: '/Users/a/workspace/shared', label: 'Same' },
    { id: 'b', cwd: '/Users/b/workspace/shared', label: 'Same' },
  ]));
  assert.deepEqual(nested.map(choice => choice.label), ['shared · a/workspace', 'shared · b/workspace']);
});

test('directory label collisions with punctuation in a real basename retain distinct full-path fallbacks', () => {
  const choices = creationDirectoryChoices(creationDirectories([
    { id: 'a', cwd: '/one/shared', label: 'Same' },
    { id: 'b', cwd: '/two/shared', label: 'Same' },
    { id: 'c', cwd: '/arbitrary/shared · one', label: 'Other' },
  ]));
  assert.equal(new Set(choices.map(choice => choice.label)).size, 3);
  assert.equal(choices[0].label, 'shared · /one/shared');
  assert.equal(choices[2].label, 'shared · one · /arbitrary/shared · one');
});

test('a preferred shared directory never silently chooses its first project', () => {
  const directories = creationDirectories(locations);
  const cwd = initialCreationDirectory(directories, '/workspace/shared');
  assert.equal(cwd, '/workspace/shared');
  assert.equal(creationLocation(directories, cwd, ''), null);
  assert.equal(creationLocation(directories, cwd, 'native-two'), locations[1]);
});

test('a single directory is preselected, but only a single combination may be automatic', () => {
  const shared = creationDirectories(locations.slice(0, 3));
  assert.equal(initialCreationDirectory(shared), '/workspace/shared');
  assert.equal(creationLocation(shared, '/workspace/shared', ''), null);
  const single = creationDirectories([locations[4]]);
  assert.equal(initialCreationDirectory(single), '/workspace/solo');
  assert.equal(creationLocation(single, '/workspace/solo', ''), locations[4]);
});

test('same-named project choices are distinguishable and the unassigned combination is explicit', () => {
  const [directory] = creationDirectories(locations);
  const choices = creationProjectChoices(directory);
  assert.equal(new Set(choices.map(choice => choice.label)).size, 3);
  assert.match(choices[0].label, /Shared/);
  assert.match(choices[0].label, /project-one/);
  assert.match(choices[1].label, /project-two/);
  assert.equal(choices[2].label, '不归入项目');
  assert.deepEqual(choices.map(choice => choice.location.id), ['native-one', 'native-two', 'unassigned']);
});

test('changing directories cannot submit a location from the previous directory', () => {
  const directories = creationDirectories(locations);
  assert.equal(creationLocation(directories, '/workspace/shared', 'same-label-other-directory'), null);
  assert.equal(creationLocation(directories, '/missing', 'native-one'), null);
  assert.equal(initialCreationDirectory(directories, '/missing'), '');
});

test('selection labels use projectName then label while duplicate API rows do not manufacture ambiguity', () => {
  const input = [{ id: 'one', cwd: '/one', label: 'Original project label', projectId: 'project' }];
  const [directory] = creationDirectories([...input, ...input]);
  assert.equal(directory.locations.length, 1);
  assert.equal(creationProjectChoices(directory)[0].label, 'Original project label');
  assert.equal(creationLocation([directory], '/one', ''), input[0]);
});
