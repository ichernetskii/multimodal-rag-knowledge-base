import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig } from '../src/runtime-config.js';
import { createApplication } from '../src/application.js';
import { requireModel } from '../src/ollama/client.js';

const directory = await mkdtemp(join(tmpdir(), 'rag-llm-'));
const config = loadRuntimeConfig();
config.storage.path = join(directory, 'index.sqlite');
let application: Awaited<ReturnType<typeof createApplication>> | undefined;
try {
  application = await createApplication(config);
  await requireModel(application.client, config.llm.model);
  await application.rag.ingest(fileURLToPath(new URL('../examples/company.md', import.meta.url)));
  const answer = await application.rag.ask(
    'How far in advance must employees on probation request leave?',
  );
  assert.match(answer.answer, /21/u);
  assert.match(answer.answer, /\[\d+\]/u);
  assert.ok(answer.sources.length > 0);
  const unknown = await application.rag.ask('How much is the bonus for good performance?');
  assert.match(
    unknown.answer,
    /not enough|insufficient|not specified|not provided|no information|do not contain|does not contain/iu,
  );
  console.log(
    JSON.stringify(
      { status: 'passed', llm: config.llm.model, answer: answer.answer, unknown: unknown.answer },
      null,
      2,
    ),
  );
} finally {
  await application?.rag.close();
  await rm(directory, { recursive: true, force: true });
}
