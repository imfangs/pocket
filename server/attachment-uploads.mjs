import { createHash } from 'node:crypto';
import { AppError } from './store.mjs';
import { messageFingerprint } from './attachments.mjs';
import { validateAttachmentUploadManifest } from './attachment-upload-validation.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = value => createHash('sha256').update(value).digest('hex');
const active = "('uploading','failed','ready')";

// Upload intent is separate from a dispatch fingerprint. Until every original
// file is verified, this manifest cannot authorize a native message or lend an
// attachment snapshot to history/receipt reconciliation.
export class AttachmentUploadReservations {
  constructor(store, attachments, transaction, onChange) {
    Object.assign(this, { store, attachments, transaction, onChange });
    this.finalizing = new Map();
    attachments.reservations = this;
  }
  validate(descriptors) {
    return validateAttachmentUploadManifest(descriptors, this.attachments.maxBytes);
  }
  intent(text, descriptors, input) {
    return hash(JSON.stringify(['pocket-upload-intent-v1', text, descriptors, input.autoDirect === true, input.enqueue === true]));
  }
  row(requestId) {
    return this.store.db.prepare('SELECT * FROM attachment_upload_messages WHERE request_id=?').get(requestId);
  }
  claim(id) {
    return this.store.db.prepare(`SELECT c.*,m.status,m.descriptors FROM attachment_upload_claims c JOIN attachment_upload_messages m ON m.request_id=c.request_id WHERE c.attachment_id=? AND m.status IN ${active}`).get(id);
  }
  descriptor(claim, id) { return JSON.parse(claim.descriptors).find(value => value.id === id); }
  matches(data, descriptor) {
    return data.name === descriptor.name && data.sourceSize === descriptor.size &&
      (descriptor.sourceSha256 === undefined || data.sourceSha256 === descriptor.sourceSha256);
  }
  rowSlots() {
    const stored = this.store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n;
    const missing = this.store.db.prepare(`SELECT COUNT(*) AS n FROM attachment_upload_claims c JOIN attachment_upload_messages m ON m.request_id=c.request_id WHERE m.status IN ${active} AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.id=c.attachment_id)`).get().n;
    const unclaimed = [...this.attachments.newUploads].filter(id => !this.claim(id) && !this.store.db.prepare('SELECT 1 FROM attachments WHERE id=?').get(id)).length;
    return stored + missing + unclaimed;
  }
  reserve(threadId, requestId, text, descriptors, input) {
    const intent = this.intent(text, descriptors, input);
    const old = this.row(requestId);
    if (old) {
      if (old.thread_id !== threadId || old.intent_hash !== intent) throw new AppError('请求编号已用于另一条消息', 409);
      return false;
    }
    let additional = 0;
    for (const descriptor of descriptors) {
      const claimed = this.claim(descriptor.id);
      if (claimed && claimed.request_id !== requestId) throw new AppError('附件编号已用于另一请求', 409);
      const stored = this.store.db.prepare('SELECT thread_id,data FROM attachments WHERE id=?').get(descriptor.id);
      if (stored) {
        const data = JSON.parse(stored.data);
        if (stored.thread_id !== threadId || data.internalRequestId !== undefined || !this.matches(data, descriptor))
          throw new AppError('附件与提交的上传清单不符', 409);
      }
      const inFlight = this.attachments.uploadMetadata.get(descriptor.id);
      if (inFlight && (inFlight.threadId !== threadId || inFlight.name !== descriptor.name || inFlight.internalRequestId))
        throw new AppError('附件编号已用于另一文件或会话', 409);
      if (!stored && !claimed && !this.attachments.newUploads.has(descriptor.id)) additional++;
    }
    if (this.rowSlots() + additional > 2000) throw new AppError('附件空间已满，请先删除未发送的附件', 413);
    this.store.db.prepare("INSERT INTO attachment_upload_messages(request_id,thread_id,intent_hash,descriptors,status,code) VALUES(?,?,?,?,'uploading','attachments_uploading')")
      .run(requestId, threadId, intent, JSON.stringify(descriptors));
    for (const descriptor of descriptors) {
      this.store.db.prepare('INSERT INTO attachment_upload_claims VALUES(?,?,?)').run(descriptor.id, requestId, threadId);
      if (this.store.db.prepare('SELECT 1 FROM attachments WHERE id=? AND thread_id=?').get(descriptor.id, threadId))
        this.store.db.prepare('INSERT OR IGNORE INTO attachment_links VALUES(?,?)').run(descriptor.id, requestId);
    }
    return true;
  }
  validateUpload(threadId, id, name, requestId) {
    let claimed = this.claim(id);
    if (requestId !== undefined) {
      if (typeof requestId !== 'string' || !uuid.test(requestId)) throw new AppError('附件请求编号无效');
      const row = this.row(requestId);
      if (!row || row.thread_id !== threadId || row.status === 'cancelled' || !claimed || claimed.request_id !== requestId)
        throw new AppError('附件不属于此待发消息', 409);
    }
    if (claimed) {
      if (claimed.thread_id !== threadId || this.descriptor(claimed, id)?.name !== name)
        throw new AppError('附件与提交的上传清单不符', 409);
      if (claimed.status === 'failed') {
        this.store.db.prepare("UPDATE attachment_upload_messages SET status='uploading',code='attachments_uploading' WHERE request_id=? AND status='failed'").run(claimed.request_id);
        this.store.db.prepare("UPDATE dispatches SET code='attachments_uploading' WHERE id=? AND status IN('queued','editing')").run(claimed.request_id);
      }
    }
    return claimed;
  }
  validateCandidate(data) {
    const claimed = this.claim(data.id);
    if (claimed && (claimed.thread_id !== data.threadId || data.internalRequestId !== undefined || !this.matches(data, this.descriptor(claimed, data.id))))
      throw new AppError('附件与提交的上传清单不符', 409);
    return claimed;
  }
  failed(requestId, code = 'attachment_upload_failed') {
    this.store.db.prepare("UPDATE attachment_upload_messages SET status='failed',code=? WHERE request_id=? AND status IN('uploading','failed')").run(code, requestId);
    this.store.db.prepare("UPDATE dispatches SET code=? WHERE id=? AND status IN('queued','editing')").run(code, requestId);
  }
  uploaded(threadId, id, error) {
    const claimed = this.claim(id);
    if (!claimed || claimed.thread_id !== threadId) return;
    if (error && claimed.status !== 'ready') this.failed(claimed.request_id);
    this.onChange?.(threadId, claimed.request_id);
  }
  cancel(requestId) {
    this.store.db.prepare("UPDATE attachment_upload_messages SET status='cancelled',code='attachment_upload_cancelled' WHERE request_id=?").run(requestId);
    this.store.db.prepare('DELETE FROM attachment_upload_claims WHERE request_id=?').run(requestId);
  }
  blocked(requestId) {
    const row = this.row(requestId);
    return !!row && row.status !== 'ready';
  }
  progress(threadId, requestId) {
    const row = this.row(requestId);
    if (!row || row.thread_id !== threadId) return null;
    const descriptors = JSON.parse(row.descriptors);
    let uploaded = 0;
    const attachmentUploads = descriptors.map(descriptor => {
      const stored = this.store.db.prepare('SELECT data FROM attachments WHERE id=? AND thread_id=?').get(descriptor.id, threadId);
      const data = stored && JSON.parse(stored.data);
      const complete = !!data && this.matches(data, descriptor) && !this.attachments.uploads.has(descriptor.id);
      if (complete) uploaded++;
      return { ...descriptor, status: complete ? 'uploaded' : this.attachments.uploads.has(descriptor.id) ? 'uploading' : row.status === 'failed' ? 'failed' : 'missing',
        ...(complete ? { attachment: this.attachments.public(data) } : {}) };
    });
    return { attachmentUploads, uploadProgress: { total: descriptors.length, uploaded,
      status: row.status === 'ready' ? 'ready' : ['failed', 'cancelled'].includes(row.status) ? 'failed' : 'uploading',
      ...(row.code ? { code: row.code } : {}) } };
  }
  finalize(threadId, requestId) {
    const current = this.finalizing.get(requestId);
    if (current) return current;
    const pending = this.finalizeStep(threadId, requestId).finally(() => {
      if (this.finalizing.get(requestId) === pending) this.finalizing.delete(requestId);
    });
    this.finalizing.set(requestId, pending);
    return pending;
  }
  async finalizeStep(threadId, requestId) {
    const row = this.row(requestId);
    if (!row) return true;
    if (row.thread_id !== threadId || row.status === 'cancelled') return false;
    if (row.status === 'ready') return true;
    const queued = this.store.db.prepare("SELECT o.text,o.revision,d.status FROM outgoing_messages o JOIN dispatches d ON d.id=o.id WHERE o.id=? AND o.thread_id=? AND d.status IN('queued','editing')").get(requestId, threadId);
    if (!queued) return false;
    const descriptors = JSON.parse(row.descriptors), files = [];
    try {
      for (const descriptor of descriptors) {
        if (this.attachments.uploads.has(descriptor.id)) return false;
        let data;
        try { data = this.attachments.row(threadId, descriptor.id); }
        catch (error) { if (error.status === 404) return false; throw error; }
        if (data.internalRequestId !== undefined || !this.matches(data, descriptor)) throw new AppError('附件上传内容不符', 409);
        files.push(data);
      }
      await this.attachments.prepare(files);
      for (const data of files) {
        const bytes = await this.attachments.readFile(data.sourcePath);
        if (bytes.length !== data.sourceSize || hash(bytes) !== data.sourceSha256) throw new AppError('附件原件已变化', 409);
      }
      return this.transaction(() => {
        const fresh = this.row(requestId);
        const current = this.store.db.prepare("SELECT o.text,o.revision FROM outgoing_messages o JOIN dispatches d ON d.id=o.id WHERE o.id=? AND o.thread_id=? AND d.status IN('queued','editing')").get(requestId, threadId);
        if (!fresh || !['uploading', 'failed'].includes(fresh.status) || !current || current.revision !== queued.revision || current.text !== queued.text) return false;
        if (descriptors.some(descriptor => this.attachments.uploads.has(descriptor.id) || this.claim(descriptor.id)?.request_id !== requestId)) return false;
        const latest = descriptors.map(descriptor => this.attachments.row(threadId, descriptor.id));
        if (JSON.stringify(latest) !== JSON.stringify(files)) return false;
        this.attachments.bind(threadId, requestId, current.text, files);
        this.store.db.prepare("UPDATE dispatches SET text_hash=?,code=NULL WHERE id=? AND thread_id=? AND status IN('queued','editing')")
          .run(messageFingerprint(current.text, files), requestId, threadId);
        this.store.db.prepare("UPDATE attachment_upload_messages SET status='ready',code=NULL WHERE request_id=? AND status IN('uploading','failed')").run(requestId);
        return true;
      });
    } catch (error) {
      this.failed(requestId, error.status === 409 ? 'attachment_upload_mismatch' : 'attachment_upload_unavailable');
      return false;
    }
  }
}
