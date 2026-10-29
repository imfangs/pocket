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

test('only supported video images and image references add file capabilities', () => {
  const source = ['![mp4](/workspace/clip.mp4)', '![mov](</workspace/录制%20A.MOV>)',
    '![m4v][recording]', '[recording]: /workspace/recording.m4v', '![webm][]', '[webm]: /workspace/preview.webm',
    '![shortcut]', '[shortcut]: /workspace/shortcut.mp4', '![image](/workspace/picture.png)',
    '![remote](https://example.test/video.mp4)', '![network](//example.test/video.mp4)',
    '![suffix](/workspace/video.mp4?download=1)', '[ordinary](/workspace/report.docx)'].join('\n\n');
  assert.deepEqual(referencedMessageFiles(source), ['/workspace/clip.mp4', '/workspace/录制 A.MOV',
    '/workspace/recording.m4v', '/workspace/preview.webm', '/workspace/shortcut.mp4', '/workspace/report.docx']);
});

test('video reference definitions use the first normalized identifier and cannot authorize a shadow', () => {
  assert.deepEqual(referencedMessageFiles('![v][x]\n\n[x]: /workspace/visible.png\n[x]: /workspace/shadow.mp4'), []);
  assert.deepEqual(referencedMessageFiles('![v][Clip name]\n\n[CLIP  NAME]: /workspace/first.mov\n[clip name]: /workspace/shadow.mp4'), ['/workspace/first.mov']);
  assert.deepEqual(referencedMessageFiles('[v][x]\n\n[x]: /workspace/first.pdf\n[x]: /workspace/shadow.mp4'), ['/workspace/first.pdf']);
  assert.deepEqual(referencedMessageFiles('[unused]: /workspace/unused.mp4'), []);
});

test('video images do not grant from link labels, even when their path is granted elsewhere', () => {
  assert.deepEqual(referencedMessageFiles('[![v](/workspace/hidden.mp4)](/workspace/visible.pdf)'), ['/workspace/visible.pdf']);
  assert.deepEqual(referencedMessageFiles('[![v](/workspace/hidden.mp4)](https://example.test)'), []);
  assert.deepEqual(referencedMessageFiles('[![v][clip]][outer]\n\n[clip]: /workspace/hidden.mp4\n[outer]: /workspace/visible.mov'), ['/workspace/visible.mov']);
  assert.deepEqual(referencedMessageFiles('![v](/workspace/shared.mp4)\n\n[![v](/workspace/shared.mp4)](https://example.test)'), ['/workspace/shared.mp4']);
});

test('video examples, escaped syntax, raw HTML and incomplete components do not mint files', () => {
  for (const source of ['`![v](/workspace/inline.mp4)`', '```md\n![v](/workspace/code.mp4)\n```',
    '```md\n![v](/workspace/unclosed.mp4)', '    ![v](/workspace/indented.mp4)',
    '!\\[v](/workspace/escaped.mp4)', '![v](/workspace/incomplete.mp4', '<video src="/workspace/raw.mp4"></video>',
    '<div>\n![v](/workspace/html.mp4)\n</div>', ':codex-future-panel{body="![v](/workspace/hidden.mp4)"}',
    ':codex-future-panel{body="![v](/workspace/hidden.mp4)"', ':codex-file-citation{path="/workspace/x.mp4" path="/workspace/y.mp4"}']) {
    assert.deepEqual(referencedMessageFiles(source), [], source);
  }
  // Escaping only ! leaves an ordinary Markdown link, which retains its old permission rule.
  assert.deepEqual(referencedMessageFiles('\\![v](/workspace/link.mp4)'), ['/workspace/link.mp4']);
  assert.deepEqual(referencedMessageFiles('<span>![v](/workspace/visible.mp4)</span>'), ['/workspace/visible.mp4']);
});

test('video paths decode exactly once and reject controls and forged URL suffixes', () => {
  assert.deepEqual(referencedMessageFiles('![v](/workspace/clip%2Emp4)'), ['/workspace/clip.mp4']);
  for (const url of ['/workspace/clip%252Emp4', '/workspace/clip.mp4%00', '/workspace/clip.mp4#t=3',
    'file:///workspace/clip.mp4', '/workspace/clip%ZZ.mp4'])
    assert.deepEqual(referencedMessageFiles(`![v](${url})`), [], url);
});

test('hidden provenance and display-only reference payloads cannot grant files', () => {
  for (const tag of ['oai-mem-citation', 'citation_entries', 'rollout_ids']) {
    for (const [open, close] of [[`<${tag}>`, `</${tag}>`], [`&lt;${tag}&gt;`, `&lt;/${tag}&gt;`]]) {
      assert.deepEqual(referencedMessageFiles(`${open}\n\n![v](/workspace/hidden.mp4)\n\n[doc](/workspace/hidden.pdf)\n\n${close}`), []);
      assert.deepEqual(referencedMessageFiles(`${open}\n\n![v](/workspace/streamed.mp4)`), []);
      assert.deepEqual(referencedMessageFiles('```text\n'+open+'\n```\n\n![v](/workspace/visible.mp4)'), ['/workspace/visible.mp4']);
    }
  }
  assert.deepEqual(referencedMessageFiles('image_group![v](/workspace/hidden.mp4)'), []);
  assert.deepEqual(referencedMessageFiles('entity["type","[file](/workspace/hidden.pdf)"]'), []);
  assert.deepEqual(referencedMessageFiles('entityinvalid [file](/workspace/visible.pdf)'), ['/workspace/visible.pdf']);
  assert.deepEqual(referencedMessageFiles('entityinvalid ![v](/workspace/visible.mp4)'), ['/workspace/visible.mp4']);
  assert.deepEqual(referencedMessageFiles('<oai-mem-citation>\n\n[x]: /workspace/hidden.mp4\n\n</oai-mem-citation>\n\n![v][x]\n\n[x]: /workspace/visible.mov'), ['/workspace/visible.mov']);
});
