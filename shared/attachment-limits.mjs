// Shared client/server upload admission limits. A message only becomes a
// dispatchable attachment snapshot after all of its files have been verified.
export const MAX_ATTACHMENTS = 16;
export const MAX_ATTACHMENT_UPLOADS = 16;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 1024 * 1024 * 1024;
