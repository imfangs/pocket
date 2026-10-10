import test from 'node:test';
import assert from 'node:assert/strict';
import { createPwaInstallController } from '../src/pwaInstallController.ts';

function fixture() {
  const browser = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: false }), navigator: {} });
  const controller = createPwaInstallController(browser);
  return { browser, controller };
}
function promptEvent(prompt, userChoice = Promise.resolve({ outcome: 'accepted' })) {
  return Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt, userChoice });
}

test('AccessGate can capture an install event before Settings or any install button subscribes and consume it later', async () => {
  const { browser, controller } = fixture(); let prompts = 0;
  controller.start();
  const event = promptEvent(async () => { prompts++; });
  browser.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(controller.getSnapshot().canPrompt, true);
  let settingsUpdates = 0;
  const closeSettings = controller.subscribe(() => { settingsUpdates++; });
  assert.equal(await controller.install(), 'accepted');
  assert.equal(prompts, 1); assert.equal(controller.getSnapshot().installed, true);
  assert.equal(controller.getSnapshot().canPrompt, false); assert.ok(settingsUpdates > 0);
  closeSettings(); controller.stop();
});

test('closing Settings or switching login views does not drop the page-owned event', async () => {
  const { browser, controller } = fixture(); let prompts = 0;
  controller.start();
  const loginView = controller.subscribe(() => {});
  browser.dispatchEvent(promptEvent(async () => { prompts++; }, Promise.resolve({ outcome: 'dismissed' })));
  loginView();
  assert.equal(controller.getSnapshot().canPrompt, true);
  const settingsView = controller.subscribe(() => {});
  assert.equal(await controller.install(), 'dismissed');
  assert.equal(prompts, 1); assert.equal(controller.getSnapshot().canPrompt, false);
  assert.equal(await controller.install(), 'unavailable');
  settingsView(); controller.stop();
});

test('an appinstalled event is retained while the install UI is absent', () => {
  const { browser, controller } = fixture(); controller.start();
  browser.dispatchEvent(new Event('appinstalled'));
  assert.equal(controller.getSnapshot().installed, true);
  assert.equal(controller.getSnapshot().canPrompt, false);
  controller.stop();
});

test('the one-shot event is claimed synchronously so repeated clicks cannot prompt twice', async () => {
  const { browser, controller } = fixture(); let prompts = 0, choose;
  controller.start();
  browser.dispatchEvent(promptEvent(async () => { prompts++; }, new Promise(resolve => { choose = resolve; })));
  const first = controller.install();
  assert.equal(controller.getSnapshot().busy, true); assert.equal(controller.getSnapshot().canPrompt, false);
  assert.equal(await controller.install(), 'busy');
  choose({ outcome: 'accepted' }); assert.equal(await first, 'accepted');
  assert.equal(prompts, 1); assert.equal(controller.getSnapshot().busy, false);
  controller.stop();
});

test('a rejected prompt is consumed, releases busy state and allows the manual guide fallback', async () => {
  const { browser, controller } = fixture(); controller.start();
  browser.dispatchEvent(promptEvent(async () => { throw new Error('expired prompt'); }));
  assert.equal(await controller.install(), 'failed');
  assert.deepEqual(controller.getSnapshot(), { installed: false, canPrompt: false, busy: false });
  assert.equal(await controller.install(), 'unavailable');
  controller.stop();
});

test('listener lifecycle is idempotent and StrictMode replay keeps the same retained event', async () => {
  const { browser, controller } = fixture(); let changes = 0;
  controller.subscribe(() => { changes++; });
  controller.start(); controller.start();
  browser.dispatchEvent(promptEvent(async () => {}));
  assert.equal(changes, 1);
  controller.stop(); controller.start();
  assert.equal(controller.getSnapshot().canPrompt, true);
  assert.equal(await controller.install(), 'accepted');
  controller.stop();
});

test('installed standalone windows and server rendering initialize without needing an install event', () => {
  assert.equal(createPwaInstallController().getSnapshot().installed, false);
  const browser = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: true }), navigator: {} });
  assert.equal(createPwaInstallController(browser).getSnapshot().installed, true);
  browser.matchMedia = () => ({ matches: false }); browser.navigator.standalone = true;
  assert.equal(createPwaInstallController(browser).getSnapshot().installed, true);
});
