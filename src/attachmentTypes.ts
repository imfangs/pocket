export type PublicAttachment = {
  id: string; name: string; size: number; mime: string; kind: "image" | "file"; url: string; sha256: string;
  sourceSha256?: string; sourceSize?: number; previewUrl?: string;
  previewSha256?: string; previewMime?: string; previewSize?: number;
};

export type DraftAttachment = {
  id: string; name: string; size: number; mime: string; kind: "image" | "file";
  status: "queued" | "uploading" | "uploaded" | "failed" | "unknown" | "removing";
  file?: File; attachment?: PublicAttachment; sourceSha256?: string; error?: string; checking?: boolean;
  deletePending?: boolean;
};
