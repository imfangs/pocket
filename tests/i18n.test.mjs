import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { normalizeLanguagePreference, resolveLanguage, createLanguageStore, languageStore } from '../src/languagePreference.ts';
import { t, currentLocale, formatDate } from '../src/i18nCore.ts';
import { messageTime } from '../src/messageTime.ts';
import { readableCodexMarkdown } from '../src/codexMarkup.ts';
import { presentUserMessage } from '../src/userMessage.ts';
import { readableQuestionReply } from '../src/questionReply.ts';
import { readableRequestError } from '../src/requestError.ts';

afterEach(() => languageStore.setPreference('system'));

test('system language negotiation honors preference order and uses English for unsupported languages', () => {
  for (const [languages, expected] of [
    [['zh-CN'], 'zh-CN'], [['zh-Hant-TW'], 'zh-CN'], [['en-GB', 'zh'], 'en'],
    [['fr-FR', 'en'], 'en'], [['fr', 'zh'], 'zh-CN'], [['fr-FR'], 'en'], [[], 'en'],
  ]) assert.equal(resolveLanguage('system', languages), expected);
  assert.equal(resolveLanguage('en', ['zh-CN']), 'en');
  assert.equal(resolveLanguage('zh-CN', ['en-US']), 'zh-CN');
  for (const value of [null, undefined, 'auto', 'fr', '{}']) assert.equal(normalizeLanguagePreference(value), 'system');
});

test('language storage and live system updates have distinct ownership and clean subscriptions', () => {
  let saved = null, languages = ['en-US'], external, subscriptions = 0, cleanups = 0, updates = 0;
  const store = createLanguageStore({ read: () => saved, write: value => { saved = value; }, languages: () => languages,
    listen: notify => { external = notify; subscriptions++; return () => { cleanups++; }; } });
  const one = store.subscribe(() => updates++), two = store.subscribe(() => updates++);
  assert.equal(subscriptions, 1);
  assert.equal(store.getPreference(), 'system'); assert.equal(store.getLocale(), 'en');
  languages = ['zh-CN']; external('system'); assert.equal(store.getLocale(), 'zh-CN');
  store.setPreference('en'); assert.equal(saved, 'en');
  languages = ['zh-Hant']; external('system'); assert.equal(store.getLocale(), 'en');
  saved = 'zh-CN'; external('storage'); assert.equal(store.getLocale(), 'zh-CN');
  saved = null; external('storage'); assert.equal(store.getPreference(), 'system');
  assert.equal(updates, 8);
  one(); assert.equal(cleanups, 0); two(); assert.equal(cleanups, 1);
});

test('blocked local storage still allows a session choice without a later system event clearing it', () => {
  let external;
  const store = createLanguageStore({ read: () => { throw new Error('blocked'); }, write: () => { throw new Error('blocked'); },
    languages: () => ['zh-CN'], listen: notify => { external = notify; return () => {}; } });
  const stop = store.subscribe(() => {});
  store.setPreference('en'); external('system');
  assert.equal(store.getPreference(), 'en'); assert.equal(store.getLocale(), 'en'); stop();
});

test('all English catalogs agree on shared messages and preserve every interpolation', () => {
  const merged = new Map();
  const placeholders = value => [...value.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).sort();
  for (const name of readdirSync(new URL('../src/locales/en/', import.meta.url))) {
    const messages = JSON.parse(readFileSync(new URL(`../src/locales/en/${name}`, import.meta.url)));
    for (const [key, value] of Object.entries(messages)) {
      assert.ok(value.trim(), `${name}: ${key} is blank`);
      assert.deepEqual(placeholders(value), placeholders(key), `${name}: ${key} placeholders`);
      if (merged.has(key)) assert.equal(value, merged.get(key), `Conflicting translation: ${key}`);
      merged.set(key, value);
    }
  }
  assert.ok(merged.size > 800);
});

test('relative time, interpolation and date format change together while ISO timestamps stay fixed', () => {
  const now = new Date(2026, 10, 4, 12, 0).getTime();
  languageStore.setPreference('en'); assert.equal(currentLocale(), 'en');
  assert.equal(messageTime(now - 60_000, now).label, '1 minute ago');
  assert.equal(messageTime(now - 120_000, now).label, '2 minutes ago');
  assert.equal(t('消息时间：{{time}}', { time: '12:00' }), 'Message time: 12:00');
  const iso = messageTime(now, now).dateTime;
  const english = formatDate(now, { month: 'long', day: 'numeric' });
  languageStore.setPreference('zh-CN');
  assert.equal(messageTime(now - 60_000, now).label, '1分钟前');
  assert.equal(messageTime(now, now).dateTime, iso);
  assert.notEqual(formatDate(now, { month: 'long', day: 'numeric' }), english);
});

test('only generated envelopes localize: authored messages, questions and code remain exact', () => {
  languageStore.setPreference('en');
  for (const source of ['设置', '当前离线，联网后会恢复。', '打开任务', '```text\n:codex-annotation{index="1"}\n```']) {
    assert.equal(presentUserMessage(source, t).text, source);
    assert.equal(readableCodexMarkdown(source, t), source);
  }
  assert.equal(readableCodexMarkdown(':codex-annotation{index="1"}', t), '[Annotation 1]');
  const response = '<send_user_message_question_reply>\n' + JSON.stringify([{ question: '设置', answer: '未读', questionItemId: 'id' }]) + '\n</send_user_message_question_reply>';
  assert.equal(readableQuestionReply(response, t), 'Answer: 设置\n\n未读');
  // This source text still participates in network-kind/control decisions.
  assert.equal(readableRequestError(new Error('Failed to fetch')), '连接暂时中断，请重试。');
  assert.equal(t(readableRequestError(new Error('Failed to fetch'))), 'The connection was interrupted. Please retry.');
});

test('the public boot and offline shell use the same language negotiation before React', () => {
  const script = readFileSync(new URL('../public/language.js', import.meta.url), 'utf8');
  for (const languages of [['zh-Hant'], ['en-GB'], ['fr'], ['fr', 'zh']]) for (const saved of [null, 'en', 'zh-CN', 'invalid']) {
    const root = {}, boot = {}, title = {}, listeners = {};
    runInNewContext(script, { navigator: { languages, language: languages[0] }, localStorage: { getItem: () => saved },
      window: { addEventListener: (name, callback) => { listeners[name] = callback; } },
      document: { documentElement: root, getElementById: () => ({ setAttribute: (name, value) => { boot[name] = value; } }),
        querySelectorAll: () => [{ getAttribute: () => 'offlineTitle', set textContent(value) { title.text = value; } }],
        querySelector: () => null, addEventListener: (name, callback) => { listeners[name] = callback; } } });
    assert.equal(root.lang, resolveLanguage(normalizeLanguagePreference(saved), languages));
    assert.equal(boot['aria-label'], root.lang === 'en' ? 'Opening Pocket' : '正在打开 Pocket');
    assert.equal(title.text, root.lang === 'en' ? 'Unable to connect' : '暂时无法连接');
    const opposite = root.lang === 'en' ? 'zh-CN' : 'en';
    listeners['pocket-language-changed']({ detail: opposite });
    assert.equal(root.lang, opposite);
    assert.equal(title.text, opposite === 'en' ? 'Unable to connect' : '暂时无法连接');
  }
});
