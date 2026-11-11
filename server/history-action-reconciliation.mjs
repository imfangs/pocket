const reconcilable = new Set(['accepted', 'unknown']);

// Negative evidence belongs to a particular native read. A missing request or
// changed compaction baseline cannot settle an operation that did not exist
// when that read started. A pending RPC also keeps its own result: neither
// observation identifies that exact write, so wait for accepted/unknown before
// checking its postcondition. Positive message receipts remain independent.
export class HistoryActionReconciler {
  constructor(store) { this.store = store; }

  capture(threadId) {
    const compaction = this.latestCompaction(threadId);
    return {
      threadId,
      compaction: reconcilable.has(compaction?.status) ? compaction : null,
      responses: this.store.db.prepare("SELECT id,request_key FROM request_responses WHERE thread_id=? AND status IN('accepted','unknown')").all(threadId),
    };
  }

  latestCompaction(threadId) {
    return this.store.db.prepare('SELECT id,baseline_id,status FROM compactions WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(threadId);
  }

  reconcile(observation, history) {
    if (history.source !== 'desktop') return;
    const { threadId, compaction, responses } = observation;
    const compact = history.compaction;
    if (compaction && compact?.latestId && compact.latestId !== compaction.baseline_id && compact.completed &&
        this.latestCompaction(threadId)?.id === compaction.id) {
      this.store.db.prepare("UPDATE compactions SET status=?,code=NULL WHERE id=? AND thread_id=? AND status IN('accepted','unknown')")
        .run(['failed', 'interrupted'].includes(compact.turnStatus) ? 'failed' : 'completed', compaction.id, threadId);
    }
    if (Array.isArray(history.pendingRequests)) {
      const keys = new Set(history.pendingRequests.map(request => request.key));
      for (const response of responses) if (!keys.has(response.request_key))
        this.store.db.prepare("UPDATE request_responses SET status='resolved',code=NULL WHERE id=? AND thread_id=? AND request_key=? AND status IN('accepted','unknown')")
          .run(response.id, threadId, response.request_key);
    }
  }
}
