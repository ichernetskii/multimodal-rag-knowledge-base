import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRuntimeConfig } from '../src/runtime-config.js';
import { createApplication } from '../src/application.js';

const directory = await mkdtemp(join(tmpdir(), 'rag-embeddinggemma-'));
const config = loadRuntimeConfig();
config.storage.path = join(directory, 'index.sqlite');
let application: Awaited<ReturnType<typeof createApplication>> | undefined;
try {
  application = await createApplication(config);
  const { rag, tokenizer, formatter, stages, client } = application;
  const samples = [
    formatter.query('How far in advance must employees request leave?'),
    formatter.document('company.md', 'Leave', 'The manager approves the request.'),
    formatter.query('English, accents café, emoji 👩🏽‍💻 and number 12345.'),
  ];
  const tokenCounts = [];
  for (const input of samples) {
    const response = await stages.embedder.embed([input]);
    const local = tokenizer.count(input);
    tokenCounts.push({ local, ollama: response.inputTokens });
    assert.equal(local, response.inputTokens, 'The application tokenizer must match Ollama');
    assert.equal(response.vectors[0]?.length, config.embedding.dimensions);
    assert.ok(Math.abs(Math.hypot(...(response.vectors[0] ?? [])) - 1) < 0.001);
  }
  await assert.rejects(stages.embedder.embed([formatter.query('word '.repeat(3000))]), /Shorten/u);
  await assert.rejects(
    client.embed({
      model: config.embedding.model,
      input: 'word '.repeat(3000),
      truncate: false,
      options: { num_ctx: config.embedding.maxTokens },
    }),
    /context|length|large|limit/iu,
  );
  const file = join(directory, 'company.md');
  await writeFile(file, await readFile(new URL('../examples/company.md', import.meta.url), 'utf8'));
  const first = await rag.ingest(file);
  const second = await rag.ingest(file);
  assert.equal(first.generation, second.generation);
  assert.equal((await stages.store.stats()).chunks, first.chunks);
  const queries = [
    ['How far in advance must employees on probation request leave?', '21 calendar days'],
    ['Who approves leave?', 'direct manager'],
    ['When must an expense report be submitted after a business trip?', '3 working days'],
  ];
  const ranks = [];
  for (const [question, expected] of queries) {
    assert.ok(question && expected);
    const hits = await rag.search(question);
    const rank = hits.findIndex((hit) => hit.chunk.body.includes(expected)) + 1;
    assert.ok(rank > 0, `Answer not found: ${question}`);
    ranks.push({ question, answerRank: rank });
  }
  const other = join(directory, 'it.txt');
  await writeFile(other, 'The IT department provides work laptops to employees.');
  const textDocument = await rag.ingest(other);
  assert.ok(
    (await rag.search('Who provides work laptops?')).some((hit) => hit.document.name === 'it.txt'),
  );
  await writeFile(
    file,
    '# Policy\n\n## Leave\n\nLeave must be requested 30 calendar days in advance.',
  );
  const updated = await rag.ingest(file);
  const stats = await stages.store.stats();
  assert.equal(stats.documents, 2);
  assert.equal(stats.chunks, updated.chunks + textDocument.chunks);
  assert.equal(stats.chunks, stats.vectors);
  const updatedHits = await rag.search('How far in advance must employees request leave?');
  assert.ok(updatedHits.every((hit) => !hit.chunk.body.includes('21 calendar days')));
  assert.ok(updatedHits.some((hit) => hit.chunk.body.includes('30 calendar days')));
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        model: application.model,
        initialChunks: first.chunks,
        tokenCounts,
        queries: ranks,
        txt: 'passed',
        replacement: 'passed',
        duplicates: 'none',
      },
      null,
      2,
    ),
  );
} finally {
  await application?.rag.close();
  await rm(directory, { recursive: true, force: true });
}
