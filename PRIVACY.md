# Privacy and data flow

Pocket displays and controls your own Mac's Codex conversations. The interface language does not translate or upload conversation content to a translation service. There is no Pocket-hosted multi-user account service in this repository.

## Where private data lives

These are the defaults for a new installation. An operator can select another absolute data/configuration location; inspect the private `config.json` to identify the actual installation.

| Location | Contents | Git boundary |
| --- | --- | --- |
| `~/.codex/` | Original Codex conversations, rollout files, desktop metadata and Codex credentials | Separate from the Pocket source; preserve Codex ownership |
| `~/Library/Application Support/CodexNavigator/navigator.sqlite` | Pocket catalog, names/paths, preferences, reading metadata, submitted/queued text, operation identities/receipts, sessions and notification registrations | Default is outside the source checkout |
| Same data directory: `attachments/`, `feedback-assets/`, `backups/` | Uploaded files, optional submitted screenshots and local metadata backups | Default is outside the source checkout; backups are private |
| Same data directory: `initial-passphrase.txt`, `web-push-keys.json`, optional `feedback-config.json`, relay registration/connection files | Login bootstrap passphrase, push private key and optional integration credentials | Default is outside the checkout; never include in an issue or artifact |
| `<checkout>/.local/pocket/config.json`, `bridge.json`, `logs/` | Installation paths/origin, desktop bridge paths and user-service logs | `.local/` is ignored; an explicit `--config` uses its parent directory instead |
| Browser IndexedDB: `pocket-reading-cache-v1` | Bounded conversation catalog and recent-message reading projections | Browser storage, separate from Git |
| Browser IndexedDB: `feedback-kit-drafts-v1`; origin-scoped browser preferences/reading watermarks | Optional unsent feedback text/screenshots and local UI/read state | Browser storage, separate from Git |

Ordinary unsent conversation input is protected in the current page's memory; it is not part of the persistent reading cache. Submitted queue text and receipts are persisted on the Mac. An uploaded attachment can already be present on the Mac even before its message is sent. The model provider used by Codex receives the content you submit according to that provider's own policy.

Private directories/files are created with restricted permissions where the implementation supports them (typically `0700`/`0600`). Pocket does not add encryption at rest for its SQLite, attachments, screenshots or browser cache. The logged-in OS account and device/browser security remain part of the boundary.

## Keep data out of Git

Use the default data directory or another dedicated private directory outside every source checkout. Keep custom configuration, credentials and diagnostic evidence under ignored `.local/` or outside the checkout. Source examples use placeholder hosts; runtime origins and credentials belong to the private installation configuration.

The supplied `.gitignore` covers the default local state, SQLite/databases, logs, environment files, private keys and common private-data overrides. It does not remove already tracked files and it cannot prevent `git add --force`, a differently named private file, or a screenshot inserted into source. Before committing in a public checkout, run:

```sh
npm run privacy:check -- --staged
git diff --cached --stat
```

The check reads the actual Git index and reports file names and rule categories without printing matched values. It recognizes private file paths and known local deployment domains/home paths/infrastructure identifiers, including the default `.local/pocket/config.json` and an explicitly selected `POCKET_CONFIG`. On an exported source directory, it inspects the real file tree, detects unlisted additions and verifies the manifest hashes. Additional values can be supplied through `POCKET_SOURCE_PRIVACY_DENY_FILE`, an absolute ignored/private JSON file containing `{"values":["a-private-value-to-reject"]}`. A clean public clone cannot automatically recognize every new owner's real domain or arbitrary secret before it has been configured or registered; the owner must register such values or review them locally. This is a release guard, not proof that all arbitrary secrets or Git history are safe. Review staged content locally as well.

For publication, use `npm run package:source -- --out /absolute/new/source-directory`, inspect that exported baseline, and initialize a fresh public Git repository there. The exporter uses an allowlist, resets telemetry to disabled/empty, excludes private runtime paths, and checks outgoing bytes for known private markers before creating output. It does not copy `.git` history. A private maintainer repository's current files, branches, history, tags and operations documentation require separate review; adding `.gitignore` cannot make that history public-safe.

## Data on your Mac

Codex remains the original conversation owner. Pocket reads the configured source and keeps its own catalog, preferences, reading metadata, queued submissions, operation receipts and authentication records in a private data directory. Uploaded attachments and optional feedback screenshots are stored there separately. A Pocket metadata backup does not replace a backup of the original Codex conversations.

Do not put the data directory, credentials, logs, exports or screenshots inside the public build or source repository. Treat backups as private data. Deleting Pocket's own data does not automatically delete the original Codex conversations; uninstall and recovery instructions should make that distinction explicit.

## Data on your phone or browser

The authenticated client can cache a bounded projection of the conversation list and recent messages in memory and IndexedDB. The reading cache has a configurable conversation limit and a 30 MiB budget; that budget does not describe all browser storage or uploaded files. Unsaved input and pending actions are protected by their own controllers. Optional feedback drafts can also contain text and screenshots.

After a successful logout response, the client attempts to purge reading and feedback caches and closes authenticated access. Browser or storage failures may prevent a complete purge; use the browser's site-data controls on a shared or lost device. Origin-scoped storage and OS/device protection are not application-level encryption of cached conversation content. Public service-worker caching is limited to the shell, icons and offline assets, not private API responses.

## Data in transit

With direct HTTPS or a private network, you configure the connection to your Mac. With a Cloudflare relay, request and response content passes through that intermediary. TLS protects each hop; Pocket does not add application end-to-end encryption between the phone and Mac. The provider or operator terminating those hops is part of the trust boundary.

Relay address metadata can be stored separately from conversation data, but that does not mean the relay cannot observe traffic. Protect relay configuration and registration credentials, use your own deployment account and domain, and consider a private-network profile when the conversations contain work or personal material.

## Analytics and session recording

Analytics is an optional integration. Public self-host profiles should keep analytics and replay disabled until the operator deliberately configures their own project and decides what may be collected. Existing installations can have different private settings; review the shipped configuration rather than assuming it applies globally.

The current browser implementation has an origin allowlist and only starts analytics in the authenticated app. An unknown self-host origin does not automatically send events to the author's analytics project. Once enabled on an allowed origin, usage events may include conversation/request identifiers, timing, visibility, status and client version. The local recorder masks inputs and all text and disables network-header/body and console recording. Those settings are not a certification of every third-party capture path or remote project control; verify a recording with synthetic sensitive content before enabling it.

Do not retain someone else's project key or endpoint when adapting the configuration. A public ingestion key is not a login secret, but it still chooses where data is sent. Third-party retention and access rules belong to that configured service and must be communicated to its users.

## Feedback

Feedback is disabled when a valid private feedback configuration is absent. When enabled and actively submitted, a report can contain the user's note, annotations, original/annotated screenshot, page URL/title, conversation identifier, viewport/device information, client version and optional replay association. It is stored on the Mac and may be sent to the configured analytics service and a fixed developer conversation for handling.

The report is editable before submission. Shake-to-feedback is an explicit opt-in feature. Screenshots can include private content already visible on the page; the operator must provide a suitable handling destination and retention policy. Signed delivery and immutable IDs prevent accidental rerouting or repeated work, but do not make a screenshot non-sensitive.

The feedback delivery event sent to an enabled analytics service includes the submitted note, reason, page URL, source-conversation ID, viewport/version and screenshot/annotation counts. Screenshot files are kept on the Mac and included when delivered to the configured developer conversation; a cross-machine feedback relay transports the selected report/images to that configured target. There is no automatic upload to the project author's account in the generic source profile.

## Optional notifications

Enabling Web Push stores the device's push subscription on the Mac and uses the browser platform's push provider. The encrypted payload contains a generic completion/failure/attention status, machine/conversation identifiers and an event identifier, not the conversation title or reply text. A push provider is still an external dependency and can observe connection/delivery metadata.

## Practical choices

Use a dedicated private data directory, unique credentials, explicit machine profiles and the smallest remote-access surface you need. Keep telemetry and feedback opt-in, check screenshots before sending them, remove cached site data on shared devices, and review the actual deployment and service policies before processing other people's material.
