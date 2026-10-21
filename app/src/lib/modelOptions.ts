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

export function isCurrentModel(picker: Picker, provider: string, model: string): boolean {
  return provider === picker.current_provider && !!picker.current_model && shortModel(model) === shortModel(picker.current_model);
}

/** Current provider/model first; search both readable names and exact ids without changing either. */
export function modelProviders(picker: Picker, query = '') {
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
