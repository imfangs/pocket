// Controlled stream mechanism measurement. No HTTP, private files, or phone
// measurements: fixed startup latency deliberately dominates these small files.
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { attachmentPath, createAttachmentDraftController, fileSha256, readyAttachments } from '../../src/attachments.ts';
import { createAttachmentUploadScheduler, MAX_ATTACHMENT_HASHES } from '../../src/attachmentUploadScheduler.ts';

const threadId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const results = [];
for (const concurrency of [1, 4, 8, 16]) {
  const drafts = new Map(), seen = new Set(); let active = 0, peak = 0, bytes = 0;
  const request = {
    async upload(_thread, item) {
      assert.equal(seen.has(item.id), false); seen.add(item.id);
      active++; peak = Math.max(peak, active);
      try {
        await setTimeout(25);
        for await (const chunk of item.file.stream()) { bytes += chunk.byteLength; await setTimeout(3); }
        return { id: item.id, name: item.name, size: item.size, mime: item.mime, kind: item.kind,
          url: attachmentPath(threadId, item.id), sha256: item.sourceSha256 };
      } finally { active--; }
    },
    metadata: async () => { throw new Error('No unknown results in this controlled transport.'); },
    list: async () => ({ attachments: [] }), remove: async () => {},
  };
  const controller = createAttachmentDraftController(drafts, request, fileSha256, createAttachmentUploadScheduler(concurrency));
  const files = Array.from({ length: 16 }, (_, n) => new File([new Uint8Array(64 * 1024).fill(n)], `synthetic-${n}.bin`));
  const started = performance.now(); controller.add(threadId, files);
  while (!readyAttachments(controller.get(threadId))) await setTimeout(1);
  assert.equal(seen.size, 16); assert.equal(bytes, 16 * 64 * 1024); assert.equal(peak, concurrency);
  results.push({ concurrency, files: 16, bytes, elapsedMs: Number((performance.now() - started).toFixed(1)), peak });
}
console.log(JSON.stringify({ scenario: 'Controlled File streams with 25 ms fixed startup and 3 ms per chunk, no HTTP',
  hashConcurrency: MAX_ATTACHMENT_HASHES,
  boundary: 'Mechanism only. Shared bandwidth, weak networks, and physical phone speedups are unmeasured.', results }, null, 2));
