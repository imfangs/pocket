import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { createQuestionPresentationStore } from '../src/questionPresentation.ts';

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {} } });
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { default: QuestionPrompts } = await vite.ssrLoadModule('/src/QuestionPrompts.tsx');
after(() => vite.close());
const question = { key: 'a'.repeat(64), sourceMessageId: 'message', title: '先做一个可体验的原型，还是先整理资料后再决定？', options: ['先做原型', '先整理资料'] };
const render = props => renderToStaticMarkup(createElement(QuestionPrompts, { threadId: 'thread', questions: [question], disabled: false, drafts: new Map(), refresh: async () => {}, ...props }));

test('a new question with choices exposes one interactive set of options without preselecting or submitting', () => {
  const sourceText = [question.title, ...question.options.map(option => `- ${option}`)].join('\n');
  const html = render({ sourceText });
  assert.match(html, /先做一个可体验的原型，还是先整理资料后再决定？/);
  assert.equal((html.match(/type="radio"/g) || []).length, 2);
  assert.doesNotMatch(html, /checked=""|class="question-source-text"/);
  const labels = [...html.matchAll(/class="question-option"[\s\S]*?<span>([^<]*)<\/span>/g)].map(match => match[1]);
  assert.deepEqual(labels, question.options);
  assert.match(html, /<button type="submit" class="primary" disabled="">提交回答<\/button>/);
  assert.match(html, />自己填写<\/button>/); assert.match(html, />忽略<\/button>/);
});

test('a text-only question keeps the light answer and ignore entry until the user opens it', () => {
  const html = render({ questions: [{ ...question, options: [] }] });
  assert.match(html, />回答<\/button>/); assert.match(html, />忽略<\/button>/);
  assert.doesNotMatch(html, /type="radio"|<textarea|提交回答/);
});

test('a preserved answer draft expands the form and remains editable before any submission', () => {
  const drafts = new Map([[`thread/question/${question.key}`, { text: 'A preserved written answer', answerMode: 'custom' }]]);
  const html = render({ drafts });
  assert.match(html, /data-question-state="answering"/);
  assert.match(html, />A preserved written answer<\/textarea>/);
  assert.match(html, />提交回答<\/button>/);
  assert.doesNotMatch(html.match(/<textarea[^>]*>/)[0], /disabled/);
});

test('an ignored question stays compact with a reopen action and clearly retained draft', () => {
  const store = createQuestionPresentationStore({ getItem: () => null, setItem() {} });
  store.setIgnored('thread', question.key, true);
  const saved = { text: 'Keep my answer', customText: 'Hidden answer', answerMode: 'custom' };
  const drafts = new Map([[`thread/question/${question.key}`, saved]]);
  const html = render({ drafts, presentationStore: store });
  assert.match(html, /data-question-state="ignored"/);
  assert.match(html, /已忽略/); assert.match(html, /答案草稿已保留/); assert.match(html, />回答<\/button>/);
  assert.doesNotMatch(html, /<textarea|type="radio"|提交回答/);
  assert.equal(drafts.get(`thread/question/${question.key}`), saved);
});

test('pending or unknown answer receipts force the form open and make ignore unavailable', () => {
  const store = createQuestionPresentationStore({ getItem: () => null, setItem() {} });
  store.setIgnored('thread', question.key, true);
  for (const status of ['pending', 'unknown', 'accepted']) {
    const html = render({ presentationStore: store, questions: [{ ...question, response: { requestId: 'original-response', status } }] });
    assert.match(html, /data-question-state="pending"/);
    assert.match(html, /核对回答状态/);
    assert.match(html, /class="question-ignore" disabled/);
    assert.doesNotMatch(html, /已忽略/);
  }
});

test('surrounding source explanation is rendered and strictly duplicated question text is omitted', () => {
  const sourceText = `This optional question does not stop the work.\n\n${question.title}`;
  const html = render({ sourceText });
  assert.match(html, /This optional question does not stop the work/);
  assert.match(html, /class="question-source-text"/);
  const exact = render({ sourceText: question.title });
  assert.doesNotMatch(exact, /class="question-source-text"/);
});

test('a remounted view sees a shared in-flight answer even if its component busy flag is new', () => {
  const store = createQuestionPresentationStore({ getItem: () => null, setItem() {} });
  const finish = store.beginAnswerPost('thread', question.key, 'original-request');
  const html = render({ presentationStore: store });
  assert.match(html, /data-question-state="pending"/);
  assert.match(html, /核对回答状态/);
  assert.match(html, /class="question-ignore" disabled/);
  finish();
});

test('local source images and truncation remain visible even when the title repeats the source text', () => {
  const imagePath = '/tmp/question-diagram.png';
  const route = `/api/tasks/aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa/images/${'b'.repeat(64)}`;
  const imageQuestion = { ...question, title: `![Diagram](${imagePath})` };
  const html = render({ questions: [imageQuestion], sourceText: imageQuestion.title, sourceImages: { [imagePath]: route }, sourceTruncated: true });
  assert.match(html, /class="question-source-text"/);
  assert.ok(html.includes(`<img src="${route}"`));
  assert.match(html, /内容较长，此处已截取。/);
});
