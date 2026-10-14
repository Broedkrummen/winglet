/** A bot's short name (its Hermes profile name) from what it's called: "Meal Planner!" reads "meal-planner". */
export function botName(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

/**
 * Which bot is the main one: the one chosen, if it's still paired, else the first bot paired on its own
 * (not one made on another bot's server), else the first of all. The rest are secondary bots.
 */
export function resolveMainBot<T extends { id: string; parent?: string }>(servers: readonly T[], chosen?: string): T | undefined {
  return servers.find((x) => x.id === chosen) ?? servers.find((x) => !x.parent) ?? servers[0];
}

/** The main bot first, then the others in the order they were paired. */
export function mainFirst<T extends { id: string; parent?: string }>(servers: readonly T[], chosen?: string): T[] {
  const main = resolveMainBot(servers, chosen);
  return main ? [main, ...servers.filter((x) => x !== main)] : [];
}
