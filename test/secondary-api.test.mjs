import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { __testing } from '../server/index.mjs';

test('server normalizes independent secondary settings without accepting non-http URLs', () => {
  assert.deepEqual(__testing.sanitizeSecondaryConfig({
    apiUrl: 'https://secondary.example/v1/',
    secretId: 'secret-id',
    model: 'model-id',
  }), {
    apiUrl: 'https://secondary.example/v1',
    secretId: 'secret-id',
    model: 'model-id',
  });

  assert.throws(
    () => __testing.sanitizeSecondaryConfig({
      apiUrl: 'file:///tmp/key',
      secretId: 'secret-id',
      model: 'model-id',
    }),
    (error) => error.code === 'secondary_api_url_invalid',
  );
});

test('server builds OpenAI-compatible chat and model endpoints', () => {
  assert.equal(
    __testing.getChatCompletionsUrl('https://secondary.example/v1'),
    'https://secondary.example/v1/chat/completions',
  );
  assert.equal(
    __testing.getChatCompletionsUrl('https://secondary.example/v1/chat/completions'),
    'https://secondary.example/v1/chat/completions',
  );
  assert.equal(
    __testing.getModelsUrl('https://secondary.example/v1/chat/completions'),
    'https://secondary.example/v1/models',
  );
});

test('server model parser supports common compatible response shapes', () => {
  assert.deepEqual(__testing.extractModelIds({ data: [{ id: 'b' }, { id: 'a' }] }), ['a', 'b']);
  assert.deepEqual(__testing.extractModelIds({ models: [{ name: 'c' }, 'd'] }), ['c', 'd']);
  assert.deepEqual(__testing.extractModelIds([{ model: 'e' }, { id: 'f' }]), ['e', 'f']);
});

test('server reads the exact requested Custom key instead of the globally active key', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-musings-secondary-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'secrets.json'), JSON.stringify({
    api_key_custom: [
      { id: 'main-key', value: 'main-value', active: true },
      { id: 'secondary-key', value: 'secondary-value', active: false },
    ],
  }));

  assert.equal(__testing.readActiveCustomSecret({ root }, 'secondary-key'), 'secondary-value');
  assert.equal(__testing.readActiveCustomSecret({ root }, 'main-key'), 'main-value');
  assert.equal(__testing.readActiveCustomSecret({ root }, 'missing-key'), '');
});

