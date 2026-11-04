# Security

Pocket is a single-owner remote interface to a Mac's Codex conversations. An authenticated device can read conversations and request actions from the existing desktop owner, including sending messages, responding to approvals and stopping execution. Those actions inherit the original conversation's model, workspace and permissions. A Pocket session is a control credential, not a read-only share link.

## Supported boundary

- Keep the Mac API on loopback. Remote access should use a trusted HTTPS reverse proxy or a private network such as Tailscale; do not expose the raw HTTP port.
- Treat the browser session, local CLI token, tunnel registration key and feedback webhook keys as sensitive credentials. A relay operator or compromised registration key can change where traffic goes; protect this configuration accordingly.
- This is not a multi-tenant service. Sharing one installation's password shares its available conversations and control surface. There are no separate user roles or per-person project permissions.
- Desktop compatibility and supported operations remain release-specific. Unknown RPC results must be checked by their original request identity; they are not permission to repeat a send or approval.

## Self-host configuration

Set `NAVIGATOR_DEPLOYMENT_CONFIG` to an absolute path to a private JSON file. The schema accepts only the declared fields:

```json
{
  "schemaVersion": 1,
  "publicOrigin": "https://pocket.example.com",
  "allowedHosts": ["pocket.example.com"],
  "machineId": "my-mac",
  "minimumPassphraseLength": 12
}
```

`publicOrigin` must be a bare HTTPS origin: no credentials, path, query or fragment. It is normalized to an origin and admitted to the hostname allowlist. `allowedHosts` accepts exact hostnames or IP addresses, without wildcard patterns, schemes or ports. Loopback hosts remain available for the local CLI. The configured public host must arrive using its exact HTTPS origin and port.

The proxy must preserve the intended Host and overwrite `X-Forwarded-Proto` with the protocol it actually terminated. Do not trust a client-supplied forwarding header, disable Host/Origin/CSRF checks, or enable wildcard CORS. A local bearer is refused when forwarding indicators are present. Validate the actual proxy path rather than assuming a green process check proves the public entry is ready.

The public `/client-config.js` contains only machine IDs, display labels and an optional public origin. These values are public configuration; do not put passwords, tokens or private paths in machine labels. The script does not contain the server's deployment JSON or authentication settings.

`NAVIGATOR_CLIENT_CONFIG` can point to an absolute, validated public-profile JSON file when preserving an existing multi-Mac installation. An explicit application profile takes precedence. This separate file must contain public client fields only; it is not the private deployment or credential configuration.

Advanced Cloudflare relays may reach the Mac through its registered Quick Tunnel transport. An explicit public-origin deployment admits only the exact active transport from its private connection record, with the same Host, HTTPS-origin, Cookie, CSRF and local-bearer checks. An arbitrary tunnel hostname or an invalid/inactive record is not admitted. Direct HTTPS remains the primary self-host path; transport admission does not certify an external relay is configured correctly.

## Passwords and existing installations

Fresh public-origin deployments require at least 12 characters for initial or replacement passwords and generate a random initial password. This length floor does not make a repetitive or reused password safe; prefer the generated password or a unique password-manager value.

Existing password files and valid sessions are deliberately retained when the deployment policy changes. A new policy does not revalidate an old password hash, silently rotate credentials or log out devices. Before exposing an existing installation publicly, explicitly review or replace its password using the same deployment configuration. `bin/access.mjs set --stdin` receives a replacement through standard input; keep it out of URLs and command arguments. Password replacement revokes browser sessions and push subscriptions. The local CLI token is separate and remains local-only.

An installation without an explicit deployment file keeps the legacy minimum for compatibility. Public releases should use the explicit profile; four-character test passwords are not an appropriate Internet deployment policy.

## Data and deployment controls

- Keep the data directory private and owned by the account running Pocket. New data directories use mode `0700`; SQLite, access configuration and initial password files use `0600`. Review permissions of existing or restored directories as part of setup.
- Browser cookies are host-only, HttpOnly and SameSite=Strict; HTTPS responses add Secure. Sessions are stored as hashes, expire, and can be revoked. Private API responses are not placed in the public service-worker cache.
- File and image endpoints use references tied to the conversation and workspace, with bounded reads and path/symlink checks. Uploaded files are separate private data. A browser request cannot supply an arbitrary local download path.
- Optional feedback uses authenticated submission, signed callbacks, a fixed configured target and an immutable request identity. Feedback text and screenshots are input data, never authority to change permissions or delivery destinations.
- `/api/health` is a minimal liveness check. Authenticated `/api/deployment/status` reports initialization and the last source scan without returning private paths or credentials. Desktop and external-entry readiness are explicitly unverified there; perform the installation's end-to-end checks separately.

## Reporting and release checks

Do not publish conversation contents, passwords, cookies, tokens or raw private logs in an issue. Use private vulnerability reporting when it is enabled on the published repository. If no private channel is listed, ask the maintainer for one without disclosing the sensitive details publicly. A public release must establish that channel before advertising security support.

Security reports should include the affected release, deployment profile, reproducible steps with synthetic data and the boundary crossed. Maintainers should distinguish confirmed failures from deployment assumptions, preserve unknown-result safety and provide a regression test for a fix. No response-time or support commitment is currently advertised.

Before release, validate a clean installation, private-file permissions, anonymous and cross-origin rejection, session expiry/revocation, the real proxy identity/HTTPS behavior, attachment boundaries and recovery from an interrupted operation. Source publication also requires a reviewed public snapshot and secret/PII checks; `.gitignore` and a pattern scan alone are not historical clearance.
