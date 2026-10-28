import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink, rename, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { zstdCompressSync } from 'node:zlib';
import { resolveHistorySource, iterateHistoryChunks, iterateHistoryLines, readHistoryRange,
  readHistoryRanges } from '../server/history-source.mjs';

const threadId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const meta = JSON.stringify({ type: 'session_meta', payload: { id: threadId } });
const content = `${meta}\n${JSON.stringify({ text: '中文🙂\r\nraw' })}\n${JSON.stringify({ text: 'last' })}`;
const status = code => cause => cause?.code === code;
async function fixture(t, text = content, compressed = false) {
  const codexHome = await mkdtemp(join(tmpdir(), 'pocket-history-source-'));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  await mkdir(join(codexHome, 'sessions'));
  await mkdir(join(codexHome, 'archived_sessions'));
  const filePath = join(codexHome, 'sessions', 'fixture.jsonl');
  await writeFile(filePath + (compressed ? '.zst' : ''), compressed ? zstdCompressSync(Buffer.from(text)) : text);
  return { codexHome, filePath, threadId };
}
async function bytes(source, options) {
  const values = [];
  for await (const value of iterateHistoryChunks(source, options)) values.push(value);
  return Buffer.concat(values);
}
async function lines(source, options) {
  const values = [];
  for await (const value of iterateHistoryLines(source, options)) values.push(value);
  return values;
}

for (const compressed of [false, true]) {
  test(`${compressed ? 'zstd' : 'ordinary'} source preserves UTF-8 byte offsets and all bytes`, async t => {
    const input = await fixture(t, content, compressed);
    const source = await resolveHistorySource(input);
    assert.equal(source.compression, compressed ? 'zstd' : 'none');
    assert.deepEqual(await bytes(source), Buffer.from(content));
    const records = await lines(source);
    assert.deepEqual(records.map(record => record.startOffset), [0, Buffer.byteLength(meta) + 1,
      Buffer.byteLength(content.slice(0, content.lastIndexOf('\n'))) + 1]);
    assert.equal(records.at(-1).endOffset, Buffer.byteLength(content));
    const first = records[1], last = records[2];
    assert.deepEqual(await readHistoryRanges(source, [last, first]), [
      Buffer.from(content).subarray(last.startOffset, last.endOffset),
      Buffer.from(content).subarray(first.startOffset, first.endOffset),
    ]);
    assert.deepEqual(await readHistoryRange(source, first), Buffer.from(content).subarray(first.startOffset, first.endOffset));
    assert.deepEqual(await bytes(source, { endOffset: first.endOffset }), Buffer.from(content).subarray(0, first.endOffset));
  });
  test(`${compressed ? 'zstd' : 'ordinary'} rejects source mutation during iteration`, async t => {
    const input = await fixture(t, `${meta}\n${'x'.repeat(150000)}`, compressed);
    const source = await resolveHistorySource(input);
    await assert.rejects(async () => {
      for await (const _ of iterateHistoryChunks(source)) {
        await appendFile(source.file, 'changed');
        break;
      }
    }, status('HISTORY_SOURCE_CHANGED'));
    await assert.rejects(() => bytes(source), status('HISTORY_SOURCE_CHANGED'));
  });
  test(`${compressed ? 'zstd' : 'ordinary'} rejects wrong session and bounded header`, async t => {
    const input = await fixture(t, content, compressed);
    await assert.rejects(() => resolveHistorySource({ ...input, threadId: 'another' }), status('HISTORY_SOURCE_SESSION'));
    await assert.rejects(() => resolveHistorySource(input, { maxHeaderBytes: 8 }), status('HISTORY_SOURCE_LIMIT'));
  });
  test(`${compressed ? 'zstd' : 'ordinary'} enforces line, selected byte and abort limits`, async t => {
    const input = await fixture(t, `${meta}\n${'x'.repeat(10000)}\n`, compressed);
    const source = await resolveHistorySource(input);
    await assert.rejects(() => lines(source, { maxLineBytes: 100 }), status('HISTORY_SOURCE_LIMIT'));
    await assert.rejects(() => readHistoryRange(source, { startOffset: 0, endOffset: 20, maxRangeBytes: 10 }), status('HISTORY_SOURCE_LIMIT'));
    await assert.rejects(() => readHistoryRanges(source, [{ endOffset: 1 }, { endOffset: 1 }], { maxRanges: 1 }), status('HISTORY_SOURCE_LIMIT'));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => bytes(source, { signal: controller.signal }), status('HISTORY_SOURCE_ABORTED'));
  });
  test(`${compressed ? 'zstd' : 'ordinary'} times out paused consumers and closes cleanly`, async t => {
    const input = await fixture(t, `${meta}\n${'a'.repeat(140000)}`, compressed);
    const source = await resolveHistorySource(input);
    await assert.rejects(async () => {
      for await (const _ of iterateHistoryChunks(source, { timeoutMs: 5 })) await delay(15);
    }, status('HISTORY_SOURCE_TIMEOUT'));
    assert.equal((await bytes(source)).length, Buffer.byteLength(`${meta}\n${'a'.repeat(140000)}`));
  });
}

test('ordinary path takes priority and fallback is limited to its exact .zst sibling', async t => {
  const input = await fixture(t);
  await writeFile(input.filePath + '.zst', zstdCompressSync(Buffer.from(`${meta}\nwrong copy`)));
  assert.equal((await resolveHistorySource(input)).compression, 'none');
  await rm(input.filePath);
  assert.equal((await resolveHistorySource(input)).compression, 'zstd');
  await rename(input.filePath + '.zst', join(input.codexHome, 'sessions', 'unrelated.jsonl.zst'));
  await assert.rejects(() => resolveHistorySource(input), status('ENOENT'));
});

test('source rejects directories, outside-root paths and escaping symlinks', async t => {
  const input = await fixture(t);
  const outside = join(input.codexHome, 'outside.jsonl');
  await writeFile(outside, content);
  await assert.rejects(() => resolveHistorySource({ ...input, filePath: outside }), status('HISTORY_SOURCE_LOCATION'));
  const link = join(input.codexHome, 'sessions', 'link.jsonl');
  await symlink(outside, link);
  await assert.rejects(() => resolveHistorySource({ ...input, filePath: link }), status('HISTORY_SOURCE_LOCATION'));
  await mkdir(join(input.codexHome, 'sessions', 'directory.jsonl'));
  await assert.rejects(() => resolveHistorySource({ ...input, filePath: join(input.codexHome, 'sessions', 'directory.jsonl') }), status('HISTORY_SOURCE_TYPE'));
});

test('archived and relative paths are supported, while traversal still checks the real target', async t => {
  const input = await fixture(t);
  await writeFile(join(input.codexHome, 'archived_sessions', 'old.jsonl.zst'), zstdCompressSync(Buffer.from(content)));
  const source = await resolveHistorySource({ ...input, filePath: 'archived_sessions/old.jsonl' });
  assert.equal(source.compression, 'zstd');
  assert.deepEqual(await bytes(source), Buffer.from(content));
  await writeFile(join(input.codexHome, 'outside.jsonl'), content);
  await assert.rejects(() => resolveHistorySource({ ...input, filePath: 'sessions/../outside.jsonl' }), status('HISTORY_SOURCE_LOCATION'));
});

test('identity survives append but version changes; replacement and fallback switch invalidate reads', async t => {
  const input = await fixture(t);
  const first = await resolveHistorySource(input);
  await appendFile(input.filePath, '\nnew');
  const appended = await resolveHistorySource(input);
  assert.equal(appended.identity, first.identity);
  assert.notEqual(appended.version, first.version);
  await assert.rejects(() => bytes(first), status('HISTORY_SOURCE_CHANGED'));
  await rename(input.filePath, input.filePath + '.old');
  await writeFile(input.filePath, content);
  const replacement = await resolveHistorySource(input);
  assert.notEqual(replacement.identity, first.identity);
  await assert.rejects(() => bytes(appended), status('HISTORY_SOURCE_CHANGED'));
  await rm(input.filePath);
  await writeFile(input.filePath + '.zst', zstdCompressSync(Buffer.from(content)));
  const compressed = await resolveHistorySource(input);
  await writeFile(input.filePath, content);
  await assert.rejects(() => bytes(compressed), status('HISTORY_SOURCE_CHANGED'));
});

test('zstd rejects decode bombs, compressed byte limits and damaged frames', async t => {
  const input = await fixture(t, `${meta}\n${'x'.repeat(300000)}`, true);
  const source = await resolveHistorySource(input);
  await assert.rejects(() => bytes(source, { maxDecodedBytes: 10000 }), status('HISTORY_SOURCE_LIMIT'));
  await assert.rejects(() => bytes(source, { maxExpansionRatio: 2, ratioSlackBytes: 0 }), status('HISTORY_SOURCE_LIMIT'));
  await assert.rejects(() => bytes(source, { maxCompressedBytes: 1 }), status('HISTORY_SOURCE_LIMIT'));
  await writeFile(input.filePath + '.zst', Buffer.from('not a zstd frame'));
  await assert.rejects(() => resolveHistorySource(input), status('HISTORY_SOURCE_DECODE'));
});

test('zstd never accepts a truncated frame as a complete history', async t => {
  const input = await fixture(t, `${meta}\n${'x'.repeat(300000)}`, true);
  const file = input.filePath + '.zst';
  const frame = await readFile(file);
  await writeFile(file, frame.subarray(0, frame.length - 1));
  await assert.rejects(async () => bytes(await resolveHistorySource(input)), status('HISTORY_SOURCE_DECODE'));
});

test('fallback symlinks may not escape the permitted roots', async t => {
  const input = await fixture(t);
  const outside = join(input.codexHome, 'outside.jsonl.zst');
  await writeFile(outside, zstdCompressSync(Buffer.from(content)));
  await rm(input.filePath);
  await symlink(outside, input.filePath + '.zst');
  await assert.rejects(() => resolveHistorySource(input), status('HISTORY_SOURCE_LOCATION'));
});

test('session identity is always validated at byte zero even when read offsets are supplied', async t => {
  const wrongMeta = JSON.stringify({ type: 'session_meta', payload: { id: 'another' } });
  const input = await fixture(t, `${wrongMeta}\n${content}`, true);
  await assert.rejects(() => resolveHistorySource(input, { startOffset: Buffer.byteLength(wrongMeta) + 1 }),
    status('HISTORY_SOURCE_SESSION'));
  const valid = await fixture(t, content, true);
  assert.equal((await resolveHistorySource(valid, { startOffset: 10, endOffset: 11 })).threadId, threadId);
});

test('renaming the pathname while its file is open invalidates the snapshot', async t => {
  const input = await fixture(t, `${meta}\n${'x'.repeat(100000)}`);
  const source = await resolveHistorySource(input);
  await assert.rejects(async () => {
    for await (const _ of iterateHistoryChunks(source)) {
      await rename(input.filePath, input.filePath + '.previous');
      await writeFile(input.filePath, content);
      break;
    }
  }, status('HISTORY_SOURCE_CHANGED'));
});

test('large Unicode lines cross decompression chunks without offset drift', async t => {
  const text = `${meta}\n${'中🙂'.repeat(50000)}\nlast\n`;
  const input = await fixture(t, text, true);
  const source = await resolveHistorySource(input);
  const records = await lines(source);
  assert.equal(records[1].text, '中🙂'.repeat(50000));
  assert.equal(records[2].startOffset, Buffer.byteLength(meta) + 1 + 350000 + 1);
  assert.equal(records[2].endOffset, Buffer.byteLength(text));
});
