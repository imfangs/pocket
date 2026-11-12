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

## Source and notice checks

```sh
npm run privacy:check
npm run privacy:check -- --staged
npm run licenses:check
```

After changing dependencies, install the exact graph, run `npm run licenses:update`, and review the declarations, retained original bytes and unresolved entries. Inventory coverage is not a legal opinion. The build retains notices as downloadable text assets; they are not injected into conversation content.

Private maintainer configuration and historical operational notes can remain on the original checkout at ignored paths. A fresh clone need not have them. Do not fix a missing local note by adding it to Git; publish only the generic contract or troubleshooting guidance a contributor needs. Source snapshots and a Git repository with history have different disclosure scopes; see [source/history disclosure](PUBLIC_HISTORY.md).
