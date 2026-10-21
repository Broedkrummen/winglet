import assert from 'node:assert/strict';
import { test } from 'node:test';
import { focusRegisteredComposer, registerComposer } from '../src/lib/composerFocus.ts';

test('closing a chat or sheet restores focus to the composer below it', () => {
  const focused: string[] = [];
  const home = registerComposer('chat', () => focused.push('home'));
  const chat = registerComposer('chat', () => focused.push('chat'));
  const sheet = registerComposer('chat', () => focused.push('sheet'));
  focusRegisteredComposer('chat');
  sheet(); focusRegisteredComposer('chat');
  chat(); focusRegisteredComposer('chat');
  home(); focusRegisteredComposer('chat');
  assert.deepEqual(focused, ['sheet', 'chat', 'home']);
});

test('unmounting an older composer cannot remove the active one or focus another bot', () => {
  const focused: string[] = [];
  const old = registerComposer('bot-a:chat', () => focused.push('old'));
  const active = registerComposer('bot-a:chat', () => focused.push('active'));
  const other = registerComposer('bot-b:chat', () => focused.push('other'));
  old(); focusRegisteredComposer('bot-a:chat');
  assert.deepEqual(focused, ['active']);
  active(); other();
});
