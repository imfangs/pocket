import test from 'node:test';
import assert from 'node:assert/strict';
import { richFilePreviewKind, richFilePreviewBytes } from '../src/filePreviewKind.ts';

test('common file preview classification is bounded and does not treat unsupported source names as documents', () => {
  for (const [name, kind] of [['note.PDF', 'pdf'], ['figure.svg', 'svg'], ['clip.mp3', 'audio'], ['audio.M4A', 'audio'],
    ['notes.docx', 'docx'], ['rows.xlsx', 'xlsx'], ['slides.pptx', 'pptx'], ['package.zip', 'archive']])
    assert.equal(richFilePreviewKind(name), kind);
  for (const name of ['photo.jpg', 'site.html', 'movie.mp4', 'old.doc', 'old.xls', 'old.ppt', 'program.exe',
    'note.pdf?file=1', 'note.pdf\0', 'x'.repeat(4097)]) assert.equal(richFilePreviewKind(name), null, name);
  assert.equal(richFilePreviewBytes('svg'), 1024 * 1024);
  assert.equal(richFilePreviewBytes('docx'), 20 * 1024 * 1024);
});
