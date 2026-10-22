import { router } from 'expo-router';
import { useContext, useState, type ReactNode } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { haptic } from '../lib/haptics';
import { makeStyles, useTheme } from '../lib/themeContext';
import { ChevronLeft } from './icons';
import { IconButton } from './ui';
import { ServerScreenContext } from '../lib/serverScreenContext';

/** A pushed screen: back button, large title, and a centred scrolling column. Pull down to refresh it. */
export function Screen({ title, subtitle, children, right, onRefresh }: {
  title: string; subtitle?: string; children: ReactNode; right?: ReactNode;
  /** Reload what the screen shows; the spinner stays until it's done. */
  onRefresh?: () => unknown;
}) {
  const t = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const bot = useContext(ServerScreenContext);
  const refresh = async () => {
    haptic.soft();
    setRefreshing(true);
    try {
      await Promise.all([Promise.resolve(onRefresh?.()).catch(() => undefined), new Promise((r) => setTimeout(r, 400))]);
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <View style={s.root}>
      <ScrollView contentContainerStyle={[s.content, { paddingTop: insets.top + 6, paddingBottom: insets.bottom + 40 }]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
        refreshControl={onRefresh ? (
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={t.colors.accent} colors={[t.colors.accentFill]}
            progressBackgroundColor={t.colors.surfaceRaised} />
        ) : undefined}>
        <View style={s.top}>
          <IconButton label="Back" variant="filled" onPress={() => (router.canGoBack() ? router.back() : router.replace('/agent'))}>
            <ChevronLeft size={24} color={t.colors.text} />
          </IconButton>
          {bot ? <Text style={s.bot} numberOfLines={1} accessibilityLabel={`Managing ${bot}`}>{bot}</Text> : null}
          {right}
        </View>
        <Text style={s.title} accessibilityRole="header">{title}</Text>
        {subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : null}
        {children}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: t.colors.bg },
  content: { paddingHorizontal: 16, maxWidth: 680, width: '100%', alignSelf: 'center' },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48 },
  bot: { ...t.type.caption, color: t.colors.textSecondary, flex: 1, textAlign: 'right', marginHorizontal: 12 },
  title: { ...t.type.display, color: t.colors.text, marginTop: 12 },
  subtitle: { ...t.type.callout, color: t.colors.textSecondary, marginTop: 6 },
}));
