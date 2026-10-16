import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ApiClient, credentials } from '../server/src/interfaces/cli/api-client.ts';
import type { Job } from '../server/src/contracts/public.ts';

const args = process.argv.slice(2);
if (args.some((arg) => !['--publish', '--help'].includes(arg)))
  throw new Error('Usage: yarn demo:import [--publish]');
if (args.includes('--help')) {
  console.log(
    'Import the checked-in multimodal corpus into a new knowledge base in the signed-in CLI company. Default: review only. --publish explicitly acknowledges and indexes demo material; real profiles may incur charges.',
  );
} else {
  const directory = new URL('../examples/knowledge-base/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8')) as {
    materials: { path: string; sha256: string }[];
  };
  // Verify every local input before creating anything remotely.
  for (const material of manifest.materials) {
    const data = await readFile(new URL(material.path, directory));
    if (createHash('sha256').update(data).digest('hex') !== material.sha256)
      throw new Error('Demo material checksum mismatch: ' + material.path);
  }
  const api = new ApiClient(await credentials());
  const collection = await api.action('collections.save', {
    name: 'Учебная база · ' + new Date().toISOString(),
    grants: [],
  });
  console.log('Company: ' + api.config.tenant + '; knowledge base: ' + collection.id);
  const wait = async (job: Job) => {
    const result = await api.wait(job.id);
    if (result.status !== 'complete')
      throw new Error(`${job.id}: ${result.status}: ${result.error} (${result.diagnostic})`);
  };
  let failed = 0;
  for (const material of manifest.materials) {
    try {
      const uploaded = await api.upload(fileURLToPath(new URL(material.path, directory)), {
        collection: collection.id,
      });
      if (uploaded.job) await wait(uploaded.job);
      const detail = await api.action('documents.read', { id: uploaded.document.id });
      if (args.includes('--publish'))
        await wait(
          await api.action('documents.publish', {
            id: detail.document.id,
            revision: detail.document.revision,
            version: detail.version.id,
            acknowledge: true,
            activate: true,
          }),
        );
      console.log(
        `${material.path}: ${args.includes('--publish') ? 'published' : detail.version.state} · ${detail.document.id}`,
      );
    } catch (error) {
      failed++;
      console.error(
        material.path + ': ' + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  if (failed) {
    process.exitCode = 1;
    console.error(
      `${failed} material(s) failed. Inspect saved documents/jobs in knowledge base ${collection.id}; successful uploads remain available.`,
    );
  }
}
