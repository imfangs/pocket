// A read belongs to this HTTP consumer. Disconnecting it never cancels a
// mutation; shared file readers decide whether other consumers still need work.
export async function withReadRequest(req, res, read) {
  const controller = new AbortController();
  const cancel = () => { if (!res.writableFinished) controller.abort(); };
  req.once('aborted', cancel); res.once('close', cancel);
  try {
    if (req.aborted || res.destroyed) cancel();
    if (controller.signal.aborted) return;
    const result = await read(controller.signal);
    if (!controller.signal.aborted && !res.destroyed) return result;
  } catch (error) {
    if (!controller.signal.aborted && !res.destroyed) throw error;
  } finally { req.off('aborted', cancel); res.off('close', cancel); }
}
