import { gzip } from 'node:zlib';

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
export function sendCatalog(res, data, acceptEncoding) {
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
