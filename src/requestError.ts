// Presentation only: callers retain the original Error/status/code for receipt
// classification and cancellation. WebKit uses different network messages.
function messageOf(value: unknown) {
  return typeof value === 'string' ? value : value && typeof value === 'object' && 'message' in value
    && typeof value.message === 'string' ? value.message : '';
}
function kind(value: unknown) {
  const message = messageOf(value), name = value && typeof value === 'object' && 'name' in value ? value.name : '';
  if (name === 'TimeoutError' || /timeout|timed out|连接(?:\s+Mac)?\s*较慢|读取较慢|读取超时/i.test(message)) return 'slow';
  if (/^offline$|当前离线|网络未连接/i.test(message)) return 'offline';
  if (name === 'AbortError' || /failed to fetch|fetch failed|load failed|fetch is aborted|networkerror|network request failed|network connection|operation (?:was )?aborted|连接(?:暂时)?中断|连接失败|网络(?:连接)?异常|Mac 暂时不可达/i.test(message)) return 'network';
  return null;
}
export function isNetworkError(value: unknown) { return kind(value) !== null; }
export function readableRequestError(value: unknown, fallback = '操作未完成，请稍后重试。') {
  switch (kind(value)) {
    case 'slow': return '连接较慢，请重试。';
    case 'offline': return '当前离线，联网后会恢复。';
    case 'network': return '连接暂时中断，请重试。';
    default: { const text = messageOf(value); return /[\u3400-\u9fff]/.test(text) ? text : fallback; }
  }
}
