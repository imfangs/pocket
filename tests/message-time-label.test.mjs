import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageClock, messageTime, validMessageTimestamp } from '../src/messageTime.ts';

const minute = 60_000, hour = minute * 60, day = hour * 24;
const now = new Date(2026, 9, 15, 12, 30, 45).getTime();

test('message age uses minute, hour and day boundaries, switching to a date after one week', () => {
  for (const [age, label] of [[0, '刚刚'], [minute - 1, '刚刚'], [minute, '1分钟前'],
    [59 * minute + 59_999, '59分钟前'], [hour, '1小时前'], [day - 1, '23小时前'],
    [day, '1天前'], [7 * day - 1, '6天前']]) {
    const timestamp = now - age, formatted = messageTime(timestamp, now);
    assert.equal(formatted.label, label);
    assert.equal(formatted.dateTime, new Date(timestamp).toISOString());
    assert.match(formatted.absolute, /2026/);
  }
  const week = messageTime(now - 7 * day, now);
  assert.doesNotMatch(week.label, /前|刚刚|2026/);
  assert.match(week.label, /10.*8.*12:30/);
  const older = messageTime(new Date(2025, 11, 31, 23, 59).getTime(), now);
  assert.match(older.label, /2025.*12.*31.*23:59/);
});

test('a recent cross-year message remains relative and future messages keep their actual dates', () => {
  const newYear = new Date(2026, 0, 1, 12).getTime();
  assert.equal(messageTime(newYear - day, newYear).label, '1天前');
  const future = messageTime(now + minute, now);
  assert.doesNotMatch(future.label, /刚刚|前/);
  assert.match(future.label, /10.*15.*12:31/);
  assert.equal(future.dateTime, new Date(now + minute).toISOString());
  assert.match(messageTime(now, Number.NaN).label, /2026/);
});

test('invalid or absent timestamps are not replaced by the current time', () => {
  for (const timestamp of [undefined, null, 0, Number.NaN, Infinity, -Infinity, 9e15, '', '2026-10-15', true]) {
    assert.equal(validMessageTimestamp(timestamp), false);
    assert.equal(messageTime(timestamp, now), null);
  }
  assert.equal(validMessageTimestamp(-1), true, 'keep existing valid pre-epoch timestamp handling');
});

function clockFixture(hidden = false) {
  let value = now, nextId = 1;
  const timers = new Map(), handlers = new Set();
  const document = {
    hidden,
    addEventListener(type, listener) { assert.equal(type, 'visibilitychange'); handlers.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, 'visibilitychange'); handlers.delete(listener); },
  };
  const clock = createMessageClock({ now: () => value, document,
    setInterval(callback, delay) { assert.equal(delay, minute); const id = nextId++; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
  });
  return { clock, timers, handlers, document,
    advance(ms) { value += ms; },
    tick() { for (const callback of [...timers.values()]) callback(); },
    hide(hidden) { document.hidden = hidden; for (const listener of [...handlers]) listener(); },
    now: () => value,
  };
}

test('many message labels share one timer and release it when the last label leaves', () => {
  const f = clockFixture(), values = [];
  const listener = () => values.push(f.clock.getSnapshot());
  const cleanup = Array.from({ length: 200 }, () => f.clock.subscribe(listener));
  assert.equal(f.timers.size, 1); assert.equal(f.handlers.size, 1);
  assert.equal(values.length, 0);
  f.advance(minute); f.tick();
  assert.equal(values.length, 200);
  assert.ok(values.every(value => value === now + minute));
  cleanup.pop()(); cleanup.pop()();
  assert.equal(f.timers.size, 1);
  for (const unsubscribe of cleanup) unsubscribe();
  assert.equal(f.timers.size, 0); assert.equal(f.handlers.size, 0);
  for (const unsubscribe of cleanup) unsubscribe();
  assert.equal(f.timers.size, 0); assert.equal(f.handlers.size, 0);
});

test('the shared clock pauses while hidden and refreshes immediately when foregrounded', () => {
  const f = clockFixture(), values = [];
  const unsubscribe = f.clock.subscribe(() => values.push(f.clock.getSnapshot()));
  const lateTick = [...f.timers.values()][0];
  f.hide(true);
  assert.equal(f.timers.size, 0);
  f.advance(5 * minute); lateTick();
  assert.equal(values.length, 0); assert.equal(f.clock.getSnapshot(), now);
  f.hide(false);
  assert.deepEqual(values, [now + 5 * minute]); assert.equal(f.timers.size, 1);
  f.tick(); assert.equal(values.length, 1, 'same snapshot does not trigger extra renders');
  unsubscribe(); f.advance(hour);
  const again = f.clock.subscribe(() => values.push(f.clock.getSnapshot()));
  assert.equal(f.clock.getSnapshot(), f.now(), 'reopening uses current time before the next tick');
  again();
});

test('mounting labels in a hidden document does not start any timer', () => {
  const f = clockFixture(true), values = [];
  const unsubscribe = f.clock.subscribe(() => values.push(f.clock.getSnapshot()));
  assert.equal(f.timers.size, 0); assert.equal(f.handlers.size, 1);
  f.advance(minute); f.hide(false);
  assert.deepEqual(values, [now + minute]); assert.equal(f.timers.size, 1);
  unsubscribe(); assert.equal(f.handlers.size, 0); assert.equal(f.timers.size, 0);
});
