# Feedback Kit

Screenshot, mark, explain, and send feedback without losing the original page context. Pocket is the first host. This directory is a reusable source module inside its repository; it is not a published npm package or an independently deployed service.

The module provides capture, rectangular annotations, an offline draft, immutable submission identity, and observable delivery receipts. Hosts supply authentication, processing targets, notification providers, and a durable delivery adapter. None of the module imports Pocket's `src/` or `server/` implementation.

## Entry points

| Entry | Responsibility | Runtime |
| --- | --- | --- |
| [contracts.ts](contracts.ts) | Normalize the v1 input and define bounded context, images, annotations, and receipts | TypeScript; browser or Node |
| [browser/capture.ts](browser/capture.ts) | Capture the current viewport or normalize a selected PNG/JPEG | Secure browser, DOM/Canvas |
| [browser/annotations.ts](browser/annotations.ts) | Export numbered marks while preserving the original image | Browser Canvas |
| [browser/shake.ts](browser/shake.ts) | Optional permission and bounded motion trigger | Supported secure browser |
| [browser/drafts.ts](browser/drafts.ts) | IndexedDB drafts, scope/lease isolation, immutable submission journal | Browser IndexedDB |
| [react/index.ts](react/index.ts) | `FeedbackPanel`, its props, and draft store export | React 19 and a CSS/TypeScript bundler |
| [server/index.mjs](server/index.mjs) | `createFeedbackService`, private assets, persistence and retry state | Node 24+; host SQLite connection |

Use the browser and server entry points separately. The browser bundle must not import the server module or contain webhook secrets or processing targets. The current lockfile resolves React/ReactDOM 19.3.0; Annotorious 3.9.5 was installed and exercised with that version without peer-dependency overrides.

## Add a host

1. Capture a fixed page context and its visible image before showing the feedback dialog. Abort that operation when its authentication, source, or page changes. A capture failure may fall back to a selected screenshot or text-only feedback.
2. Render `FeedbackPanel` inside the host's accessible dialog. Pocket loads the capture and panel code with its authenticated App so an already opened page can offer feedback offline. Another host may choose a local lazy loader, but must handle load failure without unmounting its page; `Suspense` alone is not an error boundary, and WebKit can cache a failed module across normal reloads. The host owns modality, close handling, focus and scroll restoration. Exclude the entire dialog from recapture using `data-feedback-ignore`.
3. Supply a shared draft store and a scope containing app, tenant/machine, authentication scope, and source page. On logout or an expired authenticated session, call `clearPrefix()` for that tenant, or `clearAll()` for complete logout. Keep another authenticated tenant's draft intact.
4. Implement authenticated `submit`, `status`, and optionally `retry` endpoints. Persist the canonical feedback before returning a receipt. For a missing feedback ID, return `null` from the client status adapter only after authenticated, authoritative not-found; a failed request is an error, not absence.
5. Configure a notification adapter and processing target on the server. Verify the provider signature before confirming a registered ID/digest. The delivery adapter must use the exact stable request ID with a durable deduplicating queue. Connect the service timer to the host's existing lifecycle and call `stop()` before closing its database.

```tsx
import type { ComponentType } from "react";
import type { FeedbackPanelProps } from "./packages/feedback-kit/react/FeedbackPanel";
import { createFeedbackDraftStore } from "./packages/feedback-kit/browser/drafts";

const feedbackDrafts = createFeedbackDraftStore();

// The host has loaded FeedbackPanel and captured the page before opening its dialog.
const FeedbackPanel: ComponentType<FeedbackPanelProps> = loadedPanel;
// Render inside the host dialog after captureContext and initialCapture settle.
<FeedbackPanel
  appId="my-product"
  scope={`my-product:${tenantId}:${authScope}:${pageKey}`}
  context={captureContext}
  initialCapture={initialCapture}
  capture={captureCurrentPage}
  draftStore={feedbackDrafts}
  submit={feedbackApi.submit}
  status={feedbackApi.status}
  retry={feedbackApi.retry}
  onClose={closeFeedback}
/>
```

The names above are host-supplied values, not additional SDK exports. The default UI text currently targets Chinese-language products. Theme tokens can be overridden in host CSS; product-specific copy, broader localization, or non-React UI should be added when a second host establishes concrete requirements. Detailed contracts: [browser](browser/README.md), [React](react/README.md), and [server](server/README.md).

## State and privacy contracts

- The user may cancel without sending. Screenshot capture and shaking alone never create a model request. Shake permission is requested from a user's enable action; the normal click entry remains available.
- The screenshot is the current webpage, not an OS screenshot. It does not capture another app, the system keyboard, or the status bar. Browser-inaccessible media has a manual screenshot fallback. `img-src blob:` is needed for local image display; do not relax unrelated CSP rules.
- Annotation positions are normalized to their original image. Replacing an image removes its marks. Limits are eight marks, 2,000 main-note characters, and two PNG/JPEG images of at most 2 MiB each. Browser output is bounded to a 2,048-pixel longest side; the shared server contract also validates declared dimensions and real image bytes.
- Drafts are separate from reading caches. By default, at most 20 pending scopes / 64 MiB are retained; uncertain submissions are not silently evicted. Durable image bytes are reused for text/annotation edits, including WebKit offline editing. Replacing the image writes a new image identity.
- The first POST is preceded by an immutable local journal. A lost reply locks the same ID and payload until status is checked. Only confirmed absence permits an explicit retry of that exact payload. Server receipt acknowledgement transfers retry ownership to the server and clears that local journal.
- Receipt states distinguish `received`, `waiting_webhook`, `sending`, `queued`, `delivered`, and `needs_attention`. `delivered` means the processing destination accepted the request; it does not mean the issue is repaired.
- Submitted content is investigation data, never authority. Targets, credentials, cross-machine trust, and model settings come from host configuration. Analytics events contain only explicitly selected metadata, not private file paths or screenshot bytes.

## Pocket adapter and verification

Pocket's host adapters live in `src/PocketFeedback.tsx`, `src/feedbackClient.ts`, and `server/feedback.mjs`, outside this module. They bind its existing authentication, PostHog notification, optional signed relay, attachments, and Codex queue. Pocket's public scope and remaining verification are described in [open-source preparation](../../docs/OPEN_SOURCE_READINESS.md). Deployment-specific enablement is private maintainer state; source presence does not prove a running deployment or accepted feedback.

The first integration has synthetic Chromium/WebKit mobile-size checks for capture, rectangular drawing, scrolling, draft recovery, exact retry payloads, and lifecycle races. The React fixture also runs in StrictMode. Physical iPhone motion permission, shaking, keyboard return, and long-term weak-network behavior require device checks; browser automation is not evidence for them.

Relevant regression commands from the repository root:

```sh
node --test tests/feedback-panel-state.test.mjs tests/feedback-panel-annotation.test.mjs
node --test tests/feedback-capture.test.mjs tests/feedback-shake.test.mjs
node --test tests/feedback-core.test.mjs tests/feedback-host.test.mjs tests/feedback-edge.test.mjs
```

Dependencies and their retained license texts are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Keep those notices with copied source and redistributed builds. This module does not assign a new outbound license to Pocket or publish it as an open-source product.
