import test from 'node:test';
import assert from 'node:assert/strict';
import { readCreationConfirmations, saveCreationConfirmations } from '../src/creationConfirmations.ts';

const id = 'a9100000-0000-4000-8000-000000000001';
function fixture() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}
test('restoring confirmation uses the original timestamp and stores no query content', () => {
  const storage = fixture(), at = Date.now() - 240000;
  saveCreationConfirmations(new Map([[id, at]]), storage);
  const restored = readCreationConfirmations(storage);
  assert.equal(restored.get(id), at);
  assert.equal(restored.get(id) + 300000, at + 300000);
  assert.deepEqual(JSON.parse([...storage.data.values()][0]), [[id, at]]);
});
test('invalid values cannot create an unbounded green cue', () => {
  const storage = fixture();
  saveCreationConfirmations(new Map([[id, Date.now() + 3600000], ['invalid', Date.now()]]), storage);
  assert.equal(readCreationConfirmations(storage).size, 0);
  storage.setItem([...storage.data.keys()][0], 'broken');
  assert.equal(readCreationConfirmations(storage).size, 0);
});
test('confirmation records are bounded and unavailable storage does not block creation', () => {
  const storage = fixture();
  const entries = Array.from({ length: 120 }, (_, index) => [`a9100000-0000-4000-8000-${String(index).padStart(12, '0')}`, Date.now() - 120 + index]);
  saveCreationConfirmations(new Map(entries), storage);
  assert.equal(readCreationConfirmations(storage).size, 100);
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  assert.equal(readCreationConfirmations(blocked).size, 0);
  assert.doesNotThrow(() => saveCreationConfirmations(new Map([[id, Date.now()]]), blocked));
});
