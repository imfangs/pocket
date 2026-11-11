import test from 'node:test';
import assert from 'node:assert/strict';
import { openMessageMediaStream } from '../server/message-media-stream.mjs';

for (const kind of ['audio', 'video']) test(`${kind} EOF after verification reports changed-file 409 and releases its descriptor and slot`, async () => {
  let closed = 0, released = 0;
  const before = { size: 1024n, dev: 1n, ino: 2n, mtimeNs: 3n, ctimeNs: 4n, mtimeMs: 0n };
  const file = { close: async () => closed++, read: async () => ({ bytesRead: 0 }) };
  const opened = await openMessageMediaStream({ file, before, name: kind === 'audio' ? 'sample.wav' : 'sample.mp4',
    verify: async () => {}, reserve: () => () => released++, kind,
    sniffType: async () => kind === 'audio' ? 'audio/wav' : 'video/mp4',
    readError: () => Object.assign(new Error('Unreadable media'), { status: 404 }) });
  await assert.rejects(async () => { for await (const chunk of opened.stream) void chunk; }, error => error.status === 409 && error.message === '文件正在更新，请稍后重试');
  await opened.close(); assert.equal(closed, 1); assert.equal(released, 1);
});
