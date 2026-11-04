# Privacy and data flow

Pocket displays and controls your own Mac's Codex conversations. The interface language does not translate or upload conversation content to a translation service. There is no Pocket-hosted multi-user account service in this repository.

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

The current browser implementation has an origin allowlist and only starts analytics in the authenticated app. An unknown self-host origin does not automatically send events to the author's analytics project. Once enabled on an allowed origin, usage events may include conversation/request identifiers, timing, visibility, status and client version. Session recording is also capable of observing rendered UI; network-body/console recording settings alone do not prove conversation text is masked. Use local masking and verify a recording with synthetic sensitive content before enabling it. Remote analytics-project controls have not been independently certified here.

Do not retain someone else's project key or endpoint when adapting the configuration. A public ingestion key is not a login secret, but it still chooses where data is sent. Third-party retention and access rules belong to that configured service and must be communicated to its users.

## Feedback

Feedback is disabled when a valid private feedback configuration is absent. When enabled and actively submitted, a report can contain the user's note, annotations, original/annotated screenshot, page URL/title, conversation identifier, viewport/device information, client version and optional replay association. It is stored on the Mac and may be sent to the configured analytics service and a fixed developer conversation for handling.

The report is editable before submission. Shake-to-feedback is an explicit opt-in feature. Screenshots can include private content already visible on the page; the operator must provide a suitable handling destination and retention policy. Signed delivery and immutable IDs prevent accidental rerouting or repeated work, but do not make a screenshot non-sensitive.

## Practical choices

Use a dedicated private data directory, unique credentials, explicit machine profiles and the smallest remote-access surface you need. Keep telemetry and feedback opt-in, check screenshots before sending them, remove cached site data on shared devices, and review the actual deployment and service policies before processing other people's material.
