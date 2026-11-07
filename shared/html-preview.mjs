import { parse, serialize } from 'parse5';
import { maxInteractiveHtmlChars } from './html-runtime-policy.mjs';

const htmlNamespace = 'http://www.w3.org/1999/xhtml';
const svgNamespace = 'http://www.w3.org/2000/svg';
export const htmlPreviewPolicy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const removedElements = new Set([
  'script', 'base', 'link', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal', 'fencedframe',
  'animate', 'animatemotion', 'animatetransform', 'set', 'discard',
]);
const removedAttributes = new Set([
  'src', 'srcset', 'imagesrcset', 'imagesizes', 'poster', 'data', 'code', 'codebase', 'archive',
  'href', 'action', 'formaction', 'formtarget', 'target', 'ping', 'download', 'background', 'longdesc',
  'cite', 'profile', 'usemap', 'autofocus', 'autoplay', 'contenteditable', 'draggable', 'shadowrootmode',
]);
const formControls = new Set(['button', 'input', 'select', 'textarea', 'option', 'optgroup', 'fieldset']);
const attr = (node, name) => node.attrs?.find(attribute => !attribute.namespace && attribute.name.toLowerCase() === name)?.value;

function documentFor(html, scriptingEnabled = false) {
  if (typeof html !== 'string') throw new TypeError('HTML preview requires text');
  // Match the no-script iframe's noscript parsing, including malformed input.
  const document = parse(html, { scriptingEnabled }), pending = [{ node: document, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const { node, depth } = pending.pop();
    if (++visited > 50000 || depth > 256) {
      const error = new Error('HTML preview structure is too complex.');
      error.code = 'html_preview_complex';
      throw error;
    }
    if (node.content) pending.push({ node: node.content, depth: depth + 1 });
    for (const child of node.childNodes ?? []) pending.push({ node: child, depth: depth + 1 });
  }
  return document;
}

function relativeImageSource(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f\ufffd\\]/.test(value)) return false;
  const source = value.trim();
  return !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(source);
}

/** Candidate references only. The server independently checks path, bytes,
 *  identity, scope and budgets; this parser never grants filesystem access. */
export function referencedHtmlImages(html) {
  const found = new Set(), pending = [documentFor(html)];
  while (pending.length) {
    const node = pending.pop();
    if (node.namespaceURI === htmlNamespace && node.tagName === 'template') continue;
    if (node.namespaceURI === htmlNamespace && node.tagName === 'img') {
      const source = attr(node, 'src');
      if (relativeImageSource(source)) found.add(source);
    }
    // Reverse to retain the source's document order in the returned manifest.
    for (let index = (node.childNodes?.length ?? 0) - 1; index >= 0; index--) pending.push(node.childNodes[index]);
  }
  return [...found];
}

function rasterDataUri(value) {
  if (typeof value !== 'string') return null;
  // SVG, HTML, blob and external URLs are deliberately not image transports.
  const header = /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,/i.exec(value);
  if (!header) return null;
  const bytes = value.slice(header[0].length);
  return bytes.length > 0 && bytes.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(bytes) ? value : null;
}

function fragmentLink(node) {
  if (node.tagName !== 'a' && node.tagName !== 'area') return null;
  if (node.namespaceURI !== htmlNamespace && node.namespaceURI !== svgNamespace) return null;
  const source = node.attrs?.find(attribute => attribute.name.toLowerCase() === 'href')?.value;
  if (!source?.startsWith('#') || /[\u0000-\u001f\u007f]/.test(source)) return null;
  // A bare #fragment in srcdoc resolves against Pocket's inherited base URL.
  return 'about:srcdoc' + source;
}

function cleanElement(node, images) {
  const isImage = node.namespaceURI === htmlNamespace && node.tagName === 'img';
  const source = isImage ? attr(node, 'src') : null;
  const image = source && Object.prototype.hasOwnProperty.call(images, source) ? rasterDataUri(images[source]) : rasterDataUri(source);
  const fragment = fragmentLink(node);
  node.attrs = (node.attrs ?? []).filter(attribute => {
    const name = attribute.name.toLowerCase();
    return !name.startsWith('on') && !removedAttributes.has(name);
  });
  if (isImage && image) node.attrs.push({ name: 'src', value: image });
  if (fragment) node.attrs.push({ name: 'href', value: fragment });
  if (node.namespaceURI === htmlNamespace && formControls.has(node.tagName)) {
    node.attrs = node.attrs.filter(attribute => !['disabled', 'aria-disabled'].includes(attribute.name.toLowerCase()));
    node.attrs.push({ name: 'disabled', value: '' }, { name: 'aria-disabled', value: 'true' });
  }
}

/** Build a static document for an empty-permission sandboxed srcdoc iframe.
 *  No scripts, navigation or unapproved resources inherit Pocket authority. */
export function renderHtmlPreview(html, images = {}) {
  if (!images || typeof images !== 'object' || Array.isArray(images)) throw new TypeError('HTML preview image map requires an object');
  const document = documentFor(html), pending = [document];
  while (pending.length) {
    const parent = pending.pop(), kept = [];
    for (const node of parent.childNodes ?? []) {
      if (node.tagName && (removedElements.has(node.tagName.toLowerCase()) ||
          node.tagName.toLowerCase() === 'meta' && attr(node, 'http-equiv') !== undefined)) continue;
      if (node.tagName) cleanElement(node, images);
      kept.push(node);
      if (node.content) pending.push(node.content);
      if (node.childNodes?.length) pending.push(node);
    }
    parent.childNodes = kept;
  }
  const root = document.childNodes.find(node => node.tagName === 'html');
  const head = root.childNodes.find(node => node.tagName === 'head');
  head.childNodes.unshift({ nodeName: 'meta', tagName: 'meta', namespaceURI: htmlNamespace,
    attrs: [{ name: 'http-equiv', value: 'Content-Security-Policy' }, { name: 'content', value: htmlPreviewPolicy }],
    childNodes: [], parentNode: head });
  document.childNodes = document.childNodes.filter(node => node.nodeName !== '#documentType');
  return '<!doctype html>\n' + serialize(document);
}

/** A normal document for the opaque HTTP preview runtime. Keep authored
 *  scripts, events and controls; file access remains owned by the Mac reader. */
export function renderInteractiveHtmlPreview(html, images = {}) {
  if (!images || typeof images !== 'object' || Array.isArray(images)) throw new TypeError('HTML preview image map requires an object');
  const document = documentFor(html, true), pending = [document];
  while (pending.length) {
    const parent = pending.pop(), kept = [];
    for (const node of parent.childNodes ?? []) {
      // The runtime supplies the preview policy. Refresh would replace this
      // client-only document with a public shell rather than reload its file.
      const equivalent = node.tagName === 'meta' ? attr(node, 'http-equiv')?.toLowerCase() : null;
      if (equivalent === 'content-security-policy' || equivalent === 'refresh') continue;
      for (const attribute of node.attrs ?? []) {
        if (['target', 'formtarget'].includes(attribute.name.toLowerCase()) &&
            ['_top', '_parent'].includes(attribute.value.toLowerCase())) attribute.value = '_blank';
      }
      if (node.namespaceURI === htmlNamespace && node.tagName === 'img') {
        const source = attr(node, 'src');
        const approved = source && Object.prototype.hasOwnProperty.call(images, source) ? rasterDataUri(images[source]) : null;
        if (approved) {
          node.attrs = node.attrs.filter(attribute => !['src', 'srcset'].includes(attribute.name.toLowerCase()));
          node.attrs.push({ name: 'src', value: approved });
        }
      }
      kept.push(node);
      if (node.content) pending.push(node.content);
      if (node.childNodes?.length) pending.push(node);
    }
    parent.childNodes = kept;
  }
  document.childNodes = document.childNodes.filter(node => node.nodeName !== '#documentType');
  const rendered = '<!doctype html>\n' + serialize(document);
  if (rendered.length > maxInteractiveHtmlChars) {
    const error = new Error('HTML preview structure is too complex.');
    error.code = 'html_preview_complex';
    throw error;
  }
  return rendered;
}
