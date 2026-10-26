export type ConfigValue = number | boolean | null;
export type ConfigField = {
  key: string; label: string; section: string; type: 'boolean' | 'integer' | 'number';
  description: string; value: ConfigValue; default: ConfigValue; source: 'override' | 'inherited' | 'managed'; writable: boolean;
  minimum: number; maximum: number; applies: 'next_turn' | 'new_session';
};
export type ConfigCatalog = { revision: string; fields: ConfigField[]; applies: 'next_turn' | 'new_session' | 'mixed' };
export type Changes = Record<string, ConfigValue | null>;
export type ConfigPreview = { revision: string; changes: {key: string; label: string; before: ConfigValue; after: ConfigValue; reset: boolean; applies: 'next_turn' | 'new_session'}[] };
export type Draft = { catalog: ConfigCatalog; changes: Changes };
const drafts = new Map<string, Draft>();
export const draftKey = (id: string, profile?: string) => JSON.stringify([id, profile ?? '']);
export function savedDraft(key: string): Draft | undefined { return drafts.get(key); }
export function keepDraft(key: string, draft?: Draft) {
  if (!draft || !Object.keys(draft.changes).length) drafts.delete(key);
  else drafts.set(key, { catalog: draft.catalog, changes: { ...draft.changes } });
}
export function parseConfigValue(field: ConfigField, text: string): number {
  if (!text.trim()) throw new Error('Enter a number.');
  const value = Number(text);
  if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value))) throw new Error('Enter a finite ' + (field.type === 'integer' ? 'whole number.' : 'number.'));
  if (value < field.minimum || value > field.maximum) throw new Error(`Use a value from ${field.minimum} to ${field.maximum}.`);
  return value;
}
export function matchingFields(fields: ConfigField[], search: string): ConfigField[] {
  const words = search.trim().toLocaleLowerCase().split(/\s+/);
  return fields.filter(f => words.every(word => `${f.label} ${f.section} ${f.description}`.toLocaleLowerCase().includes(word)));
}
export function valueLabel(value: ConfigValue) { return value === null ? 'Automatic' : typeof value === 'boolean' ? (value ? 'On' : 'Off') : String(value); }

