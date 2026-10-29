import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { constants, mkdtempSync, mkdirSync, writeFileSync, renameSync, symlinkSync, truncateSync, utimesSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageFiles } from '../server/message-files.mjs';
import { MAX_MESSAGE_VIDEO_BYTES, MESSAGE_VIDEO_CHUNK_BYTES } from '../server/message-video-stream.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
function mp4(size = 8192, brand = 'isom') {
  const bytes = Buffer.alloc(size, 0x61);
  bytes.writeUInt32BE(24, 0); bytes.write('ftyp', 4, 'ascii'); bytes.write(brand, 8, 'ascii');
  bytes.writeUInt32BE(0, 12); bytes.write('isom', 16, 'ascii'); bytes.write('avc1', 20, 'ascii');
  if (size >= 32) { bytes.writeUInt32BE(size - 24, 24); bytes.write('mdat', 28, 'ascii'); }
  return bytes;
}
function fixture(t, { name = '合成 视频.mp4', bytes = mp4(), openFile, now } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'pocket-video-')), cwd = join(base, 'project');
  mkdirSync(cwd); const path = join(cwd, name); writeFileSync(path, bytes);
  const service = new MessageFiles({ openFile, now }), thread = { id, cwd };
  const grant = (file = path) => service.attach(thread, { messages: [{ id: 'reply', role: 'assistant', phase: 'final',
    text: `:codex-file-citation{path=${JSON.stringify(file)} purpose="output"}` }] }).messages[0].files[file].url.split('/').at(-1);
  const key = grant();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, cwd, path, bytes, service, thread, key, grant, video: options => service.openVideo(thread, key, options) };
}
async function collect(result) {
  const chunks = [];
  try { if (result.stream) for await (const chunk of result.stream) chunks.push(chunk); return Buffer.concat(chunks); }
  finally { await result.close(); }
}
function tracker(onRead) {
  const opened = [], reads = [];
  const openFile = async (path, flags) => {
    assert.equal(flags & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
    assert.equal(flags & constants.O_NONBLOCK, constants.O_NONBLOCK);
    const file = await open(path, flags), record = { path, closed: 0 };
    opened.push(record);
    return { stat: options => file.stat(options), async read(...args) {
      reads.push({ buffer: args[0].length, length: args[2], position: args[3] });
      const result = await file.read(...args); await onRead?.({ args, result, path, count: reads.length }); return result;
    }, async close() { record.closed++; await file.close(); } };
  };
  return { opened, reads, openFile };
}

test('full GET returns exact bounded-stream bytes and private inline headers', async t => {
  const tracked = tracker(), f = fixture(t, { bytes: mp4(300_000), openFile: tracked.openFile });
  const result = await f.video();
  assert.equal(result.status, 200); assert.equal(result.headers['Content-Type'], 'video/mp4');
  assert.equal(result.headers['Content-Length'], String(f.bytes.length)); assert.equal(result.headers['Accept-Ranges'], 'bytes');
  assert.match(result.headers.ETag, /^"video-[a-f0-9]{64}"$/);
  assert.match(result.headers['Content-Disposition'], /^inline; filename\*=UTF-8''/);
  assert.equal(result.headers['Cache-Control'], 'no-store'); assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(result.headers['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(result.headers['Content-Security-Policy'], "default-src 'none'; sandbox");
  assert.equal(tracked.reads.length, 1, 'only the bounded container probe ran before consumption');
  assert.deepEqual(await collect(result), f.bytes);
  assert.ok(tracked.reads.every(read => read.buffer <= MESSAGE_VIDEO_CHUNK_BYTES));
  assert.equal(tracked.opened[0].closed, 1); assert.equal(f.service.activeVideoStreams, 0);
});

test('single explicit, open-ended, suffix and clamped ranges return exact 206 bytes', async t => {
  const f = fixture(t);
  for (const [range, start, end] of [['bytes=0-31', 0, 31], ['bytes=4000-', 4000, f.bytes.length - 1],
    ['bytes=-100', f.bytes.length - 100, f.bytes.length - 1], ['bytes=-999999999999999999999999999999', 0, f.bytes.length - 1],
    ['bytes=32-9999999999999999999999999999999', 32, f.bytes.length - 1], [' bytes=0001-0003 ', 1, 3]]) {
    const result = await f.video({ range });
    assert.equal(result.status, 206, range); assert.equal(result.headers['Content-Range'], `bytes ${start}-${end}/${f.bytes.length}`);
    assert.equal(result.headers['Content-Length'], String(end - start + 1));
    assert.deepEqual(await collect(result), f.bytes.subarray(start, end + 1), range);
  }
});

test('invalid, multipart, oversized and unsatisfiable ranges produce closed 416 responses', async t => {
  const tracked = tracker(), f = fixture(t, { openFile: tracked.openFile });
  for (const range of ['bytes=8192-', 'bytes=20-10', 'bytes=-0', 'bytes=-', 'bytes=one-two', 'bytes=0-1,4-5',
    `bytes=${'9'.repeat(300)}-`, 'bytes=999999999999999999999999999999-', ['bytes=0-1']]) {
    const result = await f.video({ range });
    assert.equal(result.status, 416); assert.equal(result.headers['Content-Range'], `bytes */${f.bytes.length}`);
    assert.equal(result.headers['Content-Length'], '0'); assert.equal(result.stream, null);
    await result.close(); assert.equal(f.service.activeVideoStreams, 0);
  }
  assert.ok(tracked.opened.every(file => file.closed === 1));
  const ignored = await f.video({ range: 'items=1-3' }); assert.equal(ignored.status, 200); await ignored.close();
});

test('HEAD ignores Range, advertises the full representation, and holds no stream slot or FD', async t => {
  const tracked = tracker(), f = fixture(t, { openFile: tracked.openFile });
  for (const range of [undefined, 'bytes=0-1', 'bytes=100000-', 'bytes=bad']) {
    const result = await f.video({ method: 'HEAD', range });
    assert.equal(result.status, 200); assert.equal(result.stream, null);
    assert.equal(result.headers['Content-Length'], String(f.bytes.length)); assert.equal(result.headers['Content-Range'], undefined);
    assert.equal(f.service.activeVideoStreams, 0); await result.close();
  }
  assert.ok(tracked.opened.every(file => file.closed === 1));
});

test('If-Range accepts only the exact strong ETag and discards invalid Range before mismatch handling', async t => {
  const f = fixture(t), head = await f.video({ method: 'HEAD' }), etag = head.headers.ETag, date = head.headers['Last-Modified'];
  const matching = await f.video({ range: 'bytes=1-5', ifRange: etag }); assert.equal(matching.status, 206);
  assert.deepEqual(await collect(matching), f.bytes.subarray(1, 6));
  for (const ifRange of [date, `W/${etag}`, '"other"', 'Thu, 01 Jan 1970 00:00:00 GMT', 'not-a-date', '', `${etag}, "other"`]) {
    const result = await f.video({ range: 'bytes=9999999999999999999999-,0-1', ifRange });
    assert.equal(result.status, 200, ifRange); assert.equal(result.headers['Content-Range'], undefined);
    assert.deepEqual(await collect(result), f.bytes);
  }
  writeFileSync(f.path, mp4(9000));
  const changed = await f.video({ range: 'bytes=1-5', ifRange: etag });
  assert.equal(changed.status, 200); assert.notEqual(changed.headers.ETag, etag); await changed.close();
});

test('an unchanged Last-Modified second cannot authorize mixing bytes after a same-size rewrite', async t => {
  const f = fixture(t), head = await f.video({ method: 'HEAD' }), date = head.headers['Last-Modified'];
  const newer = mp4(f.bytes.length, 'mp42'); writeFileSync(f.path, newer);
  utimesSync(f.path, new Date(date), new Date(date));
  const result = await f.video({ range: 'bytes=32-', ifRange: date });
  assert.equal(result.headers['Last-Modified'], date); assert.notEqual(result.headers.ETag, head.headers.ETag);
  assert.equal(result.status, 200); assert.deepEqual(await collect(result), newer);
});

test('only expected names with matching ISO/QuickTime/WebM headers can stream', async t => {
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
  for (const [name, bytes, type] of [['movie.MP4', mp4(), 'video/mp4'], ['movie.m4v', mp4(64, 'M4V '), 'video/mp4'],
    ['movie.mov', mp4(64, 'qt  '), 'video/quicktime'], ['movie.webm', webm, 'video/webm']]) {
    const f = fixture(t, { name, bytes }), result = await f.video();
    assert.equal(result.headers['Content-Type'], type); assert.deepEqual(await collect(result), bytes);
  }
  for (const [name, bytes] of [['fake.mp4', Buffer.from('<html>not a video</html>')], ['image.mp4', mp4(64, 'avif')],
    ['renamed.txt', mp4()], ['renamed.mp4?token=x', mp4()], ['wrong.webm', mp4()], ['movie.mp4', webm],
    ['bad.webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0xff, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d])], ['empty.mp4', Buffer.alloc(0)]]) {
    const f = fixture(t, { name, bytes });
    await assert.rejects(f.video(), error => error.status === 415, name);
    assert.equal(f.service.activeVideoStreams, 0);
  }
});

test('container probes support bounded extended/legacy atoms and reject conflicting or truncated EBML headers', async t => {
  const extended = Buffer.alloc(64, 0x61);
  extended.writeUInt32BE(1, 0); extended.write('ftyp', 4); extended.writeBigUInt64BE(32n, 8);
  extended.write('isom', 16); extended.writeUInt32BE(0, 20); extended.write('mp41mp42', 24);
  const legacy = Buffer.alloc(64, 0x61); legacy.writeUInt32BE(8, 0); legacy.write('wide', 4);
  legacy.writeUInt32BE(56, 8); legacy.write('mdat', 12);
  for (const [name, bytes] of [['extended.mp4', extended], ['legacy.mov', legacy]]) {
    const f = fixture(t, { name, bytes }); assert.deepEqual(await collect(await f.video()), bytes);
  }
  const doc = [0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d];
  for (const bytes of [Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x8e, ...doc, ...doc]),
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x88, ...doc, 0x42])]) {
    const f = fixture(t, { name: 'invalid.webm', bytes }); await assert.rejects(f.video(), error => error.status === 415);
  }
  legacy.writeUInt32BE(5000, 8);
  const invalidLegacy = fixture(t, { name: 'invalid.mov', bytes: legacy });
  await assert.rejects(invalidLegacy.video(), error => error.status === 415);
});

test('video streaming accepts a sparse 512 MiB file while ordinary downloads retain their 20 MiB cap', async t => {
  const tracked = tracker(), f = fixture(t, { openFile: tracked.openFile });
  truncateSync(f.path, MAX_MESSAGE_VIDEO_BYTES);
  const result = await f.video({ range: 'bytes=0-31' });
  assert.equal(result.status, 206); assert.equal(result.headers['Content-Range'], `bytes 0-31/${MAX_MESSAGE_VIDEO_BYTES}`);
  assert.deepEqual(await collect(result), f.bytes.subarray(0, 32));
  await assert.rejects(f.service.read(f.thread, f.key), error => error.status === 413);
  truncateSync(f.path, MAX_MESSAGE_VIDEO_BYTES + 1);
  await assert.rejects(f.video(), error => error.status === 413);
  assert.ok(tracked.reads.every(read => read.buffer <= 4096)); assert.ok(tracked.opened.every(file => file.closed === 1));
});

test('video capabilities retain thread/cwd/service/lifetime boundaries and never accept a request path', async t => {
  let now = 1000;
  const f = fixture(t, { now: () => now });
  for (const thread of [{ id: other, cwd: f.cwd }, { id, cwd: join(f.cwd, 'other') }, { id, cwd: '' }])
    await assert.rejects(f.service.openVideo(thread, f.key), error => error.status === 404);
  await assert.rejects(new MessageFiles().openVideo(f.thread, f.key), error => error.status === 404);
  await assert.rejects(f.service.openVideo(f.thread, f.path), error => error.status === 404);
  now += 3600000; await assert.rejects(f.video(), error => error.status === 404);
});

test('missing, directory and escaping symlink video references fail safely', async t => {
  const f = fixture(t), outside = join(f.base, 'outside.mp4'); writeFileSync(outside, mp4());
  mkdirSync(join(f.cwd, 'folder.mp4')); symlinkSync(outside, join(f.cwd, 'escape.mp4'));
  for (const [name, status] of [['missing.mp4', 404], ['folder.mp4', 415], ['escape.mp4', 403]])
    await assert.rejects(f.service.openVideo(f.thread, f.grant(join(f.cwd, name))),
      error => error.status === status && !error.message.includes(f.base));
});

test('replacement between FD open and pathname verification is rejected with the FD closed', async t => {
  let path, closes = 0;
  const f = fixture(t, { openFile: async (value, flags) => {
    const file = await open(value, flags); renameSync(path, `${path}.old`); writeFileSync(path, mp4());
    return { stat: options => file.stat(options), read: (...args) => file.read(...args), close: async () => { closes++; await file.close(); } };
  } }); path = f.path;
  await assert.rejects(f.video(), error => error.status === 409); assert.equal(closes, 1);
});

test('growth, same-size writes and path replacement during streaming abort before returning changed bytes', async t => {
  for (const mutate of ['grow', 'overwrite', 'replace', 'symlink']) {
    const tracked = tracker(({ path, count }) => {
      if (count !== 2) return;
      if (mutate === 'grow') truncateSync(path, 400_000);
      else if (mutate === 'overwrite') writeFileSync(path, mp4(300_000, 'mp42'));
      else {
        renameSync(path, `${path}.old`);
        if (mutate === 'replace') writeFileSync(path, mp4(300_000));
        else symlinkSync(`${path}.old`, path);
      }
    });
    const f = fixture(t, { bytes: mp4(300_000), openFile: tracked.openFile }), result = await f.video();
    await assert.rejects(collect(result), error => error.status === 409, mutate);
    assert.equal(tracked.opened[0].closed, 1); assert.equal(f.service.activeVideoStreams, 0);
  }
});

test('a paused consumer bounds prefetch and explicit close safely releases its FD', async t => {
  const tracked = tracker(), f = fixture(t, { bytes: mp4(2 * 1024 * 1024), openFile: tracked.openFile }), result = await f.video();
  result.stream.once('data', () => result.stream.pause());
  await once(result.stream, 'data'); await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(tracked.reads.reduce((sum, read) => sum + read.length, 0) <= 4096 + 3 * MESSAGE_VIDEO_CHUNK_BYTES);
  await result.close(); await result.close(); assert.equal(tracked.opened[0].closed, 1);
  assert.equal(f.service.activeVideoStreams, 0);
});

test('closing or aborting a never-consumed stream releases its slot and FD exactly once', async t => {
  const tracked = tracker(), f = fixture(t, { openFile: tracked.openFile });
  const controller = new AbortController(), result = await f.video({ signal: controller.signal });
  assert.equal(f.service.activeVideoStreams, 1); controller.abort(); await result.close(); await result.close();
  assert.equal(f.service.activeVideoStreams, 0); assert.equal(tracked.opened[0].closed, 1);
  const second = await f.video(); await second.close(); assert.equal(tracked.opened[1].closed, 1);
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(f.video({ signal: stopped.signal }), error => error.name === 'AbortError');
  assert.equal(tracked.opened[2].closed, 1);
});

test('at most 16 GET streams stay open; HEAD and 416 do not consume slots', async t => {
  const tracked = tracker(), f = fixture(t, { openFile: tracked.openFile }), streams = [];
  t.after(async () => { for (const stream of streams) await stream.close(); });
  for (let index = 0; index < 16; index++) streams.push(await f.video());
  assert.equal(f.service.activeVideoStreams, 16);
  await assert.rejects(f.video(), error => error.status === 503);
  assert.equal((await f.video({ method: 'HEAD' })).status, 200);
  assert.equal((await f.video({ range: 'bytes=999999-' })).status, 416);
  assert.equal(f.service.activeVideoStreams, 16);
  await streams[0].close(); streams.push(await f.video());
  for (const stream of streams) await stream.close();
  assert.equal(f.service.activeVideoStreams, 0); assert.ok(tracked.opened.every(file => file.closed === 1));
});
