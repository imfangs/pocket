# Browser regression smoke

This suite runs the compiled Pocket application against a small synthetic service. It keeps high-value interactions reproducible without a real Mac API, account, clipboard or native conversation.

```sh
npm ci
npx playwright install chromium webkit
npm run test:browser
```

On Linux, Playwright may require its documented browser system dependencies (`npx playwright install --with-deps chromium webkit`). Browser installation is explicit; the test command never downloads browsers or starts a real Pocket service.

The default runner builds to `.local/qa/browser-dist`, then runs Chromium and WebKit sequentially. It writes the build ID, results and test log to `.local/qa/browser-smoke/`. Every run first replaces old results with a non-passing `running` record and clears old logs. Build, manifest, browser startup and cleanup failures all finish with a failed record; a previous green result cannot stand in for a new run. To check an existing build or select one engine:

```sh
POCKET_BROWSER_DIST=/absolute/path/to/built-pocket npm run test:browser
POCKET_TEST_BROWSERS=chromium npm run test:browser
POCKET_BROWSER_OUTPUT=.local/qa/my-check npm run test:browser
```

Seven flows run in each engine:

- list → conversation → return, and new-query autofocus;
- information loading geometry and repeated-open caching;
- sending in an existing conversation;
- sending in an empty conversation;
- deliberate top pull, bounded history loading and return to latest;
- slow history after moving away;
- slow history while writing a draft.

The send scenarios keep one DOM row through pending, accepted, exact echo and an old queue snapshot. History tests keep the same scroll root and ensure prepared results do not override newer reading/input intent. Synthetic touch events exercise the actual event bindings; they do not prove physical iPhone keyboard, inertia or PWA behavior.

`fixture.mjs` intercepts every request at `https://pocket.test`. Only static files inside the chosen build and explicitly implemented synthetic APIs are available. Static responses apply the chosen build's `_headers`, including CSP; document navigation checks the actual header and the first browser flow confirms that an inline script is blocked. Unsupported header-rule syntax fails explicitly rather than silently dropping policy.

External requests and unknown APIs fail the suite. Service workers are disabled; no real network request is forwarded. Add a synthetic handler only when a new tested user flow needs it. Each scenario includes startup in its failure reporting and closes its browser/context even when setup only partly completes. The runner forwards interruption to its own child process group and records an interrupted result.

Seven fast infrastructure tests also protect header matching, setup/cleanup failures, stale-result replacement, failed builds, command startup and interruption. They use temporary directories and fake browser/command adapters, with no native conversation actions. Runs sharing the default output directory should be sequential; use separate `POCKET_BROWSER_OUTPUT` paths for separate builds.

This is intentionally separate from `npm test`: ordinary domain/protocol tests remain fast and do not require browser installation. Keep detailed domain edge cases in those tests; add a browser flow when DOM identity, focus, geometry or user intent is the behavior being protected.
