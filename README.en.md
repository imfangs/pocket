# Pocket

[简体中文](README.md) · English

**Bring your Mac's Codex conversations to your phone.** Pocket is a self-hosted web app/PWA for reading conversations, continuing work, sending attachments and using supported conversation actions. It connects to your existing Codex desktop app and preserves the original conversation's model, permissions and execution owner.

This is an unofficial project, unaffiliated with and not endorsed by OpenAI. The source candidate is **0.1.0-alpha.1**, under the [MIT license](LICENSE), for one owner using their own Mac and phone. It has not been publicly released. Independent first-install and physical-phone acceptance remain release requirements; an existing deployment does not certify yours.

## How it works

![Pocket architecture: the phone reaches a loopback Mac API through your HTTPS entry; the API reads history and bridges to the original Codex desktop conversation, with private data separate from source.](docs/assets/pocket-architecture.svg)

Download the [interactive architecture diagram](docs/assets/pocket-architecture.html) and open it in a browser to explore it.

1. **Your phone** opens Pocket. Your HTTPS entry forwards same-origin web and API requests to your Mac. Login, Host, Origin and CSRF checks protect private endpoints.
2. **The Pocket API on your Mac** listens only on `127.0.0.1`, reads local Codex history, and stores its own preferences, pending messages and attachments. Python bridge modules are included; the maintainer's tool workspace is unnecessary.
3. **Your original Codex desktop app** executes model requests. Pocket sends through the conversation's desktop connection; supported creation and metadata actions use the app's bundled CLI. It does not start a second model executor to take over your conversations.
4. **Storage stays separate**: Codex owns original conversations, Pocket owns its runtime data, and the browser holds reading copies. Your HTTPS proxy is the recommended entry. The optional Cloudflare relay is an advanced deployment adapter, not a required service.

HTTPS secures transport, but this is not application-level end-to-end encryption: the TLS-terminating proxy can see content passing through it. Model requests follow your existing Codex account and provider policies.

## Prerequisites

| Requirement | What you need |
| --- | --- |
| Mac | macOS, an active user login and a reachable, awake Mac; original-owner control needs the Codex desktop app running |
| Codex | A signed Codex.app, your own completed login and compatible local conversation data; Pocket provides no model account or subscription |
| Runtime | **Node.js 26.x + npm, Python 3.11+**; Python's standard library is sufficient |
| Source and network | A reviewed source directory or release package, plus access to the public npm registry for locked dependencies; Git if cloning |
| Phone route | Your HTTPS domain/reverse proxy or phone-accessible private Tailnet HTTPS entry; optional for initial Mac-only setup |
| Private storage | A writable data directory outside the source checkout; keep proxy configuration, credentials and backups private too |

Current native evidence is primarily Apple Silicon. See [compatibility](docs/COMPATIBILITY.md) for Intel, future desktop protocols and other platform boundaries. An Agent can install and build; account login, unavailable DNS/network permissions and home-screen installation require your participation.

## Copy this to your Agent

Give this prompt and the source URL or local path to an Agent working on the target Mac. It should complete local setup first, then phone access when your HTTPS entry is available.

```text
Set up the Pocket project described by this README on my Mac. Use the repository, reviewed release package or local source directory I provide. If the source location is missing, ask for it; do not invent a repository URL.

Read README, docs/SELF_HOSTING.md, docs/COMPATIBILITY.md, PRIVACY.md and SECURITY.md first. Check macOS, Node.js 26.x, npm, Python 3.11+, the signed Codex desktop app, my completed login and compatible local conversation data. If my login is required, identify that step and continue independent work.

Run npm ci against the public registry. Inspect existing Pocket services and configuration first: preserve data, machine IDs, origins and request identities, retain credentials, and avoid overwriting configuration or starting a second data writer. For a new installation, run npm run setup with its default private data directory outside source, then npm run build and npm run doctor. Setup is idempotent: new flags do not update existing configuration. For a changed HTTPS entry, explicitly update client.publicOrigin and deployment.publicOrigin together.

Use the same selected configuration throughout: append -- --config /absolute/config.json to npm run doctor/start for a nondefault config, pass --config to service commands, and use the same path in POCKET_CONFIG for password maintenance. Stop only Pocket processes whose ownership you have verified; preserve Codex and other services.

Start in the foreground. Verify /api/health, confirm an unauthenticated /api/catalog request returns 401, then verify list and message reads after my local login. Keep the passphrase in its protected local file; provide only its location in replies, Git, screenshots or logs. Doctor does not test real sending or phone connectivity; report those separately.

If I have an authorized HTTPS domain, proxy or private Tailnet entry, connect same-origin web and API routes, retaining loopback binding, authentication and Host/Origin/CSRF checks. Verify the actual phone URL and PWA installation flow. If DNS, certificate or network permissions are missing, pause only that branch and deliver the working local entry plus the exact remaining step.

Use read-only acceptance first. Send only to a test conversation with text I explicitly authorize; if the result is unknown, check the original receipt before any retry and never resubmit with a new ID. If a background service is needed after foreground acceptance, stop the foreground process with Ctrl+C, run node bin/pocket.mjs service install --apply, and read back service status. Use service uninstall --apply to stop and remove its owned background service while retaining data. Report the version, URLs, config/data/passphrase-file paths, verified and unverified checks, and stop/uninstall/recovery instructions. Verify that private data and configuration are not Git-tracked.
```

## Manual quick start

From your reviewed source directory:

```sh
npm ci --registry=https://registry.npmjs.org
npm run setup
npm run build
npm run doctor
npm start
```

The default service is `http://127.0.0.1:4397`. Startup reports the protected local passphrase-file path. This address works on the Mac; on a phone, `127.0.0.1` refers to the phone itself.

For a new installation with an existing HTTPS entry, specify it during the first setup:

```sh
npm run setup -- --public-origin https://pocket.example.com
```

This command does not overwrite existing configuration. See [the self-hosting guide](docs/SELF_HOSTING.md) for proxies, configuration, user services and diagnostics. Each Mac owns its configuration, data and authentication; the advanced multi-machine relay requires additional setup.

## Where private data lives

| Data | Default location | Part of public source? |
| --- | --- | --- |
| Original Codex conversations, history and account material | `~/.codex/` and Codex's own storage | No; Pocket does not package it as source |
| Pocket preferences, outbox, receipts, attachments, authentication and backups | `~/Library/Application Support/CodexNavigator/` | No; outside the source directory |
| Local Pocket/bridge configuration and service logs | `.local/pocket/` | No; all of `.local/` is Git-ignored |
| Phone reading cache, UI preferences and optional feedback drafts | The browser/PWA's site storage | No; reading caches may contain private messages |
| Optional push, relay, feedback or analytics configuration | Your private configuration/data locations | No; enabled integrations have separate transmission boundaries |

Setup accepts `--data-dir`, `--codex-home` and `--config` overrides. **Keep custom data, credentials and backups outside the source checkout.** Public builds contain public assets and non-secret client configuration. Source export disables analytics by default and excludes the maintainer's deployment configuration and addresses.

Ordinary unsent Query text stays in the current page's memory; once queued, it is persisted on the Mac. It is separate from the browser's persistent reading cache.

`.gitignore` protects routine staging; it cannot erase committed history or prevent `git add -f`. Redistribute through the source allowlist, review the privacy check and manifest, then create a fresh public repository. Do not make a maintenance repository containing personal operations history public. See [PRIVACY.md](PRIVACY.md) for retention, browser storage and third-party boundaries, and [UPGRADING.md](docs/UPGRADING.md) for backups and rollback.

## Use and maintain

- Read and continue original conversations, upload images/files, and respond to supported approvals and questions.
- Search, browse projects and sort by smart rank, creation or activity. Pocket following/hiding remains independent of Codex pinning/archiving.
- Inspect model settings and use supported rename/archive/restore actions; availability depends on the original desktop protocol and conversation ownership.
- English and Simplified Chinese follow your system by default. Install to your phone's home screen while retaining drafts and reading position.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, synthetic tests and review. Follow [SECURITY.md](SECURITY.md) for issue reporting and supply sanitized evidence only.

To prepare redistributable source:

```sh
npm run package:source -- --out /absolute/new/pocket-source
npm run privacy:check -- --root /absolute/new/pocket-source
```

The output directory must not already exist. Review `source-manifest.json`, the privacy check and [third-party notices](THIRD_PARTY_NOTICES.md). Export success is not a public release or clean-device acceptance.
