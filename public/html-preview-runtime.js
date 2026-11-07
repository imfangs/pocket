(() => {
  const nonce = location.hash.slice(1);
  if (parent === window || !/^[a-f0-9]{32}$/i.test(nonce)) return;
  const previewParent = parent;
  const parentOrigin = new URL(location.href).origin;
  const defer = window.setTimeout.bind(window);
  let initialized = false;
  const initialize = event => {
    const data = event.data;
    if (initialized || event.source !== previewParent || event.origin !== parentOrigin ||
        !data || data.type !== 'pocket-html-preview-init' || data.nonce !== nonce ||
        typeof data.html !== 'string' || data.html.length > 16 * 1024 * 1024) return;
    initialized = true;
    window.removeEventListener('message', initialize);
    // Only this opaque document receives the authenticated file projection.
    // It is not inserted into Pocket's DOM or sent to a server.
    document.open();
    document.write(data.html);
    document.close();
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const hadAuthorDialog = !!document.querySelector('dialog[open]') || event.composedPath().some(node => node.matches?.('dialog[open]'));
      if (hadAuthorDialog) return;
      // Let all author document/window handlers run before deciding. An open
      // author dialog owns its first Escape, including its native cancel.
      defer(() => {
        if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || document.querySelector('dialog[open]')) return;
        previewParent.postMessage({ type: 'pocket-html-preview-close', nonce }, parentOrigin);
      }, 0);
    });
  };
  window.addEventListener('message', initialize);
  previewParent.postMessage({ type: 'pocket-html-preview-ready', nonce }, parentOrigin);
})();
