# Contributing to Pocket

Pocket is a macOS-first companion for reading and continuing conversations in an existing Codex desktop app. Its current scope is one owner operating their own Mac and phone. Read [self-hosting](docs/SELF_HOSTING.md) and [compatibility](docs/COMPATIBILITY.md) before changing a running installation.

## Development environment

Use Node.js **26.x** and Python **3.14** for the currently checked development environment. The repository lockfile fixes dependency versions; use `npm ci` rather than updating them during an unrelated change. Browser checks use the locked Playwright package. Native desktop checks additionally require a supported Codex app installed on the test Mac.

```sh
npm ci --registry=https://registry.npmjs.org
npm run build
node .github/scripts/test-synthetic.mjs
./node_modules/.bin/playwright install chromium webkit
POCKET_BROWSER_DIST="$PWD/dist" npm run test:browser
```

The synthetic entry prints the name and dependency reason for each of seven separate installed-desktop contract suites. Creation, rename and archive suites run the installed bundled CLI in isolated homes. Desktop/model/read-state protocol suites use synthetic IPC peers but retain the production installed-App identity preflight, so they also require a supported Codex installation. Entire mixed suites remain in `npm test`, including their helper-only cases; synthetic success does not claim that coverage. Pure mock/data/API suites, bundled-layout fixtures and injected task-status contracts continue to run in the synthetic entry, with the guard against real desktop opening preserved. Run `npm test` on a supported Mac for all contracts; keep native fixtures' Codex homes, workspaces and credentials separate from your real conversation storage.

## Changes and review

Keep a change focused on a concrete problem. Describe the trigger, resulting behavior, relevant tests and remaining limits. When a change affects reading, sending, navigation, focus or the keyboard, exercise that user path in the compiled application with synthetic data and both supported browser engines.

Preserve these product contracts:

- Conversation text and original thread IDs are authoritative. Reading caches or display adapters cannot authorize execution or confirm a send.
- Keep request IDs, revisions and unknown-result checks. A lost response must not become a duplicate send, creation, approval or interruption.
- Continue work in the original desktop owner with its settings and permissions. Do not write Codex SQLite, global state or rollout files directly.
- Preserve drafts, active text selections, reading position and meaningful keyboard focus. A styling change must not remount an input or hide a recovery action.
- Translate product-owned labels, never user text, model responses, filenames or model names. Keep variables and plural forms intact in all language catalogs.
- Keep credentials, real messages, feedback images and working data outside source and public build output. Use clearly synthetic fixtures in tests and demonstrations.

Before committing in a clean public checkout, run `npm run privacy:check -- --staged` after staging to check the actual Git index. Before redistributing source, use `npm run package:source -- --out /absolute/new/source-directory`, then `npm run privacy:check -- --root /absolute/new/source-directory`. The exporter scans its outgoing bytes and excludes private runtime paths. The guard detects known local private values and file boundaries; it is not a complete secret or Git-history audit. Additional private values can be supplied with an external `--deny-file /absolute/private/deny.json` containing a `values` array; keep that file outside Git.

Before proposing a dependency change, record why it is needed, pin the resulting lockfile, retain its license and provenance, and test the affected behavior. The repository's vendored Pele renderer has a fixed source and repeatable build; follow [its documentation](vendor/pele/README.md) rather than replacing its archive silently.

## Reports and security

For ordinary bugs, provide the Pocket version/build, operating system, browser, desktop compatibility result, steps to reproduce and expected behavior. Redact conversation text, local paths, machine names and identifiers when they are not necessary. Never post passphrases, cookies, tokens, private keys or an unreviewed support archive.

Report suspected vulnerabilities through the procedure in [SECURITY.md](SECURITY.md), not a public issue containing private data. Public-repository and release availability are separate from the preparation work recorded in the changelog.

## Release checks

A synthetic green build is one layer of acceptance. A release also needs the clean-machine installation, authenticated phone connection, real supported desktop capabilities, upgrade/rollback and data-preserving uninstall checks in the self-hosting and upgrade guides. Record the tested release identity and distinguish supported, experimental and unavailable capabilities.
