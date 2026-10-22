import test from 'node:test';
import assert from 'node:assert/strict';
import { referencedMessageFiles, directiveAttributes, localFileReference } from '../shared/codex-directives.mjs';

const citation = path => `:codex-file-citation{path=${JSON.stringify(path)} purpose="output"}`;
test('file capabilities come from actual citation and local Markdown references only', () => {
  const source = [citation('/workspace/简历 文件.docx'), '[说明](</workspace/说明%20A.pdf>)', '[表格][sheet]', '[sheet]: /workspace/book.xlsx',
    citation('/workspace/简历 文件.docx'), '![图片](/workspace/picture.png)', '[外站](https://example.com/a.pdf)', '```text', citation('/workspace/example.docx'), '```',
    '`'+citation('/workspace/inline.docx')+'`', '[说明](<https://example.com/:codex-file-citation{path="/workspace/destination.docx"}>)'].join('\n\n');
  assert.deepEqual(referencedMessageFiles(source), ['/workspace/简历 文件.docx','/workspace/说明 A.pdf','/workspace/book.xlsx']);
});
test('an incomplete component, duplicate attributes, and unknown components cannot grant files', () => {
  for (const source of [':codex-file-citation{path="/workspace/a.docx"',
    ':codex-file-citation{path="/workspace/a.docx" path="/workspace/b.docx"}',
    ':codex-file-citation{path="/workspace/a.docx" invalid}',
    ':codex-future-view{path="/workspace/a.docx"}', '```\n'+citation('/workspace/unclosed.docx'), '<!-- '+citation('/workspace/hidden.docx')+' -->'])
    assert.deepEqual(referencedMessageFiles(source), [], source);
});
test('literal citation filenames and URL-encoded Markdown filenames normalize exactly once', () => {
  assert.deepEqual(referencedMessageFiles(citation('/workspace/a%2Fb.docx')+'\n\n[a](/workspace/a%252Fb.docx)'), ['/workspace/a%2Fb.docx']);
  assert.equal(localFileReference('/workspace/a%2Fb.docx'),'/workspace/a%2Fb.docx');
  assert.equal(localFileReference('/workspace/a%252Fb.docx',true),'/workspace/a%2Fb.docx');
});
test('control paths, directory references, network paths and malformed Unicode are refused', () => {
  for (const value of ['//outside/a.docx','file:///workspace/a.docx','https://x/a.docx','/workspace/','/workspace/a\n.docx','/workspace/\uD800.docx'])
    assert.equal(localFileReference(value),null);
  assert.equal(directiveAttributes('path="a" path="b"'),null);
  assert.equal(directiveAttributes('path="a" trailing'),null);
  assert.equal(directiveAttributes('path="a" purpose="output"').purpose,'output');
});

test('escaped directive examples grant no files, including escaped double colons', () => {
 for (const prefix of ['\\:', '\\::', ':\\:', ':::']) {
  const text=prefix+'codex-file-citation{path="/workspace/example.docx"}';
  assert.deepEqual(referencedMessageFiles(text),[],text);
 }
 assert.deepEqual(referencedMessageFiles('\\\\'+citation('/workspace/even.docx')),['/workspace/even.docx']);
});

test('links inside component attributes remain literal and cannot grant extra files',()=>{
 for(const source of [':codex-future-panel{body="[secret](/workspace/hidden.md)"}',
  '::code-comment{title="Example" body="[secret](/workspace/hidden.md)"}',
  ':codex-file-citation{path="/workspace/visible.pdf" label="[secret](/workspace/hidden.md)"}',
  ':codex-future-panel{body="[secret](/workspace/hidden.md)"',
  '\\:codex-future-panel{body="[secret](/workspace/hidden.md)"}']) {
   const paths=referencedMessageFiles(source);assert.equal(paths.includes('/workspace/hidden.md'),false,source);
   if(source.startsWith(':codex-file-citation{'))assert.deepEqual(paths,['/workspace/visible.pdf']);
 }
});
