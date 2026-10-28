import Svg, { Path } from 'react-native-svg';

/** The sidebar button's mark: two lines, the lower one shorter, drawn like the lucide icons around it. */
export function MenuMark({ size = 24, color = 'currentColor', strokeWidth = 2 }: { size?: number; color?: string; strokeWidth?: number }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round">
    <Path d="M3.5 8.5h17M3.5 15.5h10" />
  </Svg>;
}
