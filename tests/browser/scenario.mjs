import assert from 'node:assert/strict';

export async function runScenario({ engine, name, create, run, record }) {
  const result = { engine, name, passed: false };
  let harness, failure;
  try {
    harness = await create(); result.build = harness.build;
    await run(harness);
    assert.deepEqual(harness.errors, [], 'No uncaught browser exceptions');
    assert.deepEqual(harness.unexpected, [], 'Only allowlisted synthetic requests are permitted');
  } catch (error) { failure = error; }
  finally {
    try { await harness?.close(); }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'Scenario and cleanup failed') : error; }
    result.requests = harness?.calls.length ?? 0;
    result.passed = !failure;
    if (failure) result.error = failure.stack || String(failure);
    record(result);
  }
  if (failure) throw failure;
}
