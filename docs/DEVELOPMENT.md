# Developing Pocket

Start with the README, compatibility contract, and privacy/security boundaries. This source is a macOS single-owner Alpha: reading projections and desktop execution are separate responsibilities, and a successful synthetic test does not verify a new user's desktop or phone.

## Code map

| Area | Entry points and responsibility |
| --- | --- |
| Application and navigation | `src/App.tsx`, `src/catalogReader.ts`, `src/useTaskOperations.ts`; computer/source identity, catalog reads, dialogs and navigation |
| Conversation and submission | `src/Conversation.tsx`, `src/Outbox.tsx`, `src/submissionReceipt.ts`; preserve draft/request identity through direct send, queue, recovery and cancellation |
| Reading and versions | `src/pocketReadState.ts`, `src/readObservation.ts`, `src/conversationFeed.ts`, `server/pocket-content.mjs`; displayed content, content versions, cached projections and read intent |
| Source and storage | `server/source.mjs`, `server/source-scope.mjs`, `server/history.mjs`, `server/store.mjs`; read Codex sources without changing them, maintain Pocket's own private database |
| Original desktop control | `server/desktop.mjs`, `server/lifecycle.mjs`, `server/bridge-config.mjs`, `bin/desktop-bridge.py`, `vendor/codex-bridge/`; existing owner/turn/model permissions and persistent receipts |
| HTTP and optional relay | `server/index.mjs`, `server/deployment-config.mjs`, `edge/worker.mjs`, `bin/tunnel.mjs`; loopback, authentication, Host/Origin/CSRF and registered computer routing |
| Files and rendering | `server/attachments.mjs`, `server/message-images.mjs`, `src/MessageMarkdown.tsx`, `src/ImageViewer.tsx`; registered file capabilities and bounded rendering |
| Setup and service | `bin/pocket.mjs`, `bin/pocket-config.mjs`, `bin/pocket-service.mjs`; private configuration, diagnostics, and owned service lifecycle |
| Distribution | `bin/package-source.mjs`, `bin/source-privacy.mjs`, `bin/dependency-notices.mjs`; source allowlist, private-value checks and dependency notices |

## A useful local loop

Use Node.js 26.x and the locked dependency graph. `npm run dev` binds Vite to loopback and proxies `/api` to `127.0.0.1:4397`. This does not start a fixture API; point it only at an installation you intentionally use. For experiments without private conversations, use the synthetic browser harness instead.

Run focused tests for the behavior you change, `npm run build` for frontend changes, and `npm run test:browser` for interactions. `node .github/scripts/test-synthetic.mjs` selects the CI contracts that do not require an installed Codex desktop. Full `npm test` retains the installed-desktop suites and uses isolated homes plus the native-open blocking helper. Browser tests intercept requests at a synthetic origin and never forward unsupported endpoints to a real service; see the [browser suite](../tests/browser/README.md).

Keep request IDs, owner/turn identity, version floors, input selection/IME and reading anchors intact. Unknown results are checked by their original receipt, not retried under a new ID. Test setup should use fixture data and temporary directories; changing an API's tests must not remove production identity or permission checks to make CI green.

## Incremental type checking

Run `npm run typecheck` to check both the frontend and the backend pilot. Use `typecheck:client` or `typecheck:server` for a focused loop. CI runs both. Node.js 26 types are an explicit development dependency; browser types stay separate from Node globals.

The backend still runs `.mjs` directly, without a new compilation step. `tsconfig.server.json` uses strict checking with `checkJs: false`; the pilot modules opt in with `// @ts-check`. The current scope is the bounded dispatch response, stop/queue-pause receipts, and upload-manifest admission. Imported legacy JavaScript remains outside the checked implementation scope. Do not describe this pilot as complete backend type coverage.

`shared/submission-contracts.ts` contains only shared types. The frontend reuses its receipt/status and upload presentation types; checked backend implementations use JSDoc imports. Upload admission entries are separate from UI progress descriptors. External JSON remains `unknown` until validated, and a read/cached projection never authorizes execution. SQLite row assertions are limited to Pocket-owned tables and their known writes; they do not validate arbitrary bridge data.

`tests/types/server-contracts.ts` includes positive contracts and `@ts-expect-error` cases for missing request/turn identity, incorrect status fields, and premature turn claims. These samples fail compilation if a previously rejected shape becomes accepted. Keep runtime race, cancellation, upload-original verification and unknown-receipt tests: static types cannot establish those behaviors.

## Native approval choices

Approval responses belong to the original desktop request. `bin/request_actions.py` projects only known native choices into `approvalOptions`, with an opaque ID bound to the conversation, host, full request fingerprint and exact native response. The frontend submits `{responseId, optionId}`; it cannot author a command policy or permission profile. The bridge re-reads the original owner, regenerates the choices and resolves that exact ID before responding. Reused response IDs retain their original selection, and unknown outcomes are checked rather than replayed.

Explicit native decision lists take precedence, including empty lists. Installed native defaults are used only where their behavior has been verified. Session command approvals, exact command prefixes, network rules, future changes to the same files, directory requests and turn/session permission profiles retain their distinct scopes. A tool's refusal and cancellation are separate decisions. These choices do not change the global access mode. The native `grantRoot` contract retains its upstream uncertainty about actual enforcement; passing the original response does not claim broader behavior has been proven.

Legacy clients keep their once-only `choices`/`decision` path and normal request keys remain byte compatible so accepted/unknown receipts survive an update. A present empty or malformed `approvalOptions` list never falls back to an invented grant. Missing file review data, oversized content or ambiguous/unencodable text removes grants while preserving available refusals. Keep rules, hosts, directories and permission scopes fully reviewable; test approvals with synthetic peers, not real user requests.

## Source and notice checks

```sh
npm run privacy:check
npm run privacy:check -- --staged
npm run licenses:check
```

After changing dependencies, install the exact graph, run `npm run licenses:update`, and review the declarations, retained original bytes and unresolved entries. Inventory coverage is not a legal opinion. The build retains notices as downloadable text assets; they are not injected into conversation content.

Private maintainer configuration and historical operational notes can remain on the original checkout at ignored paths. A fresh clone need not have them. Do not fix a missing local note by adding it to Git; publish only the generic contract or troubleshooting guidance a contributor needs. Source snapshots and a Git repository with history have different disclosure scopes; see [source/history disclosure](PUBLIC_HISTORY.md).
