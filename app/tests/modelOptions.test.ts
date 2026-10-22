import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeModel, isCurrentModel, modelName, modelProviders, shortModel } from '../src/lib/modelOptions.ts';
import type { Picker } from '../src/lib/types.ts';

const picker: Picker = {
  id: 'pick', kind: 'model', status: 'open', expires_at: 100,
  current_provider: 'router', current_model: 'z-ai/glm-5.3-flash',
  providers: [
    { slug: 'other', name: 'Other provider', models: ['claude-opus-4-6', 'gpt-5.4-mini'] },
    { slug: 'router', name: 'OpenRouter', models: ['anthropic/claude-sonnet-4-6', 'z-ai/glm-5.3-flash'] },
  ],
};

test('model labels remain readable while retaining versions and context qualifiers', () => {
  assert.equal(modelName('anthropic/claude-sonnet-4-6'), 'Claude Sonnet 4.6');
  assert.equal(modelName('us.anthropic.claude-3-5-sonnet-20241022'), 'Claude 3.5 Sonnet');
  assert.equal(modelName('z-ai/glm-5.3-flash'), 'GLM 5.3 Flash');
  assert.equal(modelName('openai/gpt-5.4-mini'), 'GPT 5.4 Mini');
  assert.equal(shortModel('vendor/custom-id:1m'), 'custom-id:1m');
  assert.equal(modelName(''), '');
});

test('current model is visible first without mutating the offered model order', () => {
  const before = JSON.stringify(picker);
  const providers = modelProviders(picker);
  assert.equal(providers[0].slug, 'router');
  assert.equal(providers[0].models[0], 'z-ai/glm-5.3-flash');
  assert.equal(JSON.stringify(picker), before);
});

test('search supports friendly names, provider names, exact ids and multiple words', () => {
  assert.deepEqual(modelProviders(picker, 'sonnet 4.6')[0].models, ['anthropic/claude-sonnet-4-6']);
  assert.equal(modelProviders(picker, 'openrouter')[0].models.length, 2);
  assert.equal(modelProviders(picker, '  gpt-5.4  MINI ')[0].models[0], 'gpt-5.4-mini');
  assert.deepEqual(modelProviders(picker, 'no such model'), []);
});

test('same model name on another provider is not marked as the current choice', () => {
  assert.equal(isCurrentModel(picker, 'other', 'glm-5.3-flash'), false);
  assert.equal(isCurrentModel(picker, 'router', 'glm-5.3-flash'), true);
  assert.deepEqual(modelProviders({ ...picker, providers: undefined }), []);
});

test('two vendor IDs with the same name never both receive the current checkmark', () => {
  const p = { ...picker, current_model: 'vendor-a/custom', current_provider: 'router' };
  assert.equal(isCurrentModel(p, 'router', 'vendor-a/custom'), true);
  assert.equal(isCurrentModel(p, 'router', 'vendor-b/custom'), false);
});

test('the active model and provider stay together when a chat uses a fallback', () => {
  const configured = { model: 'deepseek/default', provider: 'openrouter', label: 'OpenRouter', reasoning_effort: '' };
  assert.equal(activeModel({ configured, chat: { model: 'z-ai/glm', provider: '', source: 'last_turn' } }).model, 'z-ai/glm');
  assert.equal(activeModel({ configured, chat: { model: 'z-ai/glm', provider: '', source: 'last_turn' } }).provider, '');
  assert.equal(activeModel({ configured, chat: null }).model, 'deepseek/default');
});

test('models beyond the old server cap are searchable and selectable by exact ID', () => {
  const providers = modelProviders({ ...picker, providers: [{ slug: 'router', name: 'OpenRouter', models: Array.from({ length: 500 }, (_, i) => `vendor/model-${i}`) }] }, 'model-499');
  assert.deepEqual(providers[0].models, ['vendor/model-499']);
});
