export type UserEnvelopeAttachment = { name: string; path: string; kind: 'image' | 'file' };
export type UserAttachmentEnvelope = { query: string; attachments: UserEnvelopeAttachment[]; imageTransport: boolean };
export function userAttachmentEnvelope(text: unknown): UserAttachmentEnvelope | null;
