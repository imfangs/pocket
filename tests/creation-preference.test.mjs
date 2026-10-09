import test from 'node:test';
import assert from 'node:assert/strict';
import { creationDirectories, creationLocation } from '../src/creationLocations.ts';
import { initialCreationSelection, readCreationPreference, saveCreationPreference } from '../src/creationPreference.ts';

const locations = [
  { id: 'shared-a', cwd: '/workspace/shared', projectId: 'a', label: 'A' },
  { id: 'shared-b', cwd: '/workspace/shared', projectId: 'b', label: 'B' },
  { id: 'other', cwd: '/workspace/other', label: 'Other' },
];
const directories = creationDirectories(locations);

test('the last chosen directory and explicit shared-project choice survive reopening and take priority over current context', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  saveCreationPreference({ cwd: '/workspace/shared', locationId: 'shared-b' }, storage);
  const selection = initialCreationSelection(directories, readCreationPreference(storage), '/workspace/other');
  assert.deepEqual(selection, { cwd: '/workspace/shared', locationId: 'shared-b' });
  assert.equal(creationLocation(directories, selection.cwd, selection.locationId), locations[1]);
});

test('a removed remembered directory asks for a fresh choice instead of silently using another context', () => {
  const selection = initialCreationSelection(directories, { cwd: '/deleted', locationId: 'shared-b' }, '/workspace/other');
  assert.deepEqual(selection, { cwd: '', locationId: '', unavailable: true });
  assert.equal(creationLocation(directories, selection.cwd, selection.locationId), null);
});

test('a changed project or an ID from another directory requires explicit selection for a shared directory', () => {
  for (const locationId of ['deleted-project', 'other']) {
    const selection = initialCreationSelection(directories, { cwd: '/workspace/shared', locationId });
    assert.equal(selection.cwd, '');
    assert.equal(selection.locationId, '');
    assert.equal(creationLocation(directories, selection.cwd, selection.locationId), null);
  }
  const soleRemaining = creationDirectories([locations[0]]);
  assert.equal(initialCreationSelection(soleRemaining, { cwd: '/workspace/shared', locationId: 'shared-b' }).cwd, '');
  assert.deepEqual(initialCreationSelection(directories, { cwd: '/workspace/shared', locationId: '' }), { cwd: '/workspace/shared', locationId: '' });
});

test('choosing another directory replaces the previous project choice while an empty placeholder does not erase the last choice', () => {
  let stored = null;
  const storage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  saveCreationPreference({ cwd: '/workspace/shared', locationId: 'shared-b' }, storage);
  saveCreationPreference({ cwd: '/workspace/other', locationId: 'other' }, storage);
  saveCreationPreference({ cwd: '', locationId: '' }, storage);
  assert.deepEqual(readCreationPreference(storage), { cwd: '/workspace/other', locationId: 'other' });
});

test('corrupt or inaccessible browser storage leaves creation usable without a remembered choice', () => {
  for (const text of ['{', 'null', '[]', '"path"', '{"cwd":"relative","locationId":"x"}', '{"cwd":"/path"}', '{"cwd":"/path","locationId":3}'])
    assert.equal(readCreationPreference({ getItem: () => text }), null);
  const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(readCreationPreference(storage), null);
  assert.doesNotThrow(() => saveCreationPreference({ cwd: '/workspace/other', locationId: 'other' }, storage));
  assert.equal(initialCreationSelection(directories, null, '/workspace/other').cwd, '/workspace/other');
});
