import { useEffect, type RefObject } from 'react';
import { Platform } from 'react-native';

/** Native drawers use platform accessibility; web drawers also need keyboard containment. */
export function useModalFocus(visible: boolean, panel: RefObject<unknown>, close: () => void) {
  useEffect(() => {
    if (!visible || Platform.OS !== 'web') return;
    const previous = document.activeElement as HTMLElement | null;
    const root = panel.current as HTMLElement | null;
    if (!root) return;
    const controls = () => Array.from(root.querySelectorAll<HTMLElement>('button,input,textarea,select,[tabindex],[role="button"],[role="radio"]'))
      .filter((node) => node.tabIndex >= 0 && !node.matches(':disabled,[aria-disabled="true"]') && node.getClientRects().length > 0);
    const frame = requestAnimationFrame(() => controls()[0]?.focus());
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab') return;
      const items = controls();
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (!items.length) { event.preventDefault(); return; }
      if (index < 0 || (!event.shiftKey && index === items.length - 1) || (event.shiftKey && index === 0)) {
        event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0]?.focus();
      }
    };
    document.addEventListener('keydown', key, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', key, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [visible, panel, close]);
}
