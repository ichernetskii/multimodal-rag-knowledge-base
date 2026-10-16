import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bill, googleUsage, reservation } from '../src/features/models/billing.js';
import { initialProfiles } from '../src/config/default-settings.js';
import { loadDeployment } from '../src/config/saas-config.js';
const profile = initialProfiles(
  loadDeployment({ NODE_ENV: 'test', APP_ENCRYPTION_KEY: '1'.repeat(64) }),
)[1]!;
const parts = [{ kind: 'text' as const, text: 'Elephant' }, { kind: 'image' as const }];
void test('transcription reserves text output as well as audio input before a paid call', () => {
  const transcription = {
    ...profile,
    role: 'transcription' as const,
    maxOutputTokens: 2048,
    outputMicrosPerMillion: 3750000,
  };
  const amount = reservation(transcription, [
    { kind: 'audio', seconds: 11 },
    { kind: 'text', text: 'Transcribe' },
  ]);
  assert.equal(amount.output.tokens, 2048);
  assert.equal(
    amount.costMicros,
    Math.ceil(
      (transcription.contextTokens * transcription.inputMicrosPerMillion.audio + 2048 * 3750000) /
        1e6,
    ),
  );
});
void test('mixed embedding bills each modality at its own rate and reconciles rounding', () => {
  const usage = googleUsage(
    {
      promptTokenCount: 1200,
      promptTokenDetails: [
        { modality: 'TEXT', tokenCount: 100 },
        { modality: 'IMAGE', tokenCount: 200 },
        { modality: 'AUDIO', tokenCount: 300 },
        { modality: 'VIDEO', tokenCount: 600 },
      ],
    },
    8192,
  );
  const result = bill(profile, parts, usage);
  assert.equal(result.costMicros, 9260);
  assert.deepEqual(
    Object.values(result.input).map((v) => v.costMicros),
    [20, 90, 1950, 7200],
  );
  assert.equal(result.estimated, false);
  const tiny = bill(profile, [{ kind: 'text' }], { input: 1, output: 0, cached: 0 });
  assert.equal(tiny.costMicros, 1);
  assert.equal(tiny.input.text.costMicros, 1);
});
void test('reservation uses the highest possible rate, including PDF images and video audio', () => {
  assert.equal(reservation(profile, parts).costMicros, Math.ceil(8192 * 0.45));
  assert.equal(reservation(profile, [{ kind: 'pdf' }]).costMicros, Math.ceil(8192 * 0.45));
  assert.equal(reservation(profile, [{ kind: 'video' }]).costMicros, 98304);
});
void test('absent or partial provider breakdown is explicitly conservative, never charged as text', () => {
  const missing = bill(profile, parts, googleUsage(undefined, 8192));
  assert.equal(missing.costMicros, 3687);
  assert.equal(missing.unattributed.tokens, 8192);
  assert.equal(missing.estimated, true);
  const partial = bill(
    profile,
    parts,
    googleUsage(
      { promptTokenCount: 110, promptTokenDetails: [{ modality: 'TEXT', tokenCount: 10 }] },
      8192,
    ),
  );
  assert.equal(partial.input.text.tokens, 10);
  assert.equal(partial.unattributed.tokens, 100);
  assert.equal(partial.costMicros, 47);
  const text = bill(profile, [{ kind: 'text' }], googleUsage({ promptTokenCount: 20 }, 8192));
  assert.equal(text.input.text.tokens, 20);
  assert.equal(text.estimated, false);
});
void test('unknown modalities and inconsistent counts cannot silently underbill', () => {
  const unknown = bill(
    profile,
    [{ kind: 'pdf' }],
    googleUsage(
      { promptTokenCount: 100, promptTokenDetails: [{ modality: 'DOCUMENT', tokenCount: 100 }] },
      8192,
    ),
  );
  assert.equal(unknown.unattributed.tokens, 100);
  assert.equal(unknown.costMicros, 45);
  assert.throws(() =>
    bill(profile, parts, { input: 1, output: 0, cached: 0, inputByModality: { image: 2 } }),
  );
  assert.throws(() => bill(profile, parts, { input: -1, output: 0, cached: 0 }));
});
