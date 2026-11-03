import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
  esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const [{ default: Models }, { default: Markdown }, { setLanguagePreference }] = await Promise.all([
  vite.ssrLoadModule('/src/ThreadModelSettings.tsx'), vite.ssrLoadModule('/src/MessageMarkdown.tsx'), vite.ssrLoadModule('/src/i18n.ts'),
]);
after(async () => { setLanguagePreference('system'); await vite.close(); });

test('English model settings localize missing values and preserve custom names that match UI text', () => {
  setLanguagePreference('en');
  const render = savedModelSettings => renderToStaticMarkup(createElement(Models, {
    thread: { id: 'i18n-model', savedModelSettings }, onConnect: async () => {},
  }));
  assert.match(render({ model: '暂未读取', effort: null }), />暂未读取<\/span>/);
  assert.match(render({ model: null, effort: 'high' }), />Model not specified · High<\/span>/);
  assert.match(render({ model: null, effort: null }), />Not loaded<\/span>/);
  assert.match(render({ model: 'gpt-6-astra', effort: 'ultra' }), /GPT-6 Astra · Ultra/);
});

test('the rendered message component preserves Chinese prose and localizes only known Codex controls', () => {
  setLanguagePreference('en');
  const render = (text, codex) => renderToStaticMarkup(createElement(Markdown, { text, codex }));
  assert.match(render('设置', false), /<p>设置<\/p>/);
  assert.match(render('设置', true), /<p>设置<\/p>/);
  assert.match(render(':codex-annotation{index="2"}', true), /Annotation 2/);
});
