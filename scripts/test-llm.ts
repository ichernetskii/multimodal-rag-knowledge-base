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
  const cases = [
    {
      language: 'English',
      question: 'How far in advance must employees on probation request leave?',
      unknown: 'How much is the bonus for good performance?',
      insufficient:
        /not enough|insufficient|not specified|not provided|no information|do not contain|does not contain/iu,
    },
    {
      language: 'Russian',
      question:
        'За сколько календарных дней сотрудник на испытательном сроке должен запросить отпуск?',
      unknown: 'Какой размер премии за хорошую работу?',
      insufficient: /недостаточно|не содержат|нет информаци|не хватает/iu,
    },
  ];
  const results: { language: string; empty: string; answer: string; unknown: string }[] = [];
  const assertLanguage = (answer: string, language: string) => {
    if (language === 'Russian') assert.match(answer, /\p{Script=Cyrillic}/u);
    else assert.doesNotMatch(answer, /\p{Script=Cyrillic}/u);
  };
  for (const item of cases) {
    const empty = await application.rag.ask(item.question);
    assert.deepEqual(empty.hits, []);
    assert.deepEqual(empty.sources, []);
    assert.equal(empty.answer, 'The documents do not contain enough information.');
    results.push({ language: item.language, empty: empty.answer, answer: '', unknown: '' });
  }
  await application.rag.ingest(fileURLToPath(new URL('../examples/company.md', import.meta.url)));
  for (const [index, item] of cases.entries()) {
    const answer = await application.rag.ask(item.question);
    assert.match(answer.answer, /21/u);
    assert.match(answer.answer, /\[\d+\]/u);
    assert.ok(answer.sources.length > 0);
    assertLanguage(answer.answer, item.language);
    const unknown = await application.rag.ask(item.unknown);
    assert.ok(unknown.hits.length > 0);
    assert.match(unknown.answer, item.insufficient);
    assert.doesNotMatch(unknown.answer, /\[\d+\]/u);
    assertLanguage(unknown.answer, item.language);
    const result = results[index];
    assert.ok(result);
    result.answer = answer.answer;
    result.unknown = unknown.answer;
  }
  console.log(JSON.stringify({ status: 'passed', llm: config.llm.model, results }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await application?.rag.close();
  await rm(directory, { recursive: true, force: true });
}
