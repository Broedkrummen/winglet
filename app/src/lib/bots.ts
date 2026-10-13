/** A bot's short name (its Hermes profile name) from what it's called: "Meal Planner!" reads "meal-planner". */
export function botName(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}
