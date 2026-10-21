import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyboardInset } from '../src/lib/keyboard.ts';

test('edge-to-edge chat lifts its viewport clear of a docked keyboard', () => {
  assert.equal(keyboardInset(0, 934, { screenY: 596, height: 338 }), 338);
});
test('an Android window already resized by the IME gets no duplicate offset', () => {
  assert.equal(keyboardInset(0, 596, { screenY: 596, height: 338 }), 0);
});
test('embedded and offset panes lift only their actual overlap', () => {
  assert.equal(keyboardInset(100, 450, { screenY: 500, height: 350 }), 50);
  assert.equal(keyboardInset(0, 450, { screenY: 500, height: 350 }), 0);
});
test('closing the keyboard or using a hardware keyboard removes all inset', () => {
  assert.equal(keyboardInset(0, 934, null), 0);
  assert.equal(keyboardInset(0, 934, { screenY: 596, height: 0 }), 0);
});
