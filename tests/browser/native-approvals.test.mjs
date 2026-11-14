import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHarness, engines, ids } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const key = 'c'.repeat(64), option = value => String(value).padStart(64, '0');
const request = { key, kind: 'command', cwd: '/synthetic', command: 'git diff --stat', reason: '合成审批', choices: ['accept', 'cancel'],
  approvalOptions: [{ id: option(1), kind: 'accept', scope: 'once' }, { id: option(2), kind: 'acceptForSession', scope: 'session' },
    { id: option(3), kind: 'execpolicy', scope: 'rule', rule: ['git', 'diff', 'a b'] }, { id: option(4), kind: 'cancel', scope: 'once' }] };
const results = [];
after(() => {
  const path = resolve(process.env.POCKET_NATIVE_APPROVAL_REPORT || '.local/qa/native-approvals/browser.json');
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2));
});
function flow(engine, name, options, run) { test(`${engine}: ${name}`, { timeout: 30000 }, () => runScenario({ engine, name,
  create: () => createHarness(engine, options), run, record: result => results.push(result) })); }
function seed(h, requests = [request]) { h.setRuntime(ids.regular, 'waiting_approval'); h.patchHistory(ids.regular, { canSend: false, pendingRequests: requests }); }

for (const engine of engines) {
  flow(engine, 'native option clicks submit only an opaque ID and keep scope review complete on a narrow screen', { width: 320 }, async h => {
    seed(h); const page = await h.open(); const posts = [];
    await page.route(`https://pocket.test/api/tasks/${ids.regular}/requests/${key}/respond`, async route => {
      const body = route.request().postDataJSON(); posts.push(body);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ responseId: body.responseId, status: 'accepted' }) });
    });
    await page.getByRole('button', { name: '本会话内允许', exact: true }).waitFor();
    const card = page.locator('.approval-card');
    assert.ok((await card.textContent()).includes('git diff "a b"'));
    assert.equal(await card.locator('.primary').count(), 1);
    assert.equal(await card.locator('[aria-pressed="true"],input:checked').count(), 0);
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      const geometry = await card.evaluate(node => ({ overflow: node.scrollWidth > node.clientWidth,
        heights: [...node.querySelectorAll('button')].map(button => button.getBoundingClientRect().height) }));
      assert.equal(geometry.overflow, false, JSON.stringify(geometry)); assert.ok(geometry.heights.every(height => height >= 44));
    }
    await page.getByRole('button', { name: '本会话内允许', exact: true }).click();
    await page.getByText('已提交，等待更新', { exact: true }).waitFor();
    assert.equal(posts.length, 1); assert.deepEqual(Object.keys(posts[0]).sort(), ['optionId', 'responseId']);
    assert.equal(posts[0].optionId, option(2)); assert.match(posts[0].responseId, /^[a-f0-9-]{36}$/);
    assert.equal(await page.getByRole('button', { name: '本会话内允许', exact: true }).count(), 0);
  });

  flow(engine, 'an uncertain native approval can only check the original receipt and never replay the option', {}, async h => {
    seed(h); const page = await h.open(); const posts = [], checks = [];
    let acknowledgeRead;
    const receiptRead = new Promise(resolve => { acknowledgeRead = resolve; });
    await page.route(`https://pocket.test/api/tasks/${ids.regular}/requests/${key}/respond`, async route => {
      posts.push(route.request().postDataJSON());
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '合成未知结果' }) });
    });
    await page.route(`https://pocket.test/api/tasks/${ids.regular}/responses/*`, async route => {
      const responseId = route.request().url().split('/').at(-1); checks.push(responseId);
      acknowledgeRead();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ responseId, status: 'unknown' }) });
    });
    await page.getByRole('button', { name: '允许命令前缀', exact: true }).click();
    await page.getByText('结果待核对，不会重复响应', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '允许命令前缀', exact: true }).count(), 0);
    await page.getByRole('button', { name: '核对状态', exact: true }).click();
    await receiptRead;
    assert.equal(posts.length, 1); assert.deepEqual(checks, [posts[0].responseId]);
    assert.equal(posts[0].optionId, option(3));
  });

  flow(engine, 'directory grants remain explicit and another request draft survives an approval', { width: 320 }, async h => {
    const file = { ...request, kind: 'file', command: undefined, details: '/synthetic/src/changed.txt\n+changed',
      approvalOptions: [{ id: option(1), kind: 'accept', scope: 'session', grantRoot: '/synthetic/src' },
        { id: option(2), kind: 'acceptForSession', scope: 'session', grantRoot: '/synthetic/src' }] };
    const question = { key: 'd'.repeat(64), kind: 'questions', reason: '另一条合成问题', cwd: '', choices: [],
      questions: [{ id: 'answer', question: '保留这个回答' }] };
    seed(h, [file, question]); const page = await h.open(); let settle;
    const gate = new Promise(resolve => { settle = resolve; });
    await page.route(`https://pocket.test/api/tasks/${ids.regular}/requests/${key}/respond`, async route => {
      const body = route.request().postDataJSON(); await gate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ responseId: body.responseId, status: 'accepted' }) });
    });
    const answer = page.getByRole('textbox', { name: '保留这个回答', exact: true }); await answer.fill('另一个回答不能被清掉');
    await answer.evaluate(node => { window.nativeAnswerNode = node; });
    assert.equal(await page.getByRole('button', { name: '允许这一次', exact: true }).count(), 0);
    assert.equal(await page.locator('.native-approval-scope-value').getByText('/synthetic/src', { exact: true }).count(), 2);
    await page.getByRole('button', { name: '允许目录授权', exact: true }).click();
    settle();
    await page.getByText('已提交，等待更新', { exact: true }).waitFor();
    assert.equal(await answer.inputValue(), '另一个回答不能被清掉');
    assert.equal(await answer.evaluate(node => node === window.nativeAnswerNode), true);
    await answer.focus();
    assert.equal(await answer.evaluate(node => node === document.activeElement), true);
  });
}
