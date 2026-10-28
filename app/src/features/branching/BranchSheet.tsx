import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Sheet } from '../../components/Sheet';
import { GitBranch } from '../../components/icons';
import { Button, Card, Chip, Field, Footnote, ListGroup, ListRow } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { useApp } from '../../lib/store';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { BranchResult, BranchState, Message, Server } from '../../lib/types';
import {
  actionHint, canReplaceInPlace, copiesCount, defaultBranchTitle, destinationNote, laterCount,
  modelLabel, newOperationId, type BranchMode, type BranchWhere,
} from './plan';

export type BranchTarget = { message: Message; mode: BranchMode };

/** The branch/edit/regenerate destination, with its destination title, copy preview and cancel path. */
export function BranchSheet({ server, chatId, chatTitle, messages, state, online, target, onClose, onRefresh }: {
  server: Server; chatId: string; chatTitle: string; messages: readonly Message[];
  state: BranchState | null; online: boolean; target: BranchTarget | null; onClose: () => void;
  onRefresh: () => void | Promise<void>;
}) {
  const t = useTheme();
  const s = useStyles();
  const mode = target?.mode ?? 'branch';
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [where, setWhere] = useState<BranchWhere>('new');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const op = useRef<string | null>(null);
  const message = target?.message;

  useEffect(() => {
    if (!target) return;
    setText(target.mode === 'edit' ? target.message.text : '');
    setTitle(defaultBranchTitle(chatTitle, target.mode));
    setWhere('new');
    setSaving(false);
    setError(null);
    setConfirming(false);
    op.current = null;
  }, [target, chatTitle]);

  const supported = !!state?.supported;
  const busy = !!state?.busy;
  const inPlace = mode === 'regenerate' && where === 'in_place';
  const canReplace = !!message && canReplaceInPlace(state, messages, message);
  const later = message ? laterCount(messages, message.id, mode) : 0;
  const copies = message ? copiesCount(messages, message.id, mode) : 0;
  const blocked = !supported ? (state?.reason || 'This server can’t branch conversations.')
    : !online ? 'Reconnect to branch this chat.'
      : !state?.revision ? 'Reload this chat to branch it.'
        : busy ? 'Wait for the current reply to finish.'
          : null;
  const titleText = mode === 'edit' ? 'Edit message' : mode === 'regenerate' ? 'Regenerate reply' : 'New branch';
  const primary = mode === 'branch' ? 'Create branch' : mode === 'edit' ? 'Branch and send' : inPlace ? 'Replace reply' : 'Branch and regenerate';
  const chosen = inPlace ? 'in_place' : 'new';

  const submit = async () => {
    if (!message || !state?.revision || saving) return;
    if (inPlace && !confirming) {
      setConfirming(true);
      return;
    }
    setSaving(true);
    setError(null);
    op.current = op.current ?? newOperationId();
    const body = {
      op_id: op.current,
      message_id: message.id,
      expected_revision: state.revision,
      mode: inPlace ? 'regenerate' : mode,
      title: title.trim(),
      text: mode === 'edit' ? text.trim() : undefined,
    };
    const path = inPlace
      ? `/api/branching/chats/${encodeURIComponent(chatId)}/regenerate`
      : `/api/branching/chats/${encodeURIComponent(chatId)}/branch`;
    try {
      const result = await api<BranchResult & { ok?: boolean }>(server, path, { method: 'POST', body: JSON.stringify(body) });
      if (result?.chat) {
        useApp.getState().upsertChat(server.id, result.chat);
        useApp.getState().toast({
          serverId: server.id, title: result.replayed ? 'Branch already created' : 'Branch created',
          body: result.warning || 'Opened in a new chat. The original is unchanged.',
        });
        onClose();
        router.push(`/chat/${server.id}/${result.chat.id}`);
      } else {
        useApp.getState().toast({ serverId: server.id, title: 'Reply regenerated', body: 'The current chat continues from your prompt.' });
        onClose();
        await onRefresh();
      }
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      setError({
        code: apiErr?.data?.code || (apiErr?.status === 0 ? 'offline' : 'failed'),
        message: apiErr?.data?.error || apiErr?.message || 'The branch couldn’t be created. Nothing changed.',
      });
      setSaving(false);
      setConfirming(false);
    }
  };

  const refreshAndClear = async () => {
    setError(null);
    setConfirming(false);
    await onRefresh();
  };

  if (!target) return null;
  return (
    <Sheet visible={!!target} onClose={onClose} title={titleText} scrollable>
      <View style={s.body}>
        {error ? (
          <View style={s.errorBox} accessibilityRole="alert">
            <Text style={s.errorTitle}>{error.code === 'stale' ? 'This chat changed' : error.code === 'busy' || error.code === 'in_progress' ? 'Still working' : 'Couldn’t create the branch'}</Text>
            <Text style={s.errorText}>{error.message}</Text>
            <View style={s.errorActions}>
              {error.code === 'stale' ? <Button title="Refresh" variant="secondary" size="sm" onPress={refreshAndClear} /> : null}
              <Button title="Try again" variant="secondary" size="sm" onPress={() => { setError(null); setConfirming(false); }} />
            </View>
          </View>
        ) : null}

        {blocked ? <View style={s.noteBox}><Text style={s.note}>{blocked}</Text></View> : null}

        <Card style={s.destination}>
          <View style={s.destinationHead}>
            <View style={s.destinationIcon}>
              <GitBranch size={20} color={t.colors.textSecondary} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.destinationTitle}>{inPlace ? 'This chat' : 'New chat'}</Text>
              <Text style={s.destinationSub} numberOfLines={2}>{destinationNote(mode, chosen)}</Text>
            </View>
          </View>
          {!inPlace ? (
            <Field label="Branch title" value={title} onChangeText={(v) => { setTitle(v); op.current = null; }}
              maxLength={80} returnKeyType="done" autoCapitalize="sentences" placeholder="Name this branch" />
          ) : null}
        </Card>

        {mode === 'edit' ? (
          <Field label="Your message" value={text} onChangeText={(v) => { setText(v); op.current = null; }}
            multiline textAlignVertical="top" maxLength={16000} style={s.editField}
            hint="The original stays unchanged; the edited message sends in a new branch." />
        ) : null}

        {mode === 'regenerate' ? (
          <View style={{ gap: 8 }}>
            <Text style={s.label}>Destination</Text>
            <View style={s.choices}>
              <Chip label="New chat" selected={where === 'new'} onPress={() => { setWhere('new'); setConfirming(false); op.current = null; }}
                accessibilityLabel="Regenerate in a new branch, keeping the original chat" />
              <Chip label="Replace this reply" selected={where === 'in_place'} onPress={() => {
                if (canReplace) { setWhere('in_place'); setConfirming(false); op.current = null; }
              }} accessibilityLabel={canReplace ? 'Replace this reply in place, destructive' : 'Replacing this reply isn’t available here'} />
            </View>
            {!canReplace ? <Text style={s.hint}>Only the latest finished reply without attachments can be replaced.</Text> : null}
            {inPlace ? <View style={s.dangerNote}><Text style={s.dangerText}>Replaces the current reply. Your prompt stays unchanged.</Text></View> : null}
          </View>
        ) : null}

        <Card style={s.summary}>
          <Text style={s.summaryLine}>{copies ? `${copies} earlier ${copies === 1 ? 'message' : 'messages'} copied into the branch.` : 'The branch starts from the same context.'}</Text>
          <Text style={s.summaryLine}>{actionHint(mode, later, chosen)}</Text>
        </Card>

        <ListGroup><ListRow title="Model" value={state?.model ? modelLabel(state.model) : "Current chat model"} /></ListGroup>
        <Footnote>Uses your current tool permissions.</Footnote>

        {inPlace && confirming ? (
          <View style={s.confirmBox} accessibilityRole="alert">
            <Text style={s.confirmTitle}>Replace this reply?</Text>
            <Text style={s.confirmText}>Replaces this reply from your prompt. This can’t be undone.</Text>
            <View style={s.actions}>
              <Button title="Keep original" variant="secondary" onPress={() => { setConfirming(false); onClose(); }} />
              <Button title="Replace reply" variant="danger" loading={saving} onPress={submit} />
            </View>
          </View>
        ) : (
          <View style={s.actions}>
            <Button title="Cancel" variant="ghost" onPress={onClose} />
            <Button title={primary} loading={saving} disabled={!!blocked || !supported || (mode === 'edit' && !text.trim())}
              onPress={submit} style={{ flex: 1 }} />
          </View>
        )}
        <Footnote>{mode === 'regenerate'
          ? 'Nothing in the current chat changes unless you choose “Replace this reply”.'
          : 'The original chat stays unchanged.'}</Footnote>
      </View>
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  body: { gap: t.space.md, paddingBottom: t.space.sm },
  destination: { gap: t.space.md },
  destinationHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  destinationIcon: { width: 22, alignItems: 'center', justifyContent: 'center' },
  destinationTitle: { ...t.type.bodyStrong, color: t.colors.text },
  destinationSub: { ...t.type.caption, color: t.colors.textSecondary, marginTop: 2 },
  label: { ...t.type.label, color: t.colors.textSecondary },
  editField: { minHeight: 120, maxHeight: 220 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hint: { ...t.type.caption, color: t.colors.textSecondary },
  summary: { gap: t.space.xs },
  summaryLine: { ...t.type.callout, color: t.colors.textSecondary },
  model: { ...t.type.caption, color: t.colors.textTertiary, paddingHorizontal: 2 },
  privacy: { ...t.type.caption, color: t.colors.textTertiary, textAlign: 'center' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 2 },
  noteBox: { padding: 12, borderRadius: t.radius.md, backgroundColor: t.colors.surfaceSunken, borderWidth: 1, borderColor: t.colors.border },
  note: { ...t.type.callout, color: t.colors.textSecondary },
  dangerNote: { padding: 12, borderRadius: t.radius.md, backgroundColor: t.colors.dangerSoft },
  dangerText: { ...t.type.callout, color: t.colors.danger },
  errorBox: { gap: 6, padding: 12, borderRadius: t.radius.md, backgroundColor: t.colors.dangerSoft },
  errorTitle: { ...t.type.bodyStrong, color: t.colors.danger },
  errorText: { ...t.type.callout, color: t.colors.text },
  errorActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4 },
  confirmBox: { gap: 8, padding: 12, borderRadius: t.radius.md, borderWidth: 1, borderColor: t.colors.danger },
  confirmTitle: { ...t.type.bodyStrong, color: t.colors.danger },
  confirmText: { ...t.type.callout, color: t.colors.textSecondary },
}));
