import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, mkdtempSync, mkdirSync, writeFileSync, renameSync, symlinkSync, truncateSync, rmSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageFiles } from '../server/message-files.mjs';
import { MAX_MESSAGE_AUDIO_BYTES } from '../server/message-audio-stream.mjs';
import { MESSAGE_MEDIA_CHUNK_BYTES } from '../server/message-media-stream.mjs';
import { wav, mp3, m4a, aac, ogg, flac } from './helpers/audio-fixtures.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
function fixture(t, { name = '合成音频.wav', bytes = wav(), openFile, realpathFile, now } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'pocket-audio-')), cwd = join(base, 'project'); mkdirSync(cwd);
  const path = join(cwd, name); writeFileSync(path, bytes);
  const service = new MessageFiles({ openFile, realpathFile, now }), thread = { id, cwd };
  const grant = (file = path) => service.attach(thread, { messages: [{ role: 'assistant', phase: 'final', text: `[audio](<${file}>)` }] })
    .messages[0].files[file].url.split('/').at(-1);
  const key = grant();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, cwd, path, bytes, service, thread, key, grant, audio: options => service.openAudio(thread, key, options) };
}
async function collect(result) {
  const chunks = [];
  try { if (result.stream) for await (const chunk of result.stream) chunks.push(chunk); return Buffer.concat(chunks); }
  finally { await result.close(); }
}
function tracker(onRead) {
  const opened = [], reads = [];
  const openFile = async (path, flags) => {
    assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = await open(path, flags), record = { closed: 0 }; opened.push(record);
    return { stat: options => file.stat(options), read: async (...args) => {
      reads.push({ length: args[0].length, position: args[3] });
      const result = await file.read(...args); await onRead?.({ path, count: reads.length }); return result;
    }, close: async () => { record.closed++; await file.close(); } };
  };
  return { openFile, opened, reads };
}

test('authorized audio files stream unchanged bytes with the expected MIME and private headers', async t => {
  for (const [name, bytes, type] of [['sample.WAV', wav(100000), 'audio/wav'], ['sample.mp3', mp3(), 'audio/mpeg'],
    ['tagged.mp3', mp3(8192), 'audio/mpeg'], ['sample.m4a', m4a(), 'audio/mp4'], ['sample.aac', aac(), 'audio/aac'],
    ['sample.ogg', ogg(), 'audio/ogg'], ['sample.oga', ogg('vorbis'), 'audio/ogg'], ['lossless.ogg', ogg('flac'), 'audio/ogg'], ['sample.flac', flac(), 'audio/flac']]) {
    const tracked = tracker(), f = fixture(t, { name, bytes, openFile: tracked.openFile }), result = await f.audio();
    assert.equal(result.status, 200); assert.equal(result.headers['Content-Type'], type);
    assert.equal(result.headers['Content-Length'], String(bytes.length)); assert.match(result.headers.ETag, /^"audio-[a-f0-9]{64}"$/);
    assert.match(result.headers['Content-Disposition'], /^inline;/);
    assert.equal(result.headers['Cache-Control'], 'no-store'); assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(result.headers['Cross-Origin-Resource-Policy'], 'same-origin');
    assert.equal(result.headers['Content-Security-Policy'], "default-src 'none'; sandbox");
    assert.ok(tracked.reads.every(read => read.length <= 4096), 'only bounded container probes ran before consumption');
    assert.deepEqual(await collect(result), bytes); assert.equal(f.service.activeVideoStreams, 0);
    assert.ok(tracked.reads.every(read => read.length <= MESSAGE_MEDIA_CHUNK_BYTES)); assert.equal(tracked.opened[0].closed, 1);
  }
});

test('fake, mismatched, malformed or unsupported audio headers cannot create a stream', async t => {
  const badTag = mp3(100); badTag[6] = 128;
  const tagOnly = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00');
  const theora = ogg(); theora[28] = 128; theora.write('theora', 29);
  const wrongWave = wav(); wrongWave.write('WEBP', 8);
  const badAac = aac(); badAac[2] = 0x7c;
  for (const [name, bytes] of [['fake.wav', Buffer.from('<html>not audio</html>')], ['fake.mp3', wav()], ['fake.m4a', m4a(64, 'avif')],
    ['video.m4a', m4a(64, 'isom')], ['fake.aac', mp3()], ['fake.ogg', theora], ['fake.flac', ogg()], ['renamed.svg', wav()],
    ['renamed.html', mp3()], ['empty.wav', Buffer.alloc(0)], ['short.mp3', Buffer.from([255, 251, 144, 0])],
    ['bad-tag.mp3', badTag], ['tag-only.mp3', tagOnly], ['wrong.wav', wrongWave], ['bad.aac', badAac]]) {
    const f = fixture(t, { name, bytes }); await assert.rejects(f.audio(), error => error.status === 415, name);
    assert.equal(f.service.activeVideoStreams, 0);
  }
});

test('audio single ranges, strong If-Range, HEAD and 416 share the proven bounded media lifecycle', async t => {
  const tracked = tracker(), f = fixture(t, { openFile: tracked.openFile }), head = await f.audio({ method: 'HEAD', range: 'bytes=0-1' });
  assert.equal(head.status, 200); assert.equal(head.stream, null); assert.equal(head.headers['Content-Length'], String(f.bytes.length));
  assert.equal(f.service.activeVideoStreams, 0); await head.close();
  for (const [range, start, end] of [['bytes=0-43', 0, 43], ['bytes=500-', 500, f.bytes.length - 1], ['bytes=-32', f.bytes.length - 32, f.bytes.length - 1]]) {
    const result = await f.audio({ range, ifRange: head.headers.ETag }); assert.equal(result.status, 206);
    assert.equal(result.headers['Content-Range'], `bytes ${start}-${end}/${f.bytes.length}`);
    assert.deepEqual(await collect(result), f.bytes.subarray(start, end + 1));
  }
  const changedValidator = await f.audio({ range: 'bytes=bad', ifRange: '"older"' });
  assert.equal(changedValidator.status, 200); assert.deepEqual(await collect(changedValidator), f.bytes);
  for (const range of ['bytes=999999-', 'bytes=-0', 'bytes=4-2', 'bytes=0-1,4-5']) {
    const result = await f.audio({ range }); assert.equal(result.status, 416); assert.equal(result.stream, null);
    assert.equal(result.headers['Content-Range'], `bytes */${f.bytes.length}`); await result.close();
  }
  assert.ok(tracked.opened.every(file => file.closed === 1));
});

test('audio 512 MiB streaming cap is independent of the unchanged 20 MiB download cap', async t => {
  const tracked = tracker(), f = fixture(t, { name: 'large.m4a', bytes: m4a(), openFile: tracked.openFile });
  truncateSync(f.path, MAX_MESSAGE_AUDIO_BYTES);
  const result = await f.audio({ range: 'bytes=0-23' }); assert.equal(result.status, 206);
  assert.equal(result.headers['Content-Range'], `bytes 0-23/${MAX_MESSAGE_AUDIO_BYTES}`);
  assert.deepEqual(await collect(result), f.bytes.subarray(0, 24));
  await assert.rejects(f.service.read(f.thread, f.key), error => error.status === 413);
  truncateSync(f.path, MAX_MESSAGE_AUDIO_BYTES + 1); await assert.rejects(f.audio(), error => error.status === 413);
  assert.ok(tracked.reads.every(read => read.length <= 4096)); assert.ok(tracked.opened.every(file => file.closed === 1));
});

test('audio references retain thread, cwd, lifetime and realpath boundaries without arbitrary paths', async t => {
  let now = 10000; const f = fixture(t, { now: () => now });
  for (const thread of [{ ...f.thread, id: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb' }, { ...f.thread, cwd: f.base }, { ...f.thread, cwd: '' }])
    await assert.rejects(f.service.openAudio(thread, f.key), error => error.status === 404);
  await assert.rejects(f.service.openAudio(f.thread, f.path), error => error.status === 404);
  writeFileSync(join(f.base, 'outside.wav'), wav()); symlinkSync(join(f.base, 'outside.wav'), join(f.cwd, 'escape.wav'));
  mkdirSync(join(f.cwd, 'directory.wav'));
  for (const [name, status] of [['escape.wav', 403], ['missing.wav', 404], ['directory.wav', 415]])
    await assert.rejects(f.service.openAudio(f.thread, f.grant(join(f.cwd, name))), error => error.status === status && !error.message.includes(f.base));
  now += 3600000; await assert.rejects(f.audio(), error => error.status === 404);
});

test('audio and video share one 16-stream budget while HEAD and 416 hold no slot', async t => {
  const tracked = tracker(), f = fixture(t, { openFile: tracked.openFile }), streams = [];
  const videoPath = join(f.cwd, 'video.mp4'); writeFileSync(videoPath, m4a(8192, 'isom')); const videoKey = f.grant(videoPath);
  t.after(async () => { for (const result of streams) await result.close(); });
  for (let index = 0; index < 8; index++) { streams.push(await f.audio()); streams.push(await f.service.openVideo(f.thread, videoKey)); }
  assert.equal(f.service.activeVideoStreams, 16);
  await assert.rejects(f.audio(), error => error.status === 503); await assert.rejects(f.service.openVideo(f.thread, videoKey), error => error.status === 503);
  assert.equal((await f.audio({ method: 'HEAD' })).status, 200); assert.equal((await f.audio({ range: 'bytes=999999-' })).status, 416);
  for (const result of streams) await result.close();
  assert.equal(f.service.activeVideoStreams, 0); assert.ok(tracked.opened.every(file => file.closed === 1));
});

test('audio cancellation before and after probes closes never-consumed streams exactly once', async t => {
  const tracked = tracker(), f = fixture(t, { openFile: tracked.openFile }), controller = new AbortController();
  const result = await f.audio({ signal: controller.signal }); controller.abort(); await result.close(); await result.close();
  assert.equal(tracked.opened[0].closed, 1); assert.equal(f.service.activeVideoStreams, 0);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.audio({ signal: cancelled.signal }), error => error.name === 'AbortError');
  assert.equal(tracked.opened[1].closed, 1);
});

for (const change of ['grow', 'overwrite', 'replace']) {
  test(`audio rejects ${change} during streaming before changed bytes reach the consumer`, async t => {
    const tracked = tracker(({ path, count }) => {
      if (count !== 2) return;
      if (change === 'grow') truncateSync(path, 400000);
      else if (change === 'overwrite') writeFileSync(path, wav(100000));
      else { renameSync(path, path + '.old'); writeFileSync(path, wav(100000)); }
    });
    const f = fixture(t, { bytes: wav(100000), openFile: tracked.openFile }), result = await f.audio();
    await assert.rejects(collect(result), error => error.status === 409);
    assert.equal(tracked.opened[0].closed, 1); assert.equal(f.service.activeVideoStreams, 0);
  });
}

for (const stage of ['root', 'open', 'read']) {
  test(`audio native permissions at ${stage} use the fixed 403 and release resources`, async t => {
    for (const code of ['EPERM', 'EACCES']) {
      let opened = false, closed = false;
      const native = Object.assign(new Error(`${code}: native private path /private/audio.wav`), { code });
      const f = fixture(t, { realpathFile: async path => { if (stage === 'root') throw native; return realpath(path); },
        openFile: async (path, flags) => {
          if (stage === 'open') throw native;
          const file = await open(path, flags); opened = true;
          return { stat: options => file.stat(options), read: (...args) => { if (stage === 'read') throw native; return file.read(...args); },
            close: async () => { closed = true; await file.close(); } };
        } });
      await assert.rejects(f.audio(), error => {
        assert.equal(error.status, 403); assert.equal(error.message, 'Mac 服务无权读取这个音频，请在电脑上检查文件访问权限');
        assert.equal(error.message.includes(code), false); assert.equal(error.message.includes('TCC'), false); assert.equal(error.code, undefined);
        return true;
      });
      assert.equal(closed, opened); assert.equal(f.service.activeVideoStreams, 0);
    }
  });
}
