import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Keyboard, Platform, View, useWindowDimensions, type KeyboardEvent } from 'react-native';
import { keyboardInset } from '../lib/keyboard';

/**
 * Keep absolute composers in a real, smaller viewport. Android edge-to-edge windows don't always
 * resize for the IME; measuring the outer view also prevents a second inset when they do resize.
 */
export function KeyboardViewport({ children }: { children: (keyboardVisible: boolean) => ReactNode }) {
  const root = useRef<View>(null);
  const frame = useRef<{ screenY: number; height: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const [inset, setInset] = useState(0);
  const live = useRef(true);
  const { height, width } = useWindowDimensions();
  const measure = useCallback(() => {
    if (!frame.current) { setInset(0); return; }
    root.current?.measureInWindow((_x, y, _width, h) => {
      if (live.current) setInset(keyboardInset(y, h, frame.current));
    });
  }, []);

  useEffect(() => {
    live.current = true;
    if (Platform.OS === 'web') return () => { live.current = false; };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = (event?: KeyboardEvent) => {
      frame.current = event?.endCoordinates ?? Keyboard.metrics?.() ?? null;
      setVisible(!!frame.current && frame.current.height > 0);
      measure();
      clearTimeout(timer);
      timer = setTimeout(measure, 100); // remeasure after adjustResize, when the OS uses it
    };
    const hide = () => { frame.current = null; setVisible(false); setInset(0); clearTimeout(timer); };
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', update);
    const change = Keyboard.addListener(ios ? 'keyboardWillChangeFrame' : 'keyboardDidChangeFrame', update);
    const hidden = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', hide);
    update();
    return () => { live.current = false; clearTimeout(timer); show.remove(); change.remove(); hidden.remove(); };
  }, [measure]);
  useEffect(measure, [height, width, measure]);

  return <View ref={root} collapsable={false} onLayout={measure} style={{ flex: 1 }}>
    <View style={{ flex: 1, marginBottom: inset }}>{children(visible)}</View>
  </View>;
}
