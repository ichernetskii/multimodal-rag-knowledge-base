import { loadRuntimeConfig } from './runtime-config.js';
import { checkApplication, createApplication, setupApplication } from './application.js';

const help = `Local RAG: Markdown/TXT → embeddings → SQLite → LLM answer.

  yarn setup                     Prepare the tokenizer and EmbeddingGemma
  yarn check [--storage-only]     Check components
  yarn ingest <file.md|file.txt>   Ingest or update a document
  yarn search "question"          Show retrieved chunks
  yarn ask "question"             Get an answer with source references

Documentation: README.md (English), README.ru.md (Russian).`;

const [command, ...args] = process.argv.slice(2);
let application: Awaited<ReturnType<typeof createApplication>> | undefined;
try {
  if (command === undefined || command === 'help' || command === '--help') {
    console.log(help);
  } else {
    const config = loadRuntimeConfig();
    switch (command) {
      case 'setup':
        console.error('Preparing tokenizer files and the embedding model...');
        console.log(await setupApplication(config));
        break;
      case 'check':
        if (args.some((arg) => arg !== '--storage-only'))
          throw new Error('Usage: yarn check [--storage-only]');
        console.log(await checkApplication(config, args.includes('--storage-only')));
        break;
      case 'ingest':
        if (args.length !== 1 || !args[0]) throw new Error('Usage: yarn ingest <file.md|file.txt>');
        application = await createApplication(config);
        console.log(await application.rag.ingest(args[0]));
        break;
      case 'search': {
        if (!args.join(' ').trim()) throw new Error('Usage: yarn search "question"');
        application = await createApplication(config, false);
        const hits = await application.rag.search(args.join(' '));
        if (!hits.length) console.log('No matching chunks found.');
        for (const [index, hit] of hits.entries())
          console.log(
            `\n[${index + 1}] ${hit.document.name} → ${hit.chunk.section} (score=${hit.score.toFixed(3)})\n${hit.chunk.body}`,
          );
        break;
      }
      case 'ask': {
        if (!args.join(' ').trim()) throw new Error('Usage: yarn ask "question"');
        application = await createApplication(config, false);
        const result = await application.rag.ask(args.join(' '));
        console.log(`\n${result.answer}\n`);
        for (const source of result.sources)
          console.log(`[${source.id}] ${source.name} → ${source.section}`);
        break;
      }
      default:
        throw new Error(`Unknown command: ${command}.\n${help}`);
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  if (/fetch failed|ECONNREFUSED|connect/iu.test(message))
    console.error('Check that Ollama is running and verify OLLAMA_URL.');
  process.exitCode = 1;
} finally {
  await application?.rag.close();
}
