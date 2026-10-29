# Feedback server module

This module owns canonical feedback, local assets, retry state, and the handoff between a notification provider and an idempotent delivery adapter. It has no Pocket imports, credentials, URLs, or model implementation.

```js
const service = createFeedbackService({
  db, directory, machineId,
  resolveTarget: appId => ({ machineId: 'processing-host', key: 'opaque-target' }),
  validateImage, publish, deliver, inspectDelivery, relay, inspectRelay,
});
service.start();
```

The host must authenticate before `submit(input)`, `receipt(id)`, `readImage(id, kind)`, or `retry(id)`. It must verify provider signatures before `confirm({id, digest})`, and service-to-service signatures before `receiveRelay(payload, trustedSourceMachine)` or a receipt lookup for another source. A notification event's body is not authorization.

`contracts.ts` exports the normalized v1 browser input, annotations/images/context, receipt status, and `FeedbackError {status, code}`. It rejects unknown authority fields, malformed geometry, excessive images and common credential query parameters. Image bytes are checked by the server, not trusted from client metadata.

## Host adapters

- `resolveTarget(appId)` is synchronous, trusted configuration. `{machineId, key}` is frozen into the canonical digest. Changing configuration cannot silently retarget existing reports.
- `validateImage(path, {mime,width,height})` must actually decode the private temporary file and return its dimensions. The module separately verifies PNG/JPEG signatures, declared bounds, and dimensions. The host must not leave decoder temporary files in the directory.
- `publish(record, {attemptId,attempt,signal})` sends a delivery-request event to the configured provider; resolve only after an acknowledged publish, throw for failure. Explicitly select event fields. Never spread the whole record (which includes private asset paths) into analytics. A new attemptId represents retrying notification delivery, not a new feedback.
- `deliver(record, {signal})` means **durably enqueue with the exact requestId**, not send directly through a non-idempotent executor. `inspectDelivery(record, {signal})` looks up that same durable ledger. Supported states are `queued`, `pending`, `accepted`, `unknown`, `not_found`, `rejected`, `cancelled`, and `editing`. `accepted` means the destination has accepted the request, not that the issue is fixed.
- `relay(payload, {signal})` sends the canonical payload to a processing host. The module reconstructs bounded image bytes. `inspectRelay(record, {signal})` reads its source-scoped receipt. The receiving host authenticates the source, then calls `receiveRelay(payload, source)`; imported feedback does not publish another provider event.

Callbacks must honor `signal`, especially immediately before an enqueue after asynchronous asset preparation. The delivery sink must deduplicate by requestId and immutable payload. An inspection may return `not_found` only for **authoritative absence in the verified destination ledger**. A network error, unavailable endpoint, generic 404, or malformed reply must throw. `unknown` is only inspected; it never directly retries delivery. Exact ledger absence permits another attempt at the same idempotent enqueue, covering a crash before durable handoff.

The callback record contains `id`, `sourceMachine`, `appId`, `digest`, deterministic custom UUID-v8 `requestId`, `createdAt`, trusted `target`, `note`, `reason`, `context`, `annotations`, `autoDirect`, and image metadata `{kind,mime,width,height,size,sha256,path}`. `readImage(id, kind, {sourceMachine})` revalidates the file and returns bytes/metadata without a path for safe host HTTP responses or attachment staging.

## Persistence and lifecycle

Storage uses the provided SQLite connection (`feedback_records_v1`) and `<directory>/feedback-assets`. The host retains ownership of the database. `stop()` must run before closing SQLite; it aborts in-flight adapters and prevents their late results from changing state. It does not erase records or make an uncertain delivery replayable.

Submission is immutable and idempotent per `(sourceMachine, id)`. Canonical hashes bind the normalized content, image hashes, source, and configured target. Images and manifests are private; public receipts expose no paths, image bytes, model credentials, or target key. A complete directory left by a rename-before-SQL crash is adopted only when the same submission and all asset hashes match.

Defaults are 1,000 retained reports, 256 MiB of committed image bytes, four concurrent saves, two images up to 2 MiB each, 12 publish attempts, 40 durable-enqueue attempts, and 200 consecutive uncertain inspections. Temporary saves add at most four bounded submissions. Confirmed queues remain observable rather than becoming errors merely because they wait a long time. Retry timers are part of the host's existing lifecycle, with exponential backoff and no independent daemon.

`retry(id)` is an authenticated explicit recovery action. It can retry publishing or resume inspection but preserves request identity and the fact that delivery may already have happened. No old provider records are imported automatically, and no retention cleanup silently removes screenshots associated with delivered or uncertain work. Hosts may later add an explicit retention policy with reference tracking.

`tick()` is available for deterministic tests and a host-controlled scheduler; `start()` owns one unref'ed timer. Methods do not keep a standalone CLI alive after its host exits.
