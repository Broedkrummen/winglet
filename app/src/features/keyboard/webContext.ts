/** DOM inspection only: decisions remain testable in the shortcut registry. */
export function keyboardTarget(event: KeyboardEvent, pathname: string) {
  const target = event.target instanceof Element ? event.target : document.activeElement;
  return {
    modal: !!document.querySelector('[aria-modal="true"],[role="dialog"]'),
    editing: !!target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'),
    desktopInput: pathname.includes('desktop') || !!target?.closest('canvas,iframe,[data-winglet-desktop]'),
    mac: /Mac|iPhone|iPad/.test(navigator.platform),
  };
}
