/** A chat can have a Home composer beneath an open chat or quick-ask sheet. Focus the topmost one. */
const targets = new Map<string, Set<() => void>>();

export function registerComposer(key: string, focus: () => void): () => void {
  const stack = targets.get(key) ?? new Set<() => void>();
  stack.add(focus);
  targets.set(key, stack);
  return () => {
    stack.delete(focus);
    if (!stack.size && targets.get(key) === stack) targets.delete(key);
  };
}

export function focusRegisteredComposer(key: string): void {
  const stack = targets.get(key);
  if (stack) [...stack].at(-1)?.();
}
