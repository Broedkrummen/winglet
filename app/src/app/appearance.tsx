import { LinearGradient } from 'expo-linear-gradient';
import { Platform, Text, View } from 'react-native';
import { BotAvatar } from '../components/BotAvatar';
import { Check, Monitor, Moon, Sun } from '../components/icons';
import { Screen } from '../components/Screen';
import { ListGroup, ListRow, SectionHeader, Segmented, Tap, Toggle } from '../components/ui';
import { usePrefs, type Prefs } from '../lib/prefs';
import { ACCENT_NAMES, ACCENTS } from '../lib/theme';
import { makeStyles, useTheme } from '../lib/themeContext';

/** Theme, accent colour, chat layout, motion, glass and haptics. Every change applies at once. */
export default function AppearanceScreen() {
  const t = useTheme();
  const s = useStyles();
  const prefs = usePrefs((st) => st.prefs);
  const update = usePrefs((st) => st.update);
  const set = <K extends keyof Prefs>(key: K) => (value: Prefs[K]) => update({ [key]: value } as Partial<Prefs>);
  const icon = (I: typeof Sun) => <I size={16} color={t.colors.textSecondary} />;

  return (
    <Screen title="Appearance">
      <Preview />

      <SectionHeader title="Sidebar" />
      <Segmented label="Sidebar" value={prefs.sidebar} onChange={set('sidebar')} options={[
        { value: 'auto', label: 'Automatic' }, { value: 'drawer', label: 'Drawer' }, { value: 'pinned', label: 'Pinned' },
      ]} />
      <Text style={s.note}>Automatic keeps the sidebar open on large screens. Pinned adds a compact sidebar on phones.</Text>

      <SectionHeader title="Theme" />
      <Segmented label="Theme" value={prefs.theme} onChange={set('theme')} options={[
        { value: 'system', label: 'System', icon: icon(Monitor) },
        { value: 'light', label: 'Light', icon: icon(Sun) },
        { value: 'dark', label: 'Dark', icon: icon(Moon) },
      ]} />
      <Text style={s.note}>Dark is true black, so OLED screens switch those pixels off.</Text>

      <SectionHeader title="Accent" />
      <View style={s.swatches} accessibilityRole="radiogroup" accessibilityLabel="Accent colour">
        {ACCENT_NAMES.map((name) => {
          const a = ACCENTS[name];
          const on = prefs.accent === name;
          return (
            <Tap key={name} feedback="selection" accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={a.label}
              onPress={() => update({ accent: name })} style={s.swatchCell}>
              <View style={[s.swatchRing, on && { borderColor: t.scheme === 'dark' ? a.dark : a.light }]}>
                <LinearGradient colors={[a.fillLight, a.fill]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.swatch}>
                  {on ? <Check size={20} color={t.colors.onAccent} strokeWidth={3} /> : null}
                </LinearGradient>
              </View>
              <Text style={[s.swatchLabel, on && { color: t.colors.text }]}>{a.label}</Text>
            </Tap>
          );
        })}
      </View>

      <SectionHeader title="Chat layout" />
      <Segmented label="Chat layout" value={prefs.layout} onChange={set('layout')} options={[
        { value: 'bubbles', label: 'Bubbles' }, { value: 'compact', label: 'Compact' },
      ]} />
      <Text style={s.note}>
        {prefs.layout === 'bubbles' ? 'Your messages in bubbles on the right; replies full width, easy to read on a phone.'
          : 'Smaller text, tighter spacing and left-aligned messages with names and times.'}
      </Text>

      <SectionHeader title="Motion and glass" />
      <Text style={s.label}>Animation</Text>
      <Segmented label="Animation" value={prefs.motion} onChange={set('motion')} options={[
        { value: 'system', label: 'Match phone' }, { value: 'reduce', label: 'Reduced' }, { value: 'full', label: 'Full' },
      ]} />
      <Text style={[s.label, { marginTop: 16 }]}>Transparency</Text>
      <Segmented label="Transparency" value={prefs.transparency} onChange={set('transparency')} options={[
        { value: 'system', label: 'Match phone' }, { value: 'reduce', label: 'Solid' }, { value: 'full', label: 'Glass' },
      ]} />
      <Text style={s.note}>Reduced animation stops loops and replaces springs with quick fades. Solid swaps frosted glass for plain surfaces.</Text>

      <SectionHeader title="Feel" />
      <ListGroup>
        <ListRow title="Haptics" subtitle={Platform.OS === 'web' ? 'Not available in the web app' : 'A light tap when you send, switch or confirm'}
          right={<Toggle label="Haptics" value={prefs.haptics} onValueChange={set('haptics')} />} />
        <ListRow title="Sounds" subtitle="Soft sounds when you send, a reply lands, or something needs you"
          right={<Toggle label="Sounds" value={prefs.sounds} onValueChange={set('sounds')} />} />
      </ListGroup>
    </Screen>
  );
}

/** A small live sample of a conversation in the current theme, accent and layout. */
function Preview() {
  const t = useTheme();
  const s = useStyles();
  const layout = usePrefs((st) => st.prefs.layout);
  return (
    <View style={s.preview} accessibilityLabel="Preview" accessibilityRole="image">
      <View style={s.previewBot}>
        <BotAvatar name="hermes" size={26} mood="happy" />
        <Text style={s.previewText}>Your disk is 46% full. Want a weekly check?</Text>
      </View>
      {layout === 'bubbles' ? (
        <LinearGradient colors={[t.colors.accentFillLight, t.colors.accentFill]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.previewBubble}>
          <Text style={[s.previewText, { color: t.colors.onAccent }]}>Yes, every Monday</Text>
        </LinearGradient>
      ) : (
        <View style={s.previewBot}>
          <View style={s.previewMe} />
          <Text style={s.previewText}>Yes, every Monday</Text>
        </View>
      )}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  note: { ...t.type.caption, fontFamily: t.fonts.regular, fontSize: 13, color: t.colors.textSecondary, marginTop: 10, lineHeight: 18 },
  label: { ...t.type.label, color: t.colors.textSecondary, marginBottom: 8 },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'space-between' },
  swatchCell: { alignItems: 'center', gap: 6, minWidth: 58 },
  swatchRing: { padding: 3, borderRadius: 30, borderWidth: 2, borderColor: 'transparent' },
  swatch: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  swatchLabel: { ...t.type.caption, color: t.colors.textSecondary },
  preview: {
    marginTop: 18, padding: 16, gap: 12, borderRadius: t.radius.lg, backgroundColor: t.colors.surface,
    borderWidth: 1, borderColor: t.colors.border,
  },
  previewBot: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  previewMe: { width: 26, height: 26, borderRadius: 13, backgroundColor: t.colors.surfaceSunken },
  previewText: { ...t.type.callout, color: t.colors.text, flexShrink: 1 },
  previewBubble: { alignSelf: 'flex-end', borderRadius: 20, borderBottomRightRadius: 6, paddingHorizontal: 14, paddingVertical: 9 },
}));
