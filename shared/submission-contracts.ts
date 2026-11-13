// Wire and presentation types only: this module adds no runtime executor.
export type SubmissionStatus = "accepted" | "queued" | "editing" | "cancelled" | "pending" | "unknown" | "rejected" | "not_found";
export type DispatchReceiptIdentity = { requestId: string; status: SubmissionStatus };

// Only these fields belong to a submitted upload manifest. Local UI state is
// deliberately separate; status/error cannot authorize a file or a dispatch.
export type AttachmentUploadManifestEntry = Readonly<{
  id: string; name: string; size: number; mime: string; sourceSha256?: string;
}>;
export type AttachmentUploadDescriptor = Readonly<{
  id: string; name: string; size: number; mime: string;
  status?: "missing" | "queued" | "uploading" | "uploaded" | "failed" | "unknown"; error?: string;
}>;
export type AttachmentUploadProgress = Readonly<{
  total: number; uploaded: number; status: "uploading" | "ready" | "failed"; code?: string;
}>;

export type StopInput = Readonly<{ requestId: string; expectedTurnId: string }>;
export type ResumeQueueInput = Readonly<{ expectedStopId: string }>;
export type StopStatus = "pending" | "accepted" | "unknown" | "rejected" | "stopped" | "ended" | "not_found";
export type RecordedStopReceipt = {
  requestId: string;
  targetTurnId: string;
  status: Exclude<StopStatus, "not_found">;
  // SQL returns null when there is no diagnostic.
  code: string | null;
};
export type StopReceipt = RecordedStopReceipt | {
  requestId: string; status: "not_found"; targetTurnId?: undefined; code?: undefined;
};
