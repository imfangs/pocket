import { gzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { READ_VERSION_HEADER, readResponseKind, splitReadResponse } from '../shared/read-response.mjs';

export function readResponseVersion(data, { path, method = 'GET', machineId }) {
  const kind = readResponseKind(path, method);
  if (!kind) return null;
  const { content, observationKeys, headers } = splitReadResponse(kind, data);
  // Include presence as well as the content projection: losing an observation
  // field must not preserve a cached value from the preceding response.
  const digest = createHash('sha256').update(JSON.stringify([
    'pocket-read-v1', machineId, method, path, observationKeys, content,
  ])).digest('hex');
  return { etag: `W/"pocket-read-v1-${digest}"`, headers };
}

function matchesVersion(header, etag) {
  if (typeof header !== 'string') return false;
  const expected = etag.slice(2);
  return header.trim() === '*' || header.split(',').some(value => value.trim().replace(/^W\//, '') === expected);
}

function acceptsGzip(header) {
  if (typeof header !== 'string') return false;
  const qualities = new Map();
  for (const item of header.split(',')) {
    const [encoding, ...params] = item.trim().toLowerCase().split(';').map(s => s.trim());
    const q = params.find(p => p.startsWith('q='));
    qualities.set(encoding, q === undefined ? 1 : /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q) ? Number(q.slice(2)) : 0);
  }
  const quality = qualities.get('gzip') ?? qualities.get('*') ?? 0;
  return quality > 0 && (qualities.get('identity') === undefined || quality >= qualities.get('identity'));
}

// Compress before the Mac-to-Tunnel hop. Private data still remains no-store.
export function sendCatalog(res, data, acceptEncoding, request) {
  const version = request && readResponseVersion(data, request);
  if (version) {
    res.setHeader('ETag', version.etag);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Cache-Control', 'no-store');
    for (const [key, value] of Object.entries(version.headers)) res.setHeader(key, value);
    const unchanged = request.method === 'POST'
      ? request.headers?.[READ_VERSION_HEADER.toLowerCase()] === version.etag
      : matchesVersion(request.headers?.['if-none-match'], version.etag);
    if (unchanged) {
      // POST sync retains its refresh/CSRF semantics. Its explicit private
      // read-version protocol uses 204; HTTP 304 is reserved for GET/HEAD.
      res.writeHead(request.method === 'POST' ? 204 : 304);
      return res.end();
    }
  }
  const plain = Buffer.from(JSON.stringify(data));
  const finish = (body, compressed = false) => {
    if (res.destroyed) return;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': body.length,
      Vary: 'Accept-Encoding',
      ...(compressed ? { 'Content-Encoding': 'gzip' } : {}),
    });
    res.end(body);
  };
  if (plain.length < 1024 || !acceptsGzip(acceptEncoding)) return finish(plain);
  gzip(plain, (error, body) => {
    if (error || body.length >= plain.length) finish(plain);
    else finish(body, true);
  });
}
