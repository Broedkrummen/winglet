import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import { useTheme } from '../lib/themeContext';

/** The two wings, tips turned up like winglets, on a 64-unit grid. The agent sits between them. */
export const WINGS_PATH = 'M10.5 22.5c2.6 1 4.2 3 5.4 5.6 2.6 6.4 5 13.4 7.6 13.4 3.4 0 5.9-3.8 8.5-9.3 2.6 5.5 5.1 9.3 8.5 9.3 2.6 0 5-7 7.6-13.4 1.2-2.6 2.8-4.6 5.4-5.6';

/** The Winglet mark on a solid tile, in the theme's ink so it sits quietly in either theme. */
export function Logo({ size = 48 }: { size?: number }) {
  const t = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" accessibilityLabel="Winglet">
      <Rect x={0} y={0} width={64} height={64} rx={15} fill={t.colors.ink} />
      <G transform="translate(32 32) scale(0.86) translate(-32 -30.5)">
        <Path d={WINGS_PATH} fill="none" stroke={t.colors.onInk} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" />
        <Circle cx={32} cy={21} r={4.6} fill={t.colors.onInk} />
      </G>
    </Svg>
  );
}
