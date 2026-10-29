export type CommandId = 'commands' | 'home' | 'chats' | 'inbox' | 'settings' | 'new-chat' | 'bots' | 'bookmarks';
export type Command = { id: CommandId; label: string; keywords: string; key?: string; shift?: boolean };

/** Shared discovery and shortcut registry; execution stays with the existing navigation actions. */
export const commands: readonly Command[] = [
  { id: 'commands', label: 'Commands and keyboard shortcuts', keywords: 'help actions search', key: 'k' },
  { id: 'home', label: 'Home', keywords: 'main bot conversation', key: 'h', shift: true },
  { id: 'chats', label: 'Conversations and search', keywords: 'chats messages find', key: 'f', shift: true },
  { id: 'inbox', label: 'Inbox', keywords: 'approvals questions waiting', key: 'i', shift: true },
  { id: 'settings', label: 'Settings', keywords: 'preferences appearance sync' },
  { id: 'bookmarks', label: 'Saved answers', keywords: 'bookmarks notes tags snapshots' },
  { id: 'new-chat', label: 'New conversation', keywords: 'chat start', key: 'o', shift: true },
  { id: 'bots', label: 'Choose a bot', keywords: 'server switch agent' },
];

export function findCommands(query: string): readonly Command[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter(command => words.every(word => `${command.label} ${command.keywords}`.toLocaleLowerCase().includes(word)));
}

export type ShortcutContext = { locked: boolean; modal: boolean; editing: boolean; desktopInput: boolean; mac: boolean };
export type KeyInput = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean;
  isComposing?: boolean; keyCode?: number; repeat?: boolean; defaultPrevented?: boolean };

export function shortcutCommand(event: KeyInput, context: ShortcutContext): CommandId | undefined {
  if (context.locked || context.modal || context.editing || context.desktopInput || event.defaultPrevented
    || event.isComposing || event.keyCode === 229 || event.repeat || event.altKey) return;
  if (context.mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
  return commands.find(command => command.key === event.key.toLowerCase() && !!command.shift === event.shiftKey)?.id;
}

export function shortcutLabel(command: Command, mac: boolean): string | undefined {
  return command.key ? `${mac ? '⌘' : 'Ctrl'}${command.shift ? ' + Shift' : ''} + ${command.key.toUpperCase()}` : undefined;
}
