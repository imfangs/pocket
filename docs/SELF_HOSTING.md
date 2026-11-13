# Self-host Pocket (Alpha)

[简体中文](SELF_HOSTING.zh-CN.md) · English

Pocket lets one owner read and continue their Mac's existing Codex conversations from a browser or phone. You provide the Mac, your signed-in Codex desktop app, private storage and an HTTPS entry. There is no Pocket-hosted account or model subscription. This guide describes experimental **0.1.0-alpha.1** source; independent new-Mac and physical-phone acceptance remain unverified, not prerequisites for sharing or trying the Alpha source.

## 1. Start locally on your Mac

Use macOS, **Node.js 26.x + npm** and **Python 3.11+**. Start and sign into the signed Codex desktop app and ensure it has compatible local conversation data. Keep the Mac awake and online. Bridge modules are bundled; you do not need the maintainer's FBT workspace. See [compatibility](COMPATIBILITY.md) for source, desktop and architecture limits.

If Pocket is already installed, read [UPGRADING.md](UPGRADING.md) before changing it. Inspect existing services, the actual data directory and configuration; preserve their request identities and credentials. Do not start a second writer against the same data.

From source you have obtained and reviewed:

```sh
npm ci --registry=https://registry.npmjs.org
npm run setup
npm run build
npm run doctor
npm start
```

Open `http://127.0.0.1:4397` on the Mac. Startup reports the protected local passphrase-file location, not its value. Read it locally to sign in; keep it out of chat, screenshots, command arguments and public logs. Stop the foreground process with Ctrl+C.

Default locations:

| Item | Location |
| --- | --- |
| Installation configuration | `<checkout>/.local/pocket/config.json` |
| Explicit bridge profile and service logs | `bridge.json` and `logs/` beside the selected config |
| Pocket data, authentication, outbox and attachments | `~/Library/Application Support/CodexNavigator/` |
| Original Codex source | `~/.codex/` |

Keep custom data, backups and secret configuration outside the source checkout. `.local/` is ignored by Git. Detailed retention and browser-storage boundaries are in [PRIVACY.md](../PRIVACY.md).

`setup` is idempotent: if the selected config exists, it returns `created:false` and ignores new setup flags, including origin, port and data-directory changes. Edit the existing private config deliberately rather than deleting it to rerun setup.

### Select a different configuration

On a new installation, choose paths and identity during setup:

```sh
npm run setup -- --config /absolute/private/pocket/config.json \
  --data-dir /absolute/private/pocket-data \
  --codex-home /absolute/path/to/.codex \
  --port 4397 --machine-id local --label "My Mac"
npm run build
npm run doctor -- --config /absolute/private/pocket/config.json
npm start -- --config /absolute/private/pocket/config.json
```

Use that same config for `doctor`, `start`, service management and password maintenance. A separate installation also needs its own Pocket data directory and unused port. For test writes, use an isolated Codex home and authorized test conversation; do not point synthetic tests at real storage. Machine IDs and display labels appear in public client configuration, so use non-sensitive values.

## 2. Check the local entry

Check `/api/health` succeeds and an unauthenticated `/api/catalog` request returns 401. Sign in locally and verify the conversation list and a message read.

`doctor` checks runtime, bridge modules, App identity, source schema and built frontend. It reports desktop control and mobile connection as `not_checked`. A healthy process or authenticated read does not prove sending, filesystem access to every image, or phone connectivity. For a real control test, choose a conversation and action you authorize; preserve the original request ID and reconcile any unknown result before retrying.

## 3. Add your phone's HTTPS entry

`127.0.0.1` on a phone refers to the phone. Use your own HTTPS reverse proxy on the Mac, or a private Tailnet HTTPS entry that can reach the loopback service. Keep Node bound to `127.0.0.1`; do not expose it on `0.0.0.0`.

For a new installation with a known HTTPS origin, replace the initial setup step with:

```sh
npm run setup -- --public-origin https://pocket.example.com
```

For an existing installation, stop only its owned Pocket process, edit the selected private `config.json` so both `client.publicOrigin` and `deployment.publicOrigin` contain the exact same bare HTTPS origin, and restart it with the same config. Preserve machine identity, data and authentication. A bare origin has no URL path, query, fragment or credentials. Changing origin also changes browser storage scope; export/backup decisions should account for your existing reading state.

For example, a Caddy site using your own domain can forward the same-origin web app and API:

```caddyfile
pocket.example.com {
    reverse_proxy 127.0.0.1:4397
}
```

Provide your own DNS and certificate setup; Caddy is a separate dependency, not installed by Pocket. The proxy must retain the intended public Host and overwrite `X-Forwarded-Proto` with the HTTPS protocol it actually terminated. Strip untrusted incoming forwarding headers. Retain authentication, Host, Origin and CSRF checks. Private Tailnet HTTPS is an alternative; verify its actual Host and HTTPS forwarding behavior against the configured origin.

Fresh setup uses a minimum of 12 characters for newly generated or replaced passphrases. Existing credentials are retained when policy changes; review and explicitly rotate a weak or unknown legacy credential before exposure. An authenticated Pocket session can control conversations, not just read them. See [SECURITY.md](../SECURITY.md).

On the phone, open your HTTPS URL, sign in and verify list/message reads. In Safari use Share → Add to Home Screen, or the browser's supported install action. Test keyboard, drafts and any notifications on the actual device. Authenticated `/api/deployment/status` separates basic initialization/source checks from desktop and external-entry checks; it does not certify the phone route.

## 4. Optional user-level background service

Validate the foreground service, then stop it before installing the LaunchAgent. No root daemon or `sudo` is needed. Commands without `--apply` show an installation/uninstallation plan.

```sh
node bin/pocket.mjs service install --apply
node bin/pocket.mjs service status
```

To stop and remove this installation's background registration:

```sh
node bin/pocket.mjs service uninstall --apply
node bin/pocket.mjs service status
```

For a nondefault config, append `--config /absolute/private/pocket/config.json` to **every** service command, including `status` and `uninstall`. There is no `service stop` subcommand. Foreground services stop with Ctrl+C; background services stop through their owned uninstallation. Data and configuration are preserved, so reinstalling the same service reuses them.

The LaunchAgent records the detected Node executable, source directory, selected config and private logs. After moving source or changing Node paths, review/reinstall the owned registration. Uninstall does not delete Pocket data, attachments or any original Codex data.

## Password maintenance

Point `POCKET_CONFIG` to the same selected config, including for a default installation:

```sh
POCKET_CONFIG="$PWD/.local/pocket/config.json" node bin/access.mjs info
POCKET_CONFIG="$PWD/.local/pocket/config.json" node bin/access.mjs rotate
POCKET_CONFIG="$PWD/.local/pocket/config.json" node bin/access.mjs set --stdin
```

Replace that path with your absolute custom config when applicable. `set --stdin` reads the replacement through standard input; never put the value in arguments or URLs. Rotation revokes browser sessions and notification registrations, not queued messages. Complete snapshots and rollback are described in [UPGRADING.md](UPGRADING.md).

## Local images and macOS folder permission

Conversation images are served through authenticated, conversation-bound references. Existing Markdown image previews require a supported local image inside that conversation's working directory; uploaded attachments have their own records. Code blocks, arbitrary browser-supplied paths and external image URLs do not grant local file access. Format, size, path/symlink and reference-expiry checks still apply.

If an image fails:

1. Check the conversation's working directory, the actual reference/file and the registered image response. A missing or expired reference can return 404; reread the conversation to obtain a current reference. A 401 requires a valid login. A 403 needs its specific access reason checked rather than assuming every denial is macOS privacy control.
2. If the service cannot read a file in Documents or another protected folder, identify the **actual background Node executable and launch context**. Codex displaying the image, or a foreground terminal reading it, does not prove the LaunchAgent has the same folder permission.
3. In System Settings → Privacy & Security → Files & Folders, check that program's relevant folder permission. If it is absent from the list, investigate the real service startup and system authorization route. Do not edit the TCC database, broaden allowed paths or replace the conversation directory to bypass a denial.
4. Retry the same image and confirm a successful response and decode. A healthy API or green `doctor` alone cannot verify access to that file. If the Node path changes after an upgrade, recheck the actual process and permission.

Keep private filenames, full paths, conversation text and image contents out of public troubleshooting reports. The maintainer's private image notes are not required for this procedure.

## Other troubleshooting

- **Node/Python mismatch:** use the declared versions and check the selected private bridge interpreter.
- **Missing desktop/source:** start Codex, complete your login and check the documented layout. Do not guess a new database filename or edit Codex SQLite.
- **Custom Codex location:** set `appPath` in the selected private `bridge.json` to the actual signed bundle, then rerun doctor with the same Pocket config.
- **Host/Origin rejection:** correct the declared origin and trusted proxy headers; preserve the guards.
- **Busy conversation:** history can remain readable while an action waits for the original desktop writer. Archive/restore availability has additional limits in [COMPATIBILITY.md](COMPATIBILITY.md).
- **Unconfirmed send/creation:** preserve the original request ID and check its receipt. Do not issue a new request as a retry.
- **Port/lock conflict:** identify the existing writer first. Stale-lock recovery requires proving all writers have stopped; see [UPGRADING.md](UPGRADING.md).

## Advanced adapters and existing private config

Direct HTTPS is the shortest self-host path. Cloudflare relay source is an optional advanced adapter. Provide your own Pages project, KV binding, registration credential, public client profile and domain. A stable named tunnel/private proxy is preferable for routine use; Quick Tunnel has no availability guarantee.

`POCKET_CLIENT_CONFIG=/absolute/public-profile.json npm run build:pages` builds a validated public profile. The legacy Quick Tunnel connector uses your own `NAVIGATOR_RELAY_CONFIG` based on `config/relay.example.json`, `NAVIGATOR_MACHINE_ID`, and `cloudflared` on PATH or `CLOUDFLARED`. `NAVIGATOR_API_ORIGIN` can select a different bare loopback HTTP port. Keep registration secrets in private storage. These adapters need their own deployment verification; their source is not a hosted service.

Existing `config/desktop-bridge.json`, `config/usage-analytics.json` and deployment/service config files may remain at their original ignored paths. Preserve their contents and explicit environment/config overrides; do not copy examples over them. A clean checkout discovers the bundled bridge and defaults to disabled analytics. To enable your own analytics, copy `config/usage-analytics.example.json` to the ignored `config/usage-analytics.json` and set your own project and allowed origins. Read [PRIVACY.md](../PRIVACY.md) first.

## Set up with an Agent

Give the following prompt and the source location to an Agent on the target Mac.

<details>
<summary>Copy to an Agent</summary>

```text
Set up Pocket. Read README, docs/SELF_HOSTING.md, docs/COMPATIBILITY.md, PRIVACY.md and SECURITY.md. Check macOS, Node.js 26.x, Python 3.11+, the signed Codex desktop app, my login and compatible source layout. Use the source I provide. Identify missing source access or account login while continuing independent work.

Inspect existing services and configuration first. Preserve data, authentication, machine IDs, origins and request identities; do not overwrite config or start a second writer. For a new installation run npm ci --registry=https://registry.npmjs.org, npm run setup, npm run build, npm run doctor, then npm start. Carry -- --config /absolute/config.json through nondefault setup, doctor and start commands, --config through service commands, and the same POCKET_CONFIG through password maintenance. Setup does not update an existing config.

Verify local /api/health, unauthenticated /api/catalog returning 401, and authenticated list/message reads. Use the passphrase locally; report only its file location. If I have authorized HTTPS access, configure the same-origin proxy and phone login, retaining loopback, authentication, Host, Origin and CSRF checks. Real sends use only a test conversation I authorize. Check the original receipt for unknown results; never replay with a new ID.

If a background service is needed, stop the foreground instance, run node bin/pocket.mjs service install --apply and read back service status. Use service uninstall --apply to stop/remove the owned background instance while retaining data. Report version, URLs, config/data/passphrase-file locations, verified and unverified results, and stop/backup/recovery instructions.
```

</details>
