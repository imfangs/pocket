// @ts-check
import { AppError } from './store.mjs';
import { MAX_ATTACHMENTS } from '../shared/attachment-limits.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * External JSON remains unknown until every allowed manifest field is checked.
 * This is upload admission only; it does not verify originals or allow sending.
 * @param {unknown} descriptors
 * @param {number} maxBytes
 * @returns {import('../shared/submission-contracts.ts').AttachmentUploadManifestEntry[]}
 */
export function validateAttachmentUploadManifest(descriptors, maxBytes) {
  if (!Array.isArray(descriptors) || !descriptors.length || descriptors.length > MAX_ATTACHMENTS)
    throw new AppError(`每条消息最多添加 ${MAX_ATTACHMENTS} 个附件`);
  const seen = new Set();
  // Array.isArray narrows to any[]; restore unknown at the untrusted seam.
  return /** @type {unknown[]} */ (descriptors).map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('附件上传清单无效');
    const item = /** @type {Record<string, unknown>} */ (value);
    if (Object.keys(item).some(key => !['id', 'name', 'size', 'mime', 'sourceSha256'].includes(key)) ||
        typeof item.id !== 'string' || !uuid.test(item.id) || seen.has(item.id) ||
        typeof item.name !== 'string' || !item.name.trim() || item.name.length > 180 ||
        /[\\/\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(item.name) || ['.', '..'].includes(item.name) ||
        typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > maxBytes ||
        typeof item.mime !== 'string' || item.mime.length > 128 || /[\x00-\x20\x7f-\x9f\u2028\u2029]/.test(item.mime) ||
        item.sourceSha256 !== undefined && (typeof item.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sourceSha256)))
      throw new AppError('附件上传清单无效');
    seen.add(item.id);
    return { id: item.id, name: item.name, size: item.size, mime: item.mime,
      ...(item.sourceSha256 === undefined ? {} : { sourceSha256: item.sourceSha256 }) };
  });
}
