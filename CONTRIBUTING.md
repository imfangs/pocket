# Contributing to Pocket

Pocket is a macOS companion for reading and continuing conversations in an existing Codex desktop app. Its current Alpha target is one owner using their own Mac and phone. Read [compatibility](docs/COMPATIBILITY.md), [self-hosting](docs/SELF_HOSTING.md), [privacy](PRIVACY.md) and [security](SECURITY.md) before changing installation or data boundaries.

## Where to contribute

As of 2026-11-12 this repository remains private; Issues are enabled for people with access. This document does not announce a public repository or release. Once you have access, use **Issues → New issue** for bugs and proposals and **Pull requests** for focused fixes. No response-time commitment is advertised.

For a bug, include the Pocket version/build, macOS and Codex versions, browser, reproduction steps, expected/actual behavior and relevant checks. Prefer a synthetic conversation or a minimal redacted example. Keep passwords, tokens, cookies, real conversation contents, feedback screenshots and raw support archives out of public reports. Suspected vulnerabilities follow [SECURITY.md](SECURITY.md).

## Development environment

Use **Node.js 26.x** and **Python 3.11+**. The currently checked development environment uses Python 3.14; the minimum relies on `tomllib` from Python 3.11. Use the lockfile with `npm ci`; avoid dependency updates unrelated to your change.

```sh
npm ci --registry=https://registry.npmjs.org
npm run build
node .github/scripts/test-synthetic.mjs
./node_modules/.bin/playwright install chromium webkit
POCKET_BROWSER_DIST="$PWD/dist" npm run test:browser
```

The synthetic runner reports the installed-desktop suites it excludes and why. Some use an installed bundled CLI in isolated homes; others use synthetic IPC peers but retain the production App-identity preflight. Full `npm test` includes those contracts. Run it on a compatible, isolated Mac when available; report unavailable native coverage explicitly. Synthetic success does not prove live desktop controls or physical-phone behavior, and lacking that environment need not prevent a contribution for review.

For UI development, `npm run dev` starts Vite on loopback. Use the repository's synthetic browser fixtures for interaction checks. If you connect a real API, inspect its configuration first and use an authorized test conversation. Keep test Codex homes, workspaces and credentials separate from real conversation storage. Do not restart Codex or modify real data just to make tests pass.

## Changes and review

Describe the concrete trigger, resulting behavior, verification and remaining limits. Keep changes focused. For reading, sending, navigation, selection, focus or keyboard changes, exercise the affected user path in the compiled app with synthetic data and Chromium/WebKit. Documentation-only changes need fact, command, link and diff checks rather than a full product test run.

Preserve these contracts:

- Original conversation text, thread and desktop owner remain authoritative. Retain model, working directory and permissions; do not directly write Codex SQLite, global state or rollouts or start a replacement executor.
- Preserve request IDs, fingerprints, revisions and turn identity. Reading caches or display adapters cannot authorize execution or confirm a send. Unknown results must be reconciled before retrying.
- Preserve drafts, IME, active selections, reading position and meaningful keyboard focus when responses race or the app updates.
- Translate product labels, never user text, model responses, filenames or model names. Keep variables and plural forms intact.
- Keep loopback binding, authentication, Host/Origin/CSRF and file capabilities. A rendered message does not grant file access or execution authority.
- Use synthetic fixtures. Keep credentials, messages, working data and diagnostic images outside source and public build output. Preserve local ignored configuration at its original paths.

For dependency changes, explain the need, update the lockfile, retain licenses/provenance and test affected behavior. Follow [the vendored Pele documentation](vendor/pele/README.md) rather than silently replacing its archive.

## Source and documentation checks

Before a commit, review staged content locally and run:

```sh
npm run privacy:check
npm run privacy:check -- --staged
git diff --cached --stat
```

The guard checks tracked/index bytes, known local private values and path boundaries. It is not a complete secret detector or Git-history clearance. Additional values can be registered in an ignored/private JSON `values` array through `--deny-file /absolute/private/deny.json`.

Markdown links must resolve in the tracked source and in the exported package, not just on the maintainer's disk. Public `docs/` paths are listed in `publicSourceDocumentationPaths` in `bin/source-privacy.mjs`; keep that allowlist and `.gitignore` exceptions aligned when adding a public document or asset. Private notes can remain on disk after they leave Git. See [PUBLIC_HISTORY.md](docs/PUBLIC_HISTORY.md) for the separate history boundary.

To check a redistributable snapshot locally:

```sh
npm run package:source -- --out /absolute/new/pocket-source
npm run privacy:check -- --root /absolute/new/pocket-source
```

The output directory must not already exist. Review its `source-manifest.json` and [third-party notices](THIRD_PARTY_NOTICES.md). The exporter does not copy `.git` or publish anything.

## Claims and acceptance

Record the tested source/build identity and separate synthetic, installed-desktop, authenticated-network and physical-phone evidence. First installation on a new Mac, phone/IME/notification recovery and a data-preserving upgrade/rollback remain verification gaps for the current Alpha. They should limit support claims, not become a blanket ban on publishing experimental source or reviewing contributions. Follow the upgrade guide before testing a running installation.
