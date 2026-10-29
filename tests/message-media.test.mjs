import test from 'node:test';
import assert from 'node:assert/strict';
import { isMessageVideo, messageVideoType } from '../shared/message-media.mjs';

test('video filename types are shared, case insensitive, and do not decode or strip suffixes', () => {
  for (const [name, type] of [['clip.mp4', 'video/mp4'], ['/workspace/录制.M4V', 'video/mp4'],
    ['report.final.MOV', 'video/quicktime'], ['preview.webm', 'video/webm']]) {
    assert.equal(messageVideoType(name), type);
    assert.equal(isMessageVideo(name), true);
  }
  for (const name of [null, undefined, {}, '', 'image.png', 'video.mp4.exe', 'clip.mp4 ', 'clip.mp4?download=1',
    'clip.mp4#time=2', 'clip%2Emp4', 'clip.mp4/', 'clip.constructor', 'clip.mp4\0', 'x'.repeat(4096) + '.mp4']) {
    assert.equal(messageVideoType(name), null);
    assert.equal(isMessageVideo(name), false);
  }
});
