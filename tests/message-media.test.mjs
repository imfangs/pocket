import test from 'node:test';
import assert from 'node:assert/strict';
import { isMessageVideo, messageVideoType, isMessageImage, messageImageType, isMessageAudio, messageAudioType } from '../shared/message-media.mjs';

test('audio names classify only supported extensions without decoding or URL suffix stripping', () => {
  for (const [name, type] of [['sample.WAV', 'audio/wav'], ['sample.mp3', 'audio/mpeg'], ['sample.m4a', 'audio/mp4'],
    ['sample.aac', 'audio/aac'], ['sample.ogg', 'audio/ogg'], ['sample.OGA', 'audio/ogg'], ['sample.flac', 'audio/flac']]) {
    assert.equal(messageAudioType(name), type); assert.equal(isMessageAudio(name), true);
  }
  for (const name of [null, {}, '', 'page.html', 'drawing.svg', 'clip.mp4', 'sample.mp3.exe', 'sample.mp3?x=1', 'sample.mp3#x',
    'sample%2Emp3', 'sample.mp3 ', 'sample.mp3/', 'line\nsample.mp3', 'sample.mp3\0', 'x'.repeat(4096) + '.mp3']) {
    assert.equal(messageAudioType(name), null); assert.equal(isMessageAudio(name), false);
  }
});

test('image filename types cover only bounded raster names without URL decoding or suffix stripping', () => {
  for (const [name, type] of [['page-preview.jpg', 'image/jpeg'], ['REPORT.JPEG', 'image/jpeg'],
    ['/workspace/图片.png', 'image/png'], ['animation.GIF', 'image/gif'], ['plot.webp', 'image/webp']]) {
    assert.equal(messageImageType(name), type);
    assert.equal(isMessageImage(name), true);
  }
  for (const name of [null, undefined, {}, '', 'drawing.svg', 'page.html', 'image.avif', 'image.jpg.exe',
    'image.jpg ', 'image.jpg?download=1', 'image.jpg#preview', 'image%2Ejpg', 'image.jpg/',
    'image.constructor', 'image.jpg\0', 'line\nimage.jpg', 'x'.repeat(4096) + '.jpg']) {
    assert.equal(messageImageType(name), null);
    assert.equal(isMessageImage(name), false);
  }
});

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
