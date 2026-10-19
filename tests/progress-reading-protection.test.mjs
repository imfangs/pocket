import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { isMessageReadingProtected } = await vite.ssrLoadModule('/src/useProgressMessages.ts');
after(() => vite.close());

function fixture() {
  const visible = new Map(), inside = new Set();
  let selected = false;
  const document = {
    activeElement: null,
    querySelector: selector => selector.split(',').map(part => visible.get(part.trim())).find(Boolean) ?? null,
    getSelection: () => ({ isCollapsed: !selected, rangeCount: selected ? 1 : 0,
      getRangeAt: () => ({ intersectsNode: node => node === root }) }),
  };
  const root = { ownerDocument: document, contains: node => inside.has(node) };
  return { document, root, visible, inside, select: value => { selected = value; } };
}

test('a portal viewer protects its underlying process even with focus outside the message region', () => {
  for (const selector of ['dialog[open]', '[data-reading-overlay]']) {
    const f = fixture(), closeButton = {};
    f.document.activeElement = closeButton;
    assert.equal(isMessageReadingProtected(f.root), false);
    f.visible.set(selector, {});
    assert.equal(isMessageReadingProtected(f.root), true, selector);
    f.visible.delete(selector);
    assert.equal(isMessageReadingProtected(f.root), false, 'closing releases protection at the next visibility event');
  }
});

test('closing a viewer preserves an existing reader focus or selection hold', () => {
  const f = fixture(), opener = {};
  f.inside.add(opener);
  f.visible.set('[data-reading-overlay]', {});
  assert.equal(isMessageReadingProtected(f.root), true);
  f.document.activeElement = opener;
  f.visible.clear();
  assert.equal(isMessageReadingProtected(f.root), true, 'the restored message trigger is still in use');
  f.document.activeElement = f.root;
  f.select(true);
  assert.equal(isMessageReadingProtected(f.root), true);
  f.select(false);
  assert.equal(isMessageReadingProtected(f.root), false);
});

test('motion holds retain their previous behavior and a missing region is not protected', () => {
  const f = fixture();
  f.visible.set('[data-reading-motion]', {});
  assert.equal(isMessageReadingProtected(f.root), true);
  f.visible.clear();
  assert.equal(isMessageReadingProtected(f.root), false);
  assert.equal(isMessageReadingProtected(null), false);
});
