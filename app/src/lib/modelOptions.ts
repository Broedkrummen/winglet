import type { Picker } from './types';

/** Keep the model's version and qualifiers, while removing transport/provider prefixes. */
export const shortModel = (id: string) => (id.split('/').pop() || id)
  .replace(/^(us|eu|apac|global)\./, '')
  .replace(/^(anthropic|openai|meta|amazon|mistral|cohere|ai21|deepseek|qwen|writer)\./, '');

/** A readable label only: the server's exact id is always used when making a choice. */
export function modelName(id: string): string {
  return shortModel(id)
    .replace(/^(claude-.*)-\d{8}$/, '$1')
    .replace(/\b(\d+)-(\d+)(?=-|$)/g, '$1.$2')
    .replace(/-/g, ' ')
    .replace(/\b(gpt|glm|llama|qwen|claude|fable|opus|sonnet|haiku|gemini|deepseek|mistral|mini|nano|flash|pro|lite|chat|max)\b/gi,
      (word) => /^(gpt|glm)$/i.test(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1).toLowerCase());
}

type ModelSelection = Pick<Picker, 'providers' | 'current_model' | 'current_provider'>;
export type SavedModel = { provider: string; model: string };

export const savedModelKey = (value: SavedModel) => JSON.stringify([value.provider, value.model]);

export function toggleSavedModel(saved: SavedModel[], value: SavedModel): SavedModel[] {
  const key = savedModelKey(value);
  return saved.some((entry) => savedModelKey(entry) === key) ? saved.filter((entry) => savedModelKey(entry) !== key) : [...saved, value];
}

export function recentModels(saved: SavedModel[], value: SavedModel): SavedModel[] {
  return [value, ...saved.filter((entry) => savedModelKey(entry) !== savedModelKey(value))].slice(0, 8);
}

/** Saved choices cannot offer a provider missing from this server's authenticated catalog. */
export function availableSavedModels(saved: SavedModel[], picker: ModelSelection): (SavedModel & { providerName: string })[] {
  const seen = new Set<string>();
  return saved.flatMap((entry) => {
    const provider = picker.providers?.find((p) => p.slug === entry.provider);
    const key = savedModelKey(entry);
    if (!provider || !entry.model || seen.has(key) || (!provider.custom_models && !provider.models.includes(entry.model))) return [];
    seen.add(key);
    return [{ ...entry, providerName: provider.name }];
  });
}

export function isCurrentModel(picker: ModelSelection, provider: string, model: string): boolean {
  if (provider !== picker.current_provider || !picker.current_model) return false;
  // Exact vendor IDs disambiguate snapshots and same-named models on aggregators.
  if (model === picker.current_model) return true;
  if (model.includes('/') && picker.current_model.includes('/')) return false;
  return shortModel(model) === shortModel(picker.current_model);
}

/** Prefer this chat's resolved model; never borrow another chat's provider label. */
export function activeModel(info: import('./types').AgentInfo | null | undefined) {
  if (info?.chat?.model) return { model: info.chat.model, provider: info.chat.provider || '', source: info.chat.source };
  return { model: info?.configured.model || '', provider: info?.configured.label || info?.configured.provider || '', source: 'default' };
}

/** Current provider/model first; search both readable names and exact ids without changing either. */
export function modelProviders(picker: ModelSelection, query = '') {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (picker.providers ?? []).map((provider) => ({
    ...provider,
    models: provider.models.filter((id) => {
      const text = `${provider.name} ${provider.slug} ${id} ${modelName(id)}`.toLowerCase();
      return words.every((word) => text.includes(word));
    }).sort((a, b) => Number(isCurrentModel(picker, provider.slug, b)) - Number(isCurrentModel(picker, provider.slug, a))),
  })).filter((provider) => provider.models.length)
    .sort((a, b) => Number(b.slug === picker.current_provider) - Number(a.slug === picker.current_provider));
}
