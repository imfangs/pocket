// Compile-time acceptance only; tsc never emits or executes this fixture.
import { dispatchResponse } from "../../server/dispatch-response.mjs";
import { ExecutionStops } from "../../server/execution-stops.mjs";
import { validateAttachmentUploadManifest } from "../../server/attachment-upload-validation.mjs";
import type { NavigatorStore } from "../../server/store.mjs";
import type {
  AttachmentUploadManifestEntry, AttachmentUploadDescriptor, AttachmentUploadProgress,
  DispatchReceiptIdentity, RecordedStopReceipt, StopInput, StopReceipt, StopStatus,
} from "../../shared/submission-contracts.ts";

declare const store: NavigatorStore;
declare const externalJSON: unknown;
const stops = new ExecutionStops(store, async payload => {
  const operation: "stop" = payload.operation;
  const turn: string = payload.expectedTurnId;
  void [operation, turn];
  // @ts-expect-error An original-owner stop cannot introduce a replacement model.
  payload.model = "replacement";
  return { ok: false, sent: null, code: "dispatch_unknown" };
});
const stopResult: Promise<StopReceipt> = stops.stop("thread", externalJSON);
const receipt: StopReceipt = stops.receipt("thread", "request");
const persisted: RecordedStopReceipt | null = stops.latest("thread");
// @ts-expect-error A missing receipt does not prove a target turn.
const definiteTurn: string = receipt.targetTurnId;
const missing: StopReceipt = { requestId: "request", status: "not_found" };
const noDiagnostic: RecordedStopReceipt = { requestId: "request", targetTurnId: "turn", status: "accepted", code: null };
// @ts-expect-error A found API receipt cannot omit its original target turn.
const untargetedReceipt: StopReceipt = { requestId: "request", status: "accepted", code: null };
// @ts-expect-error A persisted stop is tied to the original target turn.
const untargeted: RecordedStopReceipt = { requestId: "request", status: "unknown", code: null };
// @ts-expect-error An accepted interruption is not a completed model turn.
const wrongStatus: StopStatus = "completed";
// @ts-expect-error Stop inputs retain both request and expected turn identity.
const missingRequest: StopInput = { expectedTurnId: "turn" };
// @ts-expect-error Stop bridge results cannot replace a boolean with a string.
new ExecutionStops(store, async () => ({ ok: "true" }));

const manifest: AttachmentUploadManifestEntry[] = validateAttachmentUploadManifest(externalJSON, 20 * 1024 * 1024);
const originalHash: string | undefined = manifest[0]?.sourceSha256;
const display: AttachmentUploadDescriptor = { id: "file", name: "file.txt", size: 1, mime: "text/plain", status: "unknown" };
// @ts-expect-error Local progress does not belong in an upload admission input.
const manifestWithState: AttachmentUploadManifestEntry = { id: "file", name: "file.txt", size: 1, mime: "text/plain", status: "uploaded" };
// @ts-expect-error A database cancellation is not a public upload progress state.
const progress: AttachmentUploadProgress = { total: 1, uploaded: 0, status: "cancelled" };
// @ts-expect-error Admission requires a numeric byte limit.
validateAttachmentUploadManifest(externalJSON, "large");

declare const originalOperation: Promise<{ requestId: string; status: "accepted"; turnId: string }>;
const response = await dispatchResponse(originalOperation, () => ({ requestId: "request", status: "pending" }));
if (response.status === 200) {
  const originalTurn: string = response.data.turnId;
  void originalTurn;
} else {
  const awaitingOriginal: "pending" = response.data.status;
  // @ts-expect-error A 202 receipt does not claim an accepted model turn.
  const acceptedTurn: string = response.data.turnId;
  void [awaitingOriginal, acceptedTurn];
}
// @ts-expect-error Every dispatch receipt retains the original request ID.
await dispatchResponse(Promise.resolve({ status: "accepted" }), () => ({ requestId: "request", status: "pending" }));
// @ts-expect-error Misspelled dispatch states cannot silently become a wire contract.
const misspelled: DispatchReceiptIdentity = { requestId: "request", status: "acceptd" };

void [stopResult, receipt, persisted, definiteTurn, missing, noDiagnostic, untargetedReceipt, untargeted, wrongStatus, missingRequest,
  manifest, originalHash, display, manifestWithState, progress, misspelled];
