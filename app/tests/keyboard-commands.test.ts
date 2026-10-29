import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commands, findCommands, shortcutCommand, shortcutLabel } from '../src/features/keyboard/commands.ts';

const context = { locked: false, modal: false, editing: false, desktopInput: false, mac: false };
const key = { key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };

test('command discovery matches all search words and exposes one unique registry', () => {
  assert.equal(new Set(commands.map(command => command.id)).size, commands.length);
  assert.deepEqual(findCommands('questions waiting').map(command => command.id), ['inbox']);
  assert.equal(findCommands('nothing-matches').length, 0);
  assert.equal(findCommands(' ').length, commands.length);
  assert.equal(shortcutLabel(commands[0], false), 'Ctrl + K');
});

test('shortcuts require the platform modifier and exact shift state', () => {
  assert.equal(shortcutCommand(key, context), 'commands');
  assert.equal(shortcutCommand({ ...key, ctrlKey: false, metaKey: true }, { ...context, mac: true }), 'commands');
  assert.equal(shortcutCommand({ ...key, key: 'I', shiftKey: true }, context), 'inbox');
  for (const event of [{ ...key, ctrlKey: false }, { ...key, shiftKey: true }, { ...key, metaKey: true }, { ...key, altKey: true }]) {
    assert.equal(shortcutCommand(event, context), undefined);
  }
});

test('typing, composition, dialogs, lock and computer control always retain their keys', () => {
  for (const flag of ['locked', 'modal', 'editing', 'desktopInput']) {
    assert.equal(shortcutCommand(key, { ...context, [flag]: true }), undefined);
  }
  for (const event of [{ ...key, isComposing: true }, { ...key, keyCode: 229 }, { ...key, repeat: true }, { ...key, defaultPrevented: true }]) {
    assert.equal(shortcutCommand(event, context), undefined);
  }
});
