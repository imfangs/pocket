import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium, webkit } from "playwright";
import { createHarness, engines, ids } from "./fixture.mjs";
import { runScenario } from "./scenario.mjs";

const results = [];
after(() => {
  const path = resolve(process.env.POCKET_CREATION_ARRIVAL_REPORT || ".local/qa/browser-creation-arrival/scenarios.json");
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + "\n");
});

async function creationHarness(engine, state) {
  let harness, operation = null;
  const creationCalls = [];
  const launch = async options => {
    const browser = await ({ chromium, webkit })[engine].launch(options), createContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await createContext(options), register = context.route.bind(context);
      // This adapter adds only the lifecycle under test. The fixture's normal
      // unknown-network and native-owner blocking remains in force elsewhere.
      context.route = (pattern, handler) => register(pattern, async route => {
        const request = route.request(), url = new URL(request.url());
        const path = url.pathname.replace(/^\/api\/machines\/[a-z][a-z0-9-]*\//, "/api/");
        if (url.origin !== "https://pocket.test") return handler(route);
        if (path === "/api/tasks" && request.method() === "POST") {
          const input = request.postDataJSON(); creationCalls.push({ method: "POST", requestId: input.requestId });
          assert.equal(input.locationId, "synthetic-location"); assert.equal(typeof input.initialQuery, "string");
          operation = state === "confirmed" ? { requestId: input.requestId, operation: "create", status: "succeeded", creationStatus: "created",
            threadId: ids.empty, thread: harness.metadata(ids.empty), createdAt: Date.now(),
            initialMessage: { requestId: "a7100000-0000-4000-8000-000000000010", status: "accepted" } }
            : { requestId: input.requestId, operation: "create", status: "unknown", createdAt: Date.now() };
          return route.fulfill({ status: 202, contentType: "application/json", headers: { "cache-control": "no-store", "X-Pocket-Machine": "ged" }, body: JSON.stringify(operation) });
        }
        if (operation && path === `/api/task-operations/${operation.requestId}/cancel` && request.method() === "POST") {
          assert.equal(operation.status, "unknown"); creationCalls.push({ method: "CANCEL", requestId: operation.requestId });
          operation = { ...operation, status: "cancelled" };
          return route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store", "X-Pocket-Machine": "ged" }, body: JSON.stringify(operation) });
        }
        if (request.method() === "GET" && (path === "/api/task-operations" || operation && path === `/api/task-operations/${operation.requestId}`)) {
          if (path !== "/api/task-operations") creationCalls.push({ method: "GET", requestId: operation.requestId });
          return route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store", "X-Pocket-Machine": "ged" },
            body: JSON.stringify(path === "/api/task-operations" ? { operations: operation ? [operation] : [] } : operation) });
        }
        return handler(route);
      });
      return context;
    };
    return browser;
  };
  harness = await createHarness(engine, { launch });
  await harness.addInitScript(() => {
    const realNow = Date.now; window.creationClockOffset = 0;
    Date.now = () => realNow() + window.creationClockOffset;
  });
  return Object.assign(harness, { creationCalls });
}

async function submitCreation(page, text) {
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  const query = page.locator("#quick-create-query"); await query.fill(text);
  await page.getByRole("button", { name: "创建并发送", exact: true }).click();
  await page.locator("#quick-create-query").waitFor({ state: "detached" });
}
const advancePastCue = page => page.evaluate(() => {
  window.creationClockOffset += 301000;
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("pageshow"));
});

for (const engine of engines) {
  test(`${engine}: created row and accepted Query survive cue retirement while a newer conversation draft stays intact`, { timeout: 30000 }, () => runScenario({
    engine, name: "created cue retirement preserves accepted Query and newer draft", create: () => creationHarness(engine, "confirmed"),
    record: value => results.push(value), run: async h => {
      const page = await h.open(null); const text = "Synthetic first creation Query";
      await submitCreation(page, text);
      const row = page.locator(`[data-thread-id="${ids.empty}"]`); await row.waitFor();
      assert.equal(await row.getAttribute("data-creation-state"), "confirmed"); await row.click();
      await page.locator('.conversation-message.user').filter({ hasText: text }).waitFor();
      const composer = page.locator(".conversation-composer textarea"); await composer.fill("New follow-up draft");
      await advancePastCue(page); await page.waitForTimeout(200);
      assert.equal(await composer.inputValue(), "New follow-up draft");
      assert.equal(await page.locator('.conversation-message.user').filter({ hasText: text }).count(), 1);
      await page.locator("[data-inspector-close]").click();
      await row.waitFor(); assert.equal(await row.getAttribute("data-creation-state"), null);
      await row.click(); assert.equal(await page.locator(".conversation-composer textarea").inputValue(), "New follow-up draft");
      assert.equal(h.creationCalls.filter(call => call.method === "POST").length, 1, "expiry cannot replay creation");
      assert.equal(h.calls.filter(call => call.action === "messages").length, 0, "the newer draft stays unsubmitted");
    },
  }));

  test(`${engine}: an unknown creation keeps its original recovery input beyond the confirmed-cue window`, { timeout: 30000 }, () => runScenario({
    engine, name: "unknown creation input does not expire or replay", create: () => creationHarness(engine, "unknown"),
    record: value => results.push(value), run: async h => {
      const page = await h.open(null); const text = "Synthetic unknown creation input";
      await submitCreation(page, text);
      const row = page.locator('[data-creation-action="review"]'); await row.waitFor();
      await advancePastCue(page); await page.waitForTimeout(200); await row.click();
      assert.equal(await page.locator("#quick-create-query").inputValue(), text);
      assert.equal(h.creationCalls.filter(call => call.method === "POST").length, 1);
      assert.equal(h.creationCalls.filter(call => call.method === "GET").length, 0, "elapsed time cannot start unknown-result recovery");
    },
  }));

  test(`${engine}: stopping unknown recovery keeps text in the open editor without resubmitting or checking the cancelled request`, { timeout: 30000 }, () => runScenario({
    engine, name: "explicit recovery cancellation keeps open editor ownership", create: () => creationHarness(engine, "unknown"),
    record: value => results.push(value), run: async h => {
      const page = await h.open(null); const text = "Synthetic explicitly cancelled recovery input";
      await submitCreation(page, text); await page.locator('[data-creation-action="review"]').click();
      const editor = page.locator("#quick-create-query"); assert.equal(await editor.inputValue(), text);
      await page.locator("dialog[open]").getByRole("button", { name: "停止核对", exact: true }).click();
      await page.locator('.task-operation-status[data-status="cancelled"]').waitFor();
      assert.equal(await editor.inputValue(), text); assert.equal(await editor.isEnabled(), true);
      await editor.fill("Revised unsent input"); await advancePastCue(page); await page.waitForTimeout(200);
      assert.equal(await editor.inputValue(), "Revised unsent input");
      assert.equal(h.creationCalls.filter(call => call.method === "POST").length, 1);
      assert.equal(h.creationCalls.filter(call => call.method === "CANCEL").length, 1);
      assert.equal(h.creationCalls.filter(call => call.method === "GET").length, 0);
    },
  }));
}
