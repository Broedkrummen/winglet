import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, FadeOutUp } from 'react-native-reanimated';
import { FloatingPill, Sheet } from '../../components/Sheet';
import { ChevronRight, GitBranch } from '../../components/icons';
import { ListGroup, ListRow, Tap } from '../../components/ui';
import { spring, useReducedMotion } from '../../lib/motion';
import { useApp } from '../../lib/store';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { BranchState, Server } from '../../lib/types';
import { ancestryLabel, branchChildrenLabel } from './plan';

/** One quiet ancestor line, not ancestry chrome on every bubble. */
export function BranchStrip({ server, chatId, state }: { server: Server; chatId: string; state: BranchState | null }) {
  const t = useTheme();
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();
  const chat = useApp((st) => st.runtime[server.id]?.chats[chatId]);
  const parent = useApp((st) => {
    const branch = st.runtime[server.id]?.chats[chatId]?.branch;
    return branch ? st.runtime[server.id]?.chats[branch.parent_chat_id] : undefined;
  });
  const children = state?.children ?? [];
  const branch = chat?.branch ?? state?.branch;
  if (!branch && !children.length) return null;

  const openParent = () => {
    if (!branch) return;
    if (!parent) {
      useApp.getState().toast({ serverId: server.id, title: 'Original chat deleted', body: 'This branch kept its own copy of the conversation.' });
      return;
    }
    router.push(`/chat/${server.id}/${parent.id}`);
  };

  return (
    <>
      <Animated.View entering={reduced ? FadeIn.duration(120) : FadeIn.duration(180)}
        exiting={reduced ? FadeOut.duration(120) : FadeOutUp.duration(140)} style={s.float}>
        <Tap
          feedback="selection"
          scaleTo={0.97}
          accessibilityLabel={branch
            ? `${ancestryLabel(branch)}. Show the original chat.`
            : `${branchChildrenLabel(children)}. Show branches.`}
          onPress={branch ? openParent : () => setOpen(true)}
        >
          <FloatingPill style={s.strip}>
            <View style={s.icon}>
              <GitBranch size={15} color={t.colors.textSecondary} />
            </View>
            <Text style={s.title} numberOfLines={1}>
              {branch ? ancestryLabel(branch) : branchChildrenLabel(children)}
            </Text>
            <ChevronRight size={16} color={t.colors.textTertiary} />
          </FloatingPill>
        </Tap>
      </Animated.View>
      <Sheet visible={open} onClose={() => setOpen(false)} title="Branches">
        {children.length ? <ListGroup>{children.map((child) => (
          <ListRow key={child.id} icon={<GitBranch />} title={child.title}
            onPress={() => { setOpen(false); router.push(`/chat/${server.id}/${child.id}`); }} />
        ))}</ListGroup> : <Text style={s.empty}>No branches yet.</Text>}
      </Sheet>
    </>
  );
}

const useStyles = makeStyles((t) => ({
  float: { alignSelf: 'center', maxWidth: 520, marginTop: t.space.sm, marginHorizontal: t.space.md },
  strip: { gap: 10, paddingLeft: 6, paddingRight: t.space.md, paddingVertical: 6 },
  icon: { width: 30, height: 30, borderRadius: t.radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.surfaceSunken },
  title: { ...t.type.footnote, fontFamily: t.fonts.semibold, color: t.colors.text, flexShrink: 1 },
  empty: { ...t.type.callout, color: t.colors.textSecondary, padding: 16 },
}));
