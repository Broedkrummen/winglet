import { Platform, Text, View, StyleSheet } from 'react-native';
import { BotAvatar } from '../components/BotAvatar';
import { Check, Monitor, Moon, Sun } from '../components/icons';
import { Screen } from '../components/Screen';
import { Card, Footnote, ListGroup, ListRow, SectionHeader, Segmented, Tap, Toggle } from '../components/ui';
import { usePrefs, type Prefs } from '../lib/prefs';
import { ACCENT_NAMES, ACCENTS, DARK_TONES, type Colors, type DarkTone } from '../lib/theme';
import { makeStyles, themeFor, useTheme } from '../lib/themeContext';

const THEMES = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
] as const;

const TONE_LABELS: Record<DarkTone, string> = { charcoal: 'Charcoal', graphite: 'Graphite', black: 'Black' };

/** Every change applies at once. Sidebar placement is in Settings. */
export default function AppearanceScreen() {
  const t = useTheme();
  const s = useStyles();
  const prefs = usePrefs((st) => st.prefs);
  const update = usePrefs((st) => st.update);
  const set = <K extends keyof Prefs>(key: K) => (value: Prefs[K]) => update({ [key]: value } as Partial<Prefs>);
  const light = themeFor('light', prefs.accent).colors;
  const dark = themeFor('dark', prefs.accent, prefs.darkTone).colors;

  return (
    <Screen title="Appearance">
      <Preview />

      <SectionHeader title="Theme" />
      <View style={s.themes} accessibilityRole="radiogroup" accessibilityLabel="Theme">
        {THEMES.map(({ value, label, icon: Icon }) => {
          const on = prefs.theme === value;
          return (
            <Tap key={value} feedback="selection" scaleTo={0.96} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={label}
              onPress={() => { if (!on) set('theme')(value); }} style={s.themeCell}>
              <View style={[s.themeFrame, on && { borderColor: t.colors.text }]}>
                <View style={s.themeShot}>
                  {value === 'system' ? <>
                    <MiniTheme colors={light} half="left" />
                    <MiniTheme colors={dark} half="right" />
                  </> : <MiniTheme colors={value === 'light' ? light : dark} />}
                </View>
                {on ? <View style={s.themeCheck}><Check size={12} color={t.colors.onInk} strokeWidth={3.5} /></View> : null}
              </View>
              <View style={s.themeLabel}>
                <Icon size={14} color={on ? t.colors.text : t.colors.textSecondary} />
                <Text style={[s.swatchLabel, on && s.labelOn]}>{label}</Text>
              </View>
            </Tap>
          );
        })}
      </View>
      {prefs.theme !== 'light' ? <>
        <SectionHeader title="Dark mode" />
        <View style={s.themes} accessibilityRole="radiogroup" accessibilityLabel="Dark mode tone">
          {DARK_TONES.map((tone) => {
            const on = prefs.darkTone === tone;
            return (
              <Tap key={tone} feedback="selection" scaleTo={0.96} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={TONE_LABELS[tone]}
                onPress={() => { if (!on) set('darkTone')(tone); }} style={s.themeCell}>
                <View style={[s.themeFrame, on && { borderColor: t.colors.text }]}>
                  <View style={[s.themeShot, s.toneShot]}><MiniTheme colors={themeFor('dark', prefs.accent, tone).colors} /></View>
                  {on ? <View style={s.themeCheck}><Check size={12} color={t.colors.onInk} strokeWidth={3.5} /></View> : null}
                </View>
                <Text style={[s.swatchLabel, on && s.labelOn]}>{TONE_LABELS[tone]}</Text>
              </Tap>
            );
          })}
        </View>
        <Footnote>Black saves battery on OLED screens.</Footnote>
      </> : null}

      <SectionHeader title="Accent" />
      <Card>
        <View style={s.swatches} accessibilityRole="radiogroup" accessibilityLabel="Accent colour">
          {ACCENT_NAMES.map((name) => {
            const a = ACCENTS[name];
            const on = prefs.accent === name;
            return (
              <Tap key={name} feedback="selection" accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={a.label}
                onPress={() => update({ accent: name })} style={s.swatchCell}>
                <View style={[s.swatchRing, on && { borderColor: t.colors.text }]}>
                  <View style={[s.swatch, { backgroundColor: t.scheme === 'dark' ? a.dark : a.fill }]}>
                    {on ? <Check size={16} color={t.scheme === 'dark' ? t.colors.bg : t.colors.onAccent} strokeWidth={3} /> : null}
                  </View>
                </View>
                <Text style={[s.swatchLabel, on && s.labelOn]}>{a.label}</Text>
              </Tap>
            );
          })}
        </View>
      </Card>

      <SectionHeader title="Chat layout" />
      <Card>
        <Segmented label="Chat layout" value={prefs.layout} onChange={set('layout')} options={[
          { value: 'bubbles', label: 'Bubbles' }, { value: 'compact', label: 'Compact' },
        ]} />
      </Card>

      <SectionHeader title="Motion & transparency" />
      <ListGroup>
        <View style={s.control}>
          <Text style={s.label}>Animation</Text>
          <Segmented label="Animation" value={prefs.motion} onChange={set('motion')} options={[
            { value: 'system', label: 'System' }, { value: 'reduce', label: 'Reduced' }, { value: 'full', label: 'Full' },
          ]} />
        </View>
        <View style={s.control}>
          <Text style={s.label}>Transparency</Text>
          <Segmented label="Transparency" value={prefs.transparency} onChange={set('transparency')} options={[
            { value: 'system', label: 'System' }, { value: 'reduce', label: 'Solid' }, { value: 'full', label: 'Glass' },
          ]} />
        </View>
      </ListGroup>

      <SectionHeader title="Feedback" />
      <ListGroup>
        <ListRow title="Haptics" value={Platform.OS === 'web' ? 'Unavailable on web' : undefined}
          right={<Toggle label="Haptics" value={prefs.haptics} onValueChange={set('haptics')} />} />
        <ListRow title="Sounds" right={<Toggle label="Sounds" value={prefs.sounds} onValueChange={set('sounds')} />} />
      </ListGroup>
    </Screen>
  );
}

/** A tiny screen in one theme: a title, a reply and your message in the accent. System shows half of each. */
function MiniTheme({ colors: c, half }: { colors: Colors; half?: 'left' | 'right' }) {
  const s = useStyles();
  return (
    <View style={[s.mini, { backgroundColor: c.bg }]}>
      <View style={[s.miniInner, half === 'left' && s.miniLeft, half === 'right' && s.miniRight]}>
        <View style={[s.miniLine, { backgroundColor: c.borderStrong, width: '46%' }]} />
        <View style={[s.miniBubble, { backgroundColor: c.surfaceHigh, borderColor: c.border, width: '72%' }]} />
        <View style={[s.miniBubble, { backgroundColor: c.bubble, borderColor: 'transparent', width: '52%', alignSelf: 'flex-end' }]} />
      </View>
    </View>
  );
}

/** A live sample of the current theme, accent and layout. */
function Preview() {
  const t = useTheme();
  const s = useStyles();
  const layout = usePrefs((st) => st.prefs.layout);
  return (
    <Card style={s.preview} accessibilityLabel="Preview">
      <View style={s.previewBot} accessibilityRole="image" accessibilityLabel="Conversation preview">
        <BotAvatar name="hermes" size={26} mood="happy" />
        <Text style={s.previewText}>Want a weekly disk check?</Text>
      </View>
      {layout === 'bubbles' ? (
        <View style={[s.previewBubble, { backgroundColor: t.colors.bubble }]}>
          <Text style={s.previewText}>Yes, every Monday</Text>
        </View>
      ) : (
        <View style={s.previewBot}>
          <View style={s.previewMe} />
          <Text style={s.previewText}>Yes, every Monday</Text>
        </View>
      )}
    </Card>
  );
}

const useStyles = makeStyles((t) => ({
  control: { padding: t.space.lg, gap: t.space.sm },
  label: { ...t.type.body, fontSize: 15.5, color: t.colors.text },
  swatches: { flexDirection: 'row', justifyContent: 'space-between', gap: t.space.xs },
  swatchCell: { flex: 1, alignItems: 'center', gap: t.space.sm, minWidth: 48, minHeight: 48 },
  swatchRing: { padding: 3, borderRadius: t.radius.pill, borderWidth: 2, borderColor: 'transparent' },
  swatch: { width: 36, height: 36, borderRadius: t.radius.pill, alignItems: 'center', justifyContent: 'center' },
  swatchLabel: { ...t.type.caption, color: t.colors.textSecondary },
  labelOn: { color: t.colors.text, fontFamily: t.fonts.semibold },
  themes: { flexDirection: 'row', gap: t.space.md },
  themeCell: { flex: 1, alignItems: 'center', gap: t.space.sm },
  themeFrame: { alignSelf: 'stretch', borderRadius: t.radius.lg, borderWidth: 2, borderColor: 'transparent', padding: 3 },
  themeShot: {
    height: 96, flexDirection: 'row', borderRadius: t.radius.md, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth * 2, borderColor: t.colors.border,
  },
  toneShot: { height: 80 },
  themeCheck: {
    position: 'absolute', top: 9, right: 9, width: 20, height: 20, borderRadius: t.radius.pill, backgroundColor: t.colors.ink,
    alignItems: 'center', justifyContent: 'center',
  },
  themeLabel: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  mini: { flex: 1, overflow: 'hidden' },
  miniInner: { flex: 1, padding: 10, paddingTop: 14, gap: 8 },
  // Each half of System shows its side of one little screen, so the two read as a single picture.
  miniLeft: { width: '200%' },
  miniRight: { width: '200%', marginLeft: '-100%' },
  miniLine: { height: 6, borderRadius: t.radius.pill },
  miniBubble: { height: 16, borderRadius: t.radius.pill, borderWidth: 1 },
  preview: { marginTop: t.space.md, gap: t.space.md },
  previewBot: { flexDirection: 'row', alignItems: 'center', gap: t.space.md },
  previewMe: { width: 26, height: 26, borderRadius: t.radius.pill, backgroundColor: t.colors.surfaceSunken },
  previewText: { ...t.type.callout, color: t.colors.text, flexShrink: 1 },
  previewBubble: { alignSelf: 'flex-end', borderRadius: t.radius.lg, borderBottomRightRadius: 6, paddingHorizontal: t.space.lg, paddingVertical: t.space.sm },
}));
