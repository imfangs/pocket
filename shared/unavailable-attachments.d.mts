export type UnavailableAttachment = Readonly<{ name: string; kind: 'image' | 'file' }>;
/** Pure native metadata projection, never a path/URL/ID or file capability. */
export function unavailableAttachmentNames(value: unknown): UnavailableAttachment[];
/** Validate/copy name and kind only; a blank name is a generic sibling slot. */
export function sanitizeUnavailableAttachments(value: unknown): UnavailableAttachment[];
