export const htmlPreviewShellPath = '/html-preview-shell.html';
export const htmlPreviewShellAlias = '/html-preview-shell';
export const htmlPreviewRuntimePath = '/html-preview-runtime.js';
export const htmlPreviewSandbox = 'allow-scripts allow-forms allow-downloads allow-popups';
export const htmlPreviewNoncePattern = /^[a-f0-9]{32}$/i;
export const maxInteractiveHtmlChars = 16 * 1024 * 1024;

// The isolated HTTP document has its own policy. Pocket's document keeps its
// script-src 'self' policy; ordinary HTTPS web resources are allowed here.
export const interactiveHtmlPolicy = "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src https:; frame-src https:; object-src 'none'; base-uri 'none'; form-action https:; frame-ancestors 'self'; sandbox allow-scripts allow-forms allow-downloads allow-popups";
