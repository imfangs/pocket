import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { parseFragment } from 'parse5';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
  esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
const [{ default: Sidebar }, { setLanguagePreference }] = await Promise.all([
  vite.ssrLoadModule('/src/Sidebar.tsx'), vite.ssrLoadModule('/src/i18n.ts'),
]);
after(async () => { setLanguagePreference('system'); await vite.close(); });

const attr = (node, name) => node.attrs?.find(item => item.name === name)?.value;
const hasClass = (node, name) => (attr(node, 'class') || '').split(/\s+/).includes(name);
const descendants = node => (node.childNodes || []).flatMap(child => [child, ...descendants(child)]);
const text = node => node.nodeName === '#text' ? node.value : (node.childNodes || []).map(text).join('');
const noop = () => {};
const catalog = {
  threads: [
    { id: 'active', projectId: 'project-a', archived: false, pocketPriority: true, codexPinned: true },
    { id: 'archived', projectId: 'project-a', archived: true },
  ],
  projects: [{ id: 'project-a', name: 'Synthetic project', paths: ['/synthetic'], order: 0, separator: false }],
  groups: [],
};
function render({ language, narrow = false, view = 'all', project = '' }) {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: narrow });
  setLanguagePreference(language);
  try {
    return parseFragment(renderToStaticMarkup(createElement(Sidebar, {
      catalog, view, project, mobileOpen: narrow, onView: noop, onProject: noop, onClose: noop, onSettings: noop,
    })));
  } finally { globalThis.matchMedia = previous; }
}

test('archive belongs to the conversation categories and the footer contains only the named settings action', () => {
  for (const [language, labels] of [
    ['zh', { nav: '会话视图', archive: '已归档', settings: '设置' }],
    ['en', { nav: 'Conversation views', archive: 'Archived', settings: 'Settings' }],
  ]) for (const narrow of [false, true]) {
    const nodes = descendants(render({ language, narrow }));
    const nav = nodes.find(node => node.tagName === 'nav' && attr(node, 'aria-label') === labels.nav);
    assert.ok(nav, `${language}: category navigation`);
    const buttons = descendants(nav).filter(node => node.tagName === 'button');
    assert.deepEqual(buttons.map(node => attr(node, 'data-view')), ['all', 'priority', 'codex-pinned', 'hidden', 'archived']);
    const archive = buttons.at(-1);
    assert.equal(attr(archive, 'aria-label'), labels.archive);
    assert.equal(text(archive), labels.archive);
    assert.equal(descendants(archive).filter(node => node.tagName === 'small').length, 0, 'Archive has no count');
    const footer = nodes.find(node => hasClass(node, 'sidebar-bottom'));
    const footerButtons = descendants(footer).filter(node => node.tagName === 'button');
    assert.equal(footerButtons.length, 1);
    assert.equal(attr(footerButtons[0], 'aria-label'), labels.settings);
    assert.equal(text(footerButtons[0]), labels.settings);
    assert.equal(attr(footerButtons[0], 'type'), 'button');
    assert.ok(hasClass(footerButtons[0], 'sidebar-settings'));
    assert.ok(hasClass(footerButtons[0], 'nav-item'));
  }
});

test('archive is the sole current destination with a stale project selection in either language', () => {
  for (const language of ['zh', 'en']) {
    const nodes = descendants(render({ language, view: 'archived', project: 'project-a' }));
    const current = nodes.filter(node => attr(node, 'aria-current') === 'page');
    assert.equal(current.length, 1);
    assert.equal(attr(current[0], 'data-view'), 'archived');
    assert.ok(hasClass(current[0], 'selected'));
    assert.deepEqual(nodes.filter(node => hasClass(node, 'selected')), current);
  }
});
