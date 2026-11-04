# Self-host Pocket (Alpha)

Pocket is a single owner's high-trust phone interface to their Mac's existing Codex conversations. It is not a hosted multi-user service. You provide the Mac, signed Codex desktop app and its login, storage, and HTTPS entry. Pocket does not provide model credentials or an OpenAI subscription.

## Requirements

Use Node.js 26.x and Python 3.11 or newer on macOS. Start and sign into Codex at least once. The supported source layout and honest compatibility boundaries are in [COMPATIBILITY.md](COMPATIBILITY.md). The included desktop client uses Python's standard library; installing the author's FBT workspace is unnecessary.

From an extracted source candidate or clone:

```sh
npm ci
npm run setup
npm run build
npm run doctor
npm start
```

The service listens on `127.0.0.1:4397`. Startup prints the protected local passphrase-file location, never its value. Read that file locally and sign in. This is a local bootstrap; `127.0.0.1` on a phone refers to the phone, not the Mac.

Setup writes an ignored `.local/pocket/config.json` plus an explicit bridge profile. It is idempotent and does not overwrite an existing configuration. Use `--config /absolute/path/config.json` for a separate installation. For isolated trials, always supply different `--data-dir` and `--codex-home`; never test writes against real Codex storage.

The defaults are source-external `~/Library/Application Support/CodexNavigator/` for Pocket data and `~/.codex/` for original Codex source. Local configuration, bridge paths and service logs stay in ignored `.local/pocket/`. Keep custom data, backups and secret configuration outside the source checkout; [PRIVACY.md](../PRIVACY.md) lists individual files, browser storage and third-party transmission boundaries.

```sh
npm run setup -- --data-dir /absolute/private/pocket-data \
  --codex-home /absolute/path/to/.codex --port 4397 \
  --machine-id local --label "My Mac"
```

Carry the same config through every subsequent command. For a nondefault configuration:

```sh
npm run setup -- --config /absolute/private/pocket/config.json
npm run build
npm run doctor -- --config /absolute/private/pocket/config.json
npm start -- --config /absolute/private/pocket/config.json
```

Stop the foreground process with Ctrl+C. Before creating a second installation, inspect the selected configuration and existing services; preserve their data, port and request identities. An existing config causes setup to return `created:false`: new flags are ignored, including a changed origin or data directory.

For local acceptance, check `GET /api/health` succeeds and `GET /api/catalog` without authentication returns 401. After your local login, verify list and message reads. Report `doctor`'s environment checks separately from actual desktop controls and phone connectivity. Read-only acceptance does not require a model request; a real send needs a chosen, authorized test conversation, and an unknown result must be checked against its original receipt before retrying.

## Phone access through your own HTTPS proxy

Keep the Node API on loopback. Put your own trusted HTTPS reverse proxy or private Tailnet HTTPS entry in front of it. Preserve the original Host and send a trustworthy `X-Forwarded-Proto: https`; strip untrusted incoming forwarding headers. Configure the exact public origin before using it. Do not disable Host, Origin, CSRF or authentication checks, and do not expose the loopback API by changing it to `0.0.0.0`.

For a new installation:

```sh
npm run setup -- --public-origin https://pocket.example.com
```

For an existing installation, edit the ignored config: `client.publicOrigin` and `deployment.publicOrigin` must match. Keep machine IDs, data location, and browser origin stable to retain stored preferences and reading state. HTTPS public deployment enforces at least 12 characters for newly set passphrases; older saved authentication is not silently rotated. Review its recorded policy and rotate weak or unknown legacy credentials before exposure.

Open your own HTTPS URL on the phone, sign in, then use Safari's Share → Add to Home Screen or the supported browser install action. The private `/api/deployment/status` separates basic configuration/storage/source checks from desktop and external network checks. `doctor` is an environment preflight, not proof that phone routing, desktop ownership, or every model operation works.

For example, a Caddy HTTPS site on your own domain can forward directly:

```caddyfile
pocket.example.com {
    reverse_proxy 127.0.0.1:4397
}
```

Provision your own DNS/certificate and restrict who can reach this high-trust entry. Private Tailnet HTTPS is also an option; validate its preserved Host and HTTPS forwarding headers against your declared origin. A named stable tunnel or private proxy is preferable for routine use; the optional Quick Tunnel adapter has no availability guarantee.

Cloudflare relay source is provided as an optional advanced adapter, not an account belonging to the author. Create your own Pages project, KV binding, registration credential and public client profile; never copy the author's identifiers or secrets. `POCKET_CLIENT_CONFIG=/absolute/public-profile.json npm run build:pages` packages that validated public profile. Direct self-hosted HTTP/HTTPS serves `/client-config.js` from the server's public projection; no secret or desktop path is included.

For the legacy Quick Tunnel connector, provide your own `NAVIGATOR_RELAY_CONFIG` using `config/relay.example.json`, set `NAVIGATOR_MACHINE_ID`, and find `cloudflared` on PATH or set `CLOUDFLARED` to its exact executable. `NAVIGATOR_API_ORIGIN` can select a different bare loopback HTTP port. Registration credentials remain in the protected data directory; deployment credentials and relay namespaces are yours to provision.

## User-level background service

After validating the foreground service, stop it before installing the user service. No root daemon or `sudo` is needed. Commands without `--apply` show the owned installation plan.

```sh
node bin/pocket.mjs service install --apply
node bin/pocket.mjs service status
node bin/pocket.mjs service uninstall --apply
```

Append `--config /absolute/private/pocket/config.json` to each command for a nondefault config, including `status` and `uninstall`. There is no `service stop` subcommand: foreground instances stop with Ctrl+C; `service uninstall --apply` stops and unregisters the owned background instance while preserving its data.

The LaunchAgent uses the detected Node executable, the chosen config file and private logs. Uninstall removes only that owned service registration. It preserves Pocket configuration/data, attachments and all original Codex data. To remove code, stop the service first and handle your repository and data explicitly.

## Password maintenance

Use stdin; never put a password in command arguments, URLs, screenshots, issues or a public config. With a nondefault Pocket config, point `POCKET_CONFIG` at it before calling the maintenance command:

```sh
POCKET_CONFIG=/absolute/path/config.json node bin/access.mjs info
POCKET_CONFIG=/absolute/path/config.json node bin/access.mjs rotate
POCKET_CONFIG=/absolute/path/config.json node bin/access.mjs set --stdin
```

Rotation revokes sessions and notification registrations. It does not delete queued messages. See [SECURITY.md](../SECURITY.md) and [PRIVACY.md](../PRIVACY.md), and follow [UPGRADING.md](UPGRADING.md) for complete snapshots and rollback.

## Troubleshooting

- Unsupported Node/Python: install the declared version; a model subscription cannot fix a missing local runtime.
- Desktop/source unavailable: open Codex and check the exact local layout. Do not invent another database filename or edit Codex SQLite.
- Codex installed outside the standard applications folders: set `appPath` in the selected private `bridge.json` to its actual signed bundle, check the chosen Python executable, then rerun doctor with the same Pocket config. Keep these machine-specific absolute paths out of public source.
- Host/Origin rejection: fix the configured HTTPS origin and trusted proxy headers; do not remove security guards.
- Busy original conversation: read-only history can remain available while mutation waits for the original desktop writer. Some archive/restore operations may remain pending.
- Unconfirmed send/creation: preserve its original request ID, check the receipt, and do not submit it again as a new request.

This Alpha candidate still requires independent first-install and real phone acceptance on the intended Mac/Codex combination before a broad public release claim.
