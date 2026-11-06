import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'parse5';
import { htmlPreviewPolicy, referencedHtmlImages, renderHtmlPreview } from '../shared/html-preview.mjs';

const png = 'data:image/png;base64,aGVsbG8=';
const jpeg = 'data:image/jpeg;base64,YQ==';
const nodes = html => {
  const pending = [parse(html, { scriptingEnabled: false })], output = [];
  while (pending.length) {
    const node = pending.pop(); output.push(node);
    if (node.content) pending.push(node.content);
    for (let index = (node.childNodes?.length ?? 0) - 1; index >= 0; index--) pending.push(node.childNodes[index]);
  }
  return output;
};
const elements = html => nodes(html).filter(node => node.tagName);
const attributes = node => Object.fromEntries(node.attrs.map(attr => [attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name, attr.value]));
const find = (html, name) => elements(html).filter(node => node.tagName.toLowerCase() === name);

test('only actual visible HTML img[src] declarations supply ordered, entity-decoded candidates', () => {
  const html = `<img src="raw/a&amp;b.jpg"><img src="raw/a&amp;b.jpg"><IMG SRC='raw/second%20photo.png'>
    <script>const example = '<img src="script.png">';</script><style>.x{background:url(css.png)}</style>
    <div data-src="data.png" data-official="https://official.example.test/photo.png">Example</div>
    <textarea>&lt;img src="textarea.png"&gt;</textarea><template><img src="template.png"></template>
    <svg><image href="svg.png"/></svg><img srcset="candidate.png 1x"><noscript><img src="fallback.png"></noscript>`;
  assert.deepEqual(referencedHtmlImages(html), ['raw/a&b.jpg', 'raw/second%20photo.png', 'fallback.png']);
});

test('image candidates never include external, absolute, data, fragment or control-bearing sources', () => {
  const sources = ['https://remote.test/a.jpg', '//remote.test/a.jpg', '/private/a.jpg', 'C:\\private\\a.jpg',
    'data:image/png;base64,YQ==', 'blob:opaque', '#asset', 'javascript:evil()', 'raw/\\escape.jpg', 'raw/\u0000.jpg', '  '];
  assert.deepEqual(referencedHtmlImages(sources.map(source => `<img src="${source.replaceAll('"', '&quot;')}">`).join('')), []);
});

test('static preview preserves document structure, typography, SVG shapes and native disclosures', () => {
  const html = `<html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Report</title>
    <style>html[data-theme=light]{color:#123456}body{margin:16px}.card{border-radius:12px}</style></head>
    <body class="gallery" style="background:#fafafa"><h1>Report &amp; notes</h1><svg viewBox="0 0 12 12"><path d="M0 0L12 12"/></svg>
    <details><summary>More</summary><p>Visible on demand</p></details></body></html>`;
  const rendered = renderHtmlPreview(html);
  assert.deepEqual(attributes(find(rendered, 'html')[0]), { lang: 'zh-CN', 'data-theme': 'light' });
  assert.deepEqual(attributes(find(rendered, 'body')[0]), { class: 'gallery', style: 'background:#fafafa' });
  assert.match(rendered, /html\[data-theme=light\]\{color:#123456\}/);
  assert.equal(find(rendered, 'style').length, 1); assert.equal(find(rendered, 'path').length, 1);
  assert.equal(find(rendered, 'details').length, 1); assert.match(rendered, /<summary>More<\/summary>/);
  assert.match(rendered, /Report &amp; notes/);
  assert.equal(find(rendered, 'meta')[0].attrs.find(attr => attr.name === 'content').value, htmlPreviewPolicy);
});

test('one restrictive CSP precedes original head contents and cannot be replaced by file policies', () => {
  const rendered = renderHtmlPreview('<meta http-equiv="Content-Security-Policy" content="default-src *"><meta HTTP-EQUIV="refresh" content="0;url=/api/private"><style>body{color:blue}</style>');
  const head = find(rendered, 'head')[0];
  assert.equal(head.childNodes[0].tagName, 'meta');
  assert.equal(attributes(head.childNodes[0])['http-equiv'], 'Content-Security-Policy');
  assert.equal(find(rendered, 'meta').length, 1);
  assert.equal(attributes(head.childNodes[0]).content, htmlPreviewPolicy);
  assert.doesNotMatch(rendered, /default-src \*|0;url/);
  for (const directive of ["script-src 'none'", "img-src data:", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(htmlPreviewPolicy.includes(directive));
});

test('approved original image keys map only to raster data bytes, with no path or URL fallback', () => {
  const inherited = Object.create({ 'inherited.jpg': jpeg }); inherited['raw/photo&one.jpg'] = png;
  inherited['external-map.jpg'] = 'https://external.test/leak'; inherited['svg-map.jpg'] = 'data:image/svg+xml;base64,PHN2Zy8+';
  const rendered = renderHtmlPreview(`<img src="raw/photo&amp;one.jpg" srcset="https://external.test/b.jpg 2x" onerror="send()">
    <img src="missing.jpg"><img src="inherited.jpg"><img src="external-map.jpg"><img src="svg-map.jpg"><img src="${jpeg}">`, inherited);
  assert.deepEqual(find(rendered, 'img').map(node => attributes(node).src ?? null), [png, null, null, null, null, jpeg]);
  assert.ok(find(rendered, 'img').every(node => !('srcset' in attributes(node)) && !('onerror' in attributes(node))));
});

test('active elements, event attributes and resource/navigation transports are removed across namespaces', () => {
  const rendered = renderHtmlPreview(`<base href="https://external.test/"><link rel="stylesheet" href="/private.css"><script>evil()</script>
    <iframe srcdoc="<script>evil()</script>" src="/api/private"></iframe><object data="/api/private"></object><embed src="/api/private">
    <portal src="/api/private"></portal><fencedframe src="/api/private"></fencedframe>
    <div onclick="evil()" onpointerdown="evil()" background="/background" contenteditable draggable autofocus>Text</div>
    <video src="/movie" poster="/poster" autoplay></video><picture><source srcset="/image 1x"><img src="missing.png"></picture>
    <svg onload="evil()"><image xlink:href="/svg-image"/><use href="#private-symbol"/><foreignObject><div onload="evil()">Inner</div></foreignObject>
      <animate attributeName="href" values="/api/private"/><set attributeName="href" to="/api/private"/><animateMotion/><animateTransform/></svg>
    <a href="/api/private" target="_top" ping="https://external.test" download>Link</a>`);
  const list = elements(rendered);
  assert.ok(list.every(node => !['script', 'base', 'link', 'iframe', 'object', 'embed', 'portal', 'fencedframe', 'animate', 'set', 'animatemotion', 'animatetransform'].includes(node.tagName.toLowerCase())));
  assert.ok(list.every(node => node.attrs.every(attr => !/^on/i.test(attr.name) && !['src', 'srcset', 'poster', 'href', 'target', 'ping', 'download', 'background', 'autofocus', 'autoplay', 'contenteditable', 'draggable'].includes(attr.name.toLowerCase()))));
  assert.equal(find(rendered, 'foreignobject').length, 1);
});

test('noscript and template trees are parsed as inert markup and fully cleaned before serialization', () => {
  const rendered = renderHtmlPreview(`<noscript><iframe src="/api/private"></iframe><img src="missing.png" onerror="evil()"><p>Fallback</p></noscript>
    <div><template shadowrootmode="open"><svg><a xlink:href="/api/private"><set attributeName="href" to="/api/private"/></a></svg>
      <script>evil()</script><meta http-equiv="refresh" content="0;url=/api/private"><input autofocus><p>Template text</p></template></div>`);
  const list = elements(rendered);
  assert.ok(list.every(node => !['iframe', 'script', 'set'].includes(node.tagName.toLowerCase())));
  assert.doesNotMatch(rendered, /shadowrootmode|onerror|autofocus|xlink:href|\/api\/private/);
  assert.match(rendered, /Fallback/); assert.match(rendered, /Template text/);
  assert.equal(find(rendered, 'input')[0].attrs.find(attr => attr.name === 'disabled').value, '');
});

test('fragment anchors stay in srcdoc while external links and SVG SMIL cannot redirect them', () => {
  const rendered = renderHtmlPreview('<a href="#chapter">Chapter</a><area href="#chart"><a href="https://external.test">Remote</a><svg><a xlink:href="#icon"><set attributeName="href" to="/private"/><text>Icon</text></a></svg>');
  assert.deepEqual(find(rendered, 'a').map(node => attributes(node).href ?? null), ['about:srcdoc#chapter', null, 'about:srcdoc#icon']);
  assert.equal(attributes(find(rendered, 'area')[0]).href, 'about:srcdoc#chart');
  assert.equal(find(rendered, 'set').length, 0);
});

test('static form controls are explicitly disabled and cannot submit, autofocus or edit', () => {
  const rendered = renderHtmlPreview('<form action="/api/private" target="_top"><fieldset><button formaction="/api/private" formtarget="_top">Go</button><input type="text" autofocus><select><optgroup><option>A</option></optgroup></select><textarea>Notes</textarea></fieldset></form>');
  assert.ok(find(rendered, 'form').every(node => !('action' in attributes(node)) && !('target' in attributes(node))));
  for (const tag of ['fieldset', 'button', 'input', 'select', 'optgroup', 'option', 'textarea']) for (const node of find(rendered, tag)) {
    assert.equal(attributes(node).disabled, ''); assert.equal(attributes(node)['aria-disabled'], 'true');
    assert.ok(!('autofocus' in attributes(node)) && !('formaction' in attributes(node)) && !('formtarget' in attributes(node)));
  }
});

test('malformed HTML and escaped markup use HTML5 parsing without turning examples into resource grants', () => {
  const source = '&lt;img src="example.png"&gt;<div><p>Broken table<table><tr><td><img src="actual&amp;image.png"><script>bad()</script>';
  assert.deepEqual(referencedHtmlImages(source), ['actual&image.png']);
  const rendered = renderHtmlPreview(source, { 'actual&image.png': png });
  assert.match(rendered, /&lt;img src="example.png"&gt;/); assert.equal(find(rendered, 'script').length, 0);
  assert.equal(attributes(find(rendered, 'img')[0]).src, png);
});

test('preview input types are explicit and caller-supplied objects are not coerced into HTML', () => {
  assert.throws(() => referencedHtmlImages({ toString: () => '<img src="private.jpg">' }), /requires text/);
  assert.throws(() => renderHtmlPreview(null), /requires text/);
  assert.throws(() => renderHtmlPreview('<p>Report</p>', null), /requires an object/);
  assert.throws(() => renderHtmlPreview('<p>Report</p>', []), /requires an object/);
});

test('deep and excessively broad documents fail with a bounded error before recursive serialization', () => {
  const deep = '<div>'.repeat(300) + 'Retain source for fallback' + '</div>'.repeat(300);
  const broad = '<span></span>'.repeat(50001);
  for (const source of [deep, broad]) for (const operation of [referencedHtmlImages, renderHtmlPreview]) {
    assert.throws(() => operation(source), error => error.code === 'html_preview_complex' && !(error instanceof RangeError));
  }
  assert.match(renderHtmlPreview('<div>'.repeat(40) + 'Normal nested content' + '</div>'.repeat(40)), /Normal nested content/);
});

test('multi-megabyte image mappings use linear base64 validation without a regex stack overflow', () => {
  const large = 'data:image/png;base64,' + Buffer.alloc(2 * 1024 * 1024, 1).toString('base64');
  const rendered = renderHtmlPreview('<img src="large.png">', { 'large.png': large });
  assert.ok(rendered.includes(large));
  for (const invalid of ['data:image/png;base64,A===', 'data:image/png;base64,AA=A', 'data:image/png;base64,A', large + '!', 'data:text/html;base64,YQ==']) {
    assert.equal(attributes(find(renderHtmlPreview('<img src="invalid.png">', { 'invalid.png': invalid }), 'img')[0]).src, undefined);
  }
});
