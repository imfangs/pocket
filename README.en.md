# Pocket

[简体中文](README.md) · English

**Bring your Mac's Codex conversations to your phone.** Pocket is a self-hosted web app/PWA for reading replies away from your desk, continuing work, sending attachments, and handling supported approvals and questions. It connects to your existing Codex desktop app and preserves the conversation's model, working directory, permissions and execution owner.

For people who already use Codex on a Mac and are comfortable maintaining a local service and their own HTTPS entry. This is **0.1.0-alpha.1** experimental source under the [MIT license](LICENSE), unofficial and unaffiliated with OpenAI. As of 2026-11-12, the repository is private and no public release has been published.

![Pocket interface illustration using synthetic content.](docs/assets/pocket-preview.png)

## What it does and where it works

- Read and search original conversations, browse projects, and sort by smart rank, creation or activity. Pocket following/hiding is independent of Codex pinning/archiving.
- Continue original conversations, upload images/files, and respond to supported approvals and questions, retaining request identities and handling queued or unconfirmed results.
- Inspect model settings and use supported creation, rename, archive and restore actions. Availability depends on the original desktop protocol and conversation ownership.
- English and Simplified Chinese follow your system by default. Add Pocket to your phone's home screen; reading caches and UI state are scoped by computer and source.

The current target is **macOS, one owner, their own Mac and phone**. Native evidence is primarily Apple Silicon. Pocket provides no model account or subscription and no multi-user permission isolation. Its outbox is separate from the desktop queue; native read-state writeback is not reliable, and cross-phone read synchronization is unavailable. Desktop-held conversations can leave operations such as archiving waiting.

Independent first installation on a new Mac, Intel support, and physical-phone keyboard, lock-screen notification and long-running network recovery checks remain unverified. Existing deployments and synthetic tests provide partial evidence, not universal installability. These gaps limit the Alpha support claim; they do not prevent publishing or trying experimental source. See [compatibility](docs/COMPATIBILITY.md).

## Start on your Mac

You need macOS, **Node.js 26.x + npm, Python 3.11+**, a signed, installed and signed-in Codex.app, and compatible local conversation data. Keep the Mac online; original-owner controls require the desktop app running. Bridge code is included; the maintainer's FBT workspace is unnecessary.

From source you have obtained and reviewed (existing installations should read [the upgrade guide](docs/UPGRADING.md) first):

```sh
npm ci --registry=https://registry.npmjs.org
npm run setup
npm run build
npm run doctor
npm start
```

Open `http://127.0.0.1:4397` **on the Mac**. Startup reports the protected passphrase-file location; read it locally and sign in. Keep its value out of public reports. `doctor` checks the environment and source, not real sending or phone connectivity. Stop the foreground process with Ctrl+C.

Configuration is written to Git-ignored `.local/pocket/`, data defaults to the source-external `~/Library/Application Support/CodexNavigator/`, and original Codex source defaults to `~/.codex/`. `setup` preserves existing configuration; new flags do not update it.

## Connect your phone over HTTPS

On a phone, `127.0.0.1` refers to the phone. Use your own HTTPS domain/reverse proxy or a phone-accessible private Tailnet HTTPS entry forwarding to the Mac's `127.0.0.1:4397`.

If your HTTPS entry is ready for a new installation, replace the setup step above with:

```sh
npm run setup -- --public-origin https://pocket.example.com
```

For an existing installation, edit the selected private config so `client.publicOrigin` and `deployment.publicOrigin` agree, then restart the Pocket service whose ownership you have verified. Retain authentication, Host, Origin, CSRF checks and loopback binding.

Open your HTTPS URL on the phone, sign in, and use Safari's Share → Add to Home Screen or the browser's supported install action. The [self-hosting guide](docs/SELF_HOSTING.md) / [中文指南](docs/SELF_HOSTING.zh-CN.md) provides a Caddy example, verification steps, background-service commands and troubleshooting. Each Mac owns its configuration, data and authentication; the optional Cloudflare multi-machine relay requires additional setup.

## How it works

![Pocket architecture: a phone reaches a loopback Mac API through the owner's HTTPS entry; the API reads history and connects to the original Codex conversation, with private data separate from source.](docs/assets/pocket-architecture.svg)

Download the [interactive architecture diagram](docs/assets/pocket-architecture.html) and open it in a browser.

Phone → your HTTPS entry → Pocket API on the Mac → original Codex desktop conversation. The loopback API reads local history and stores its own preferences, outbox and attachments; Codex still executes model requests. Pocket does not directly rewrite Codex SQLite, global state or rollouts, or start a replacement executor to take over a conversation.

HTTPS protects transport; the TLS-terminating proxy can see content passing through it. Pocket adds no application-level end-to-end or at-rest encryption. Model requests follow your existing Codex account and provider policies.

## Private data and maintenance

| Data | Default location |
| --- | --- |
| Original Codex conversations, history and account material | `~/.codex/` and Codex's own storage |
| Pocket preferences, outbox, receipts, attachments and authentication | `~/Library/Application Support/CodexNavigator/` |
| Pocket/bridge configuration and service logs | `.local/pocket/` |
| Reading cache, UI preferences and optional feedback drafts | Browser/PWA site storage |

None of these belongs in public source. Keep custom data, credentials and backups outside the checkout. Preserve existing private configuration at its original paths; do not overwrite it with examples. Ordinary unsent Query text stays in page memory; queued submissions persist on the Mac. Analytics and feedback are disabled by default; read [PRIVACY.md](PRIVACY.md) before configuring your own integrations.

See [self-hosting](docs/SELF_HOSTING.md) for installation and image-permission troubleshooting, and [UPGRADING.md](docs/UPGRADING.md) for backups and recovery. History may retain names, conversation identifiers and development records; [PUBLIC_HISTORY.md](docs/PUBLIC_HISTORY.md) explains the disclosure and older-version boundaries. Source export contains no Git history and is not comprehensive historical anonymization or publication.

Report ordinary bugs through the repository’s **Issues → New issue** when you have access; the repository is currently private. Include the version, reproduction steps and synthetic examples. Follow [SECURITY.md](SECURITY.md) to request a private channel for security reports; keep secrets and full conversations out of public issues. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and [third-party notices](THIRD_PARTY_NOTICES.md) for dependencies.

## Give setup to an Agent

Give this prompt and your source URL or local path to an Agent working on the target Mac:

```text
Set up Pocket. Read README, docs/SELF_HOSTING.md, docs/COMPATIBILITY.md, PRIVACY.md and SECURITY.md. Check macOS, Node.js 26.x, Python 3.11+, the signed Codex desktop app, my login and compatible source layout. Use the source I provide. Identify missing source access or account login while continuing independent work.

Inspect existing services and configuration first. Preserve data, authentication, machine IDs, origins and request identities; do not overwrite config or start a second writer. For a new installation run npm ci --registry=https://registry.npmjs.org, npm run setup, npm run build, npm run doctor, then npm start. Carry -- --config /absolute/config.json through nondefault setup, doctor and start commands, --config through service commands, and the same POCKET_CONFIG through password maintenance. Setup does not update an existing config.

Verify local /api/health, unauthenticated /api/catalog returning 401, and authenticated list/message reads. Use the passphrase locally; report only its file location. If I have authorized HTTPS access, configure the same-origin proxy and phone login, retaining loopback, authentication, Host, Origin and CSRF checks. Real sends use only a test conversation I authorize. Check the original receipt for unknown results; never replay with a new ID.

If a background service is needed, stop the foreground instance, run node bin/pocket.mjs service install --apply and read back service status. Use service uninstall --apply to stop/remove the owned background instance while retaining data. Report version, URLs, config/data/passphrase-file locations, verified and unverified results, and stop/backup/recovery instructions.
```
