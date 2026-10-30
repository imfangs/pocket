import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const paths = new Set(['/', '/api/catalog', '/api/export', '/manifest.webmanifest']);
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const networkErrors = new Set([6, 7, 18, 28, 35, 52, 55, 56]);
const maxBody = 2_000_000;
const maxHeaders = 65_536;
const maxAttempts = 3;

function target(base, path) {
  let url;
  try { url = new URL(base); } catch { throw new Error('Public check requires an absolute URL'); }
  if (url.username || url.password || url.search || url.hash || /[{}]/.test(url.hostname) ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && loopback.has(url.hostname)))
    throw new Error('Public check requires credential-free HTTPS, or loopback HTTP');
  if (!paths.has(path)) throw new Error('Public check path is not allowed');
  return new URL(path, url.origin);
}

// --include preserves actual HTTP headers. CONNECT headers are suppressed;
// interim 1xx blocks are skipped without interpreting the response body as headers.
function responseHead(wire, statusOnly = false) {
  let offset = 0;
  while (offset < wire.length) {
    const lineEnd = wire.indexOf('\n', offset);
    if (lineEnd < 0 || lineEnd > maxHeaders) return null;
    const status = Number(/^HTTP\/\S+ (\d{3})(?:\s|$)/.exec(wire.toString('latin1', offset, lineEnd))?.[1]);
    if (!status) return null;
    if (status >= 200 && statusOnly) return { status };
    const crlf = wire.indexOf('\r\n\r\n', offset), lf = wire.indexOf('\n\n', offset);
    const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf + 4 : lf < 0 ? -1 : lf + 2;
    if (end < 0 || end > maxHeaders) return { status, end: null };
    if (status < 200) { offset = end; continue; }
    const headers = new Headers();
    for (const line of wire.toString('latin1', lineEnd + 1, end).trim().split(/\r?\n/)) {
      if (!line) continue;
      const colon = line.indexOf(':');
      if (colon <= 0) throw new Error('Public check received invalid HTTP headers');
      headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    return { status, headers, end };
  }
  return null;
}

function actualResponse(stdout, bodyLimit) {
  const trailer = stdout.subarray(-4).toString('ascii');
  if (!/^\n\d{3}$/.test(trailer)) throw new Error('Public check received an incomplete HTTP response');
  const wire = stdout.subarray(0, -4);
  let head;
  try { head = responseHead(wire); } catch { throw new Error('Public check received invalid HTTP headers'); }
  if (!head?.end || head.status !== Number(trailer.slice(1)))
    throw new Error('Public check received incomplete or oversized HTTP headers');
  if (head.status >= 300 && head.status < 400)
    throw new Error(`Public check does not follow redirects (HTTP ${head.status})`);
  const body = wire.subarray(head.end);
  if (body.length > bodyLimit) throw new Error('Public check response exceeds the body limit');
  try { return new Response(body.length ? body : null, { status: head.status, headers: head.headers }); }
  catch { throw new Error('Public check received an invalid HTTP response'); }
}

/** The four anonymous verification GETs only; no credentials or redirect hops. */
export async function publicCheckGet(base, path, {
  timeoutMs = 20_000, maxBodyBytes = maxBody, retryDelayMs = 400,
} = {}) {
  const url = target(base, path);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000 ||
      !Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > maxBody ||
      !Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 400)
    throw new Error('Invalid public check limits');
  const args = [
    '--disable', '--globoff', '--silent', '--show-error', '--compressed', '--request', 'GET',
    '--include', '--suppress-connect-headers', '--max-redirs', '0',
    '--connect-timeout', String(Math.min(8_000, timeoutMs) / 1_000),
    '--max-time', String(timeoutMs / 1_000), '--max-filesize', String(maxBodyBytes),
    '--proto', url.protocol === 'https:' ? '=https' : '=http',
    ...(loopback.has(url.hostname) ? ['--noproxy', '*'] : []),
    '--write-out', '\n%{http_code}', '--url', url.href,
  ];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let stdout;
    try {
      ({ stdout } = await execute('curl', args, {
        encoding: 'buffer', timeout: timeoutMs + 1_000,
        maxBuffer: maxBodyBytes + maxHeaders + 4,
      }));
    } catch (error) {
      let observed;
      try { observed = responseHead(error.stdout || Buffer.alloc(0), true)?.status; } catch { /* No parseable status. */ }
      // A received HTTP rejection is not a reason to retry, even if its body
      // was subsequently interrupted. Never expose curl's URL/stderr in errors.
      if (observed >= 300) throw new Error(`Public GET ${path} failed (HTTP ${observed})`);
      if (attempt < maxAttempts && networkErrors.has(error.code)) {
        await delay(retryDelayMs * attempt);
        continue;
      }
      const code = Number.isInteger(error.code) ? `curl ${error.code}` : 'transport unavailable';
      throw new Error(`Public GET ${path} failed (${code}, ${attempt} attempt${attempt === 1 ? '' : 's'})`);
    }
    return actualResponse(stdout, maxBodyBytes);
  }
}
