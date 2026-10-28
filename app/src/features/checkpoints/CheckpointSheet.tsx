import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Glass } from '../../components/Glass';
import { CheckCircle2, CircleAlert, FileText, ShieldCheck, TriangleAlert, X } from '../../components/icons';
import { Button, Card, Chip, IconButton, ListGroup, ListRow, SectionHeader, Toggle, Tap } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { useLock } from '../../lib/appLock';
import { haptic } from '../../lib/haptics';
import { useReducedMotion } from '../../lib/motion';
import { makeStyles, useTheme } from '../../lib/themeContext';
import type { Server } from '../../lib/types';
import { previewCheckpoint, restoreCheckpoint } from './api';
import {
  clockTime, dayLabel, diffTone, effectLines, fileMark, operationId, patchLines,
  previewSummary, restoreBlocker, resultGroups, safetyOf, type ResultGroup,
} from './format';
import type { CheckpointFile, CheckpointPreview, CheckpointSummary, RestoreOutcome } from './types';

type Step = 'preview' | 'confirm' | 'running' | 'result';

/**
 * One checkpoint: what changed since it, a bounded diff to read, and a restore that says exactly what it
 * will do. Restoring is a live, signed owner action; its result is shown here, not as a passing toast.
 */
export function CheckpointSheet({ server, checkpoint, visible, online, busy, onClose, onChanged, onOpenCheckpoint }: {
  server: Server;
  /** Null only while the sheet is fading out after closing. */
  checkpoint: CheckpointSummary | null;
  visible: boolean;
  online: boolean;
  busy: string[];
  onClose: () => void;
  /** The list behind the sheet should be read again (a restore added a safety snapshot). */
  onChanged: () => void;
  onOpenCheckpoint: (hash: string) => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const wide = width >= 900;
  const reduced = useReducedMotion();
  const locked = useLock((st) => st.locked);
  // Kept while the modal fades out, so the heading and its content don't vanish mid-close.
  const [shown, setShown] = useState<CheckpointSummary | null>(checkpoint);
  useEffect(() => { if (checkpoint) setShown(checkpoint); }, [checkpoint]);
  const [preview, setPreview] = useState<CheckpointPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [step, setStep] = useState<Step>('preview');
  const [safe, setSafe] = useState(true);
  const [actionError, setActionError] = useState('');
  const [result, setResult] = useState<RestoreOutcome | null>(null);
  const [selected, setSelected] = useState('');
  const [showAll, setShowAll] = useState(false);
  const operation = useRef('');
  const seq = useRef(0);

  const fetchPreview = useCallback(async () => {
    if (!checkpoint) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const next = await previewCheckpoint(server, checkpoint.hash);
      if (mine !== seq.current) return;
      setPreview(next);
      setLoadError('');
      setSelected((current) => next.files.some((f) => f.path === current) ? current : (next.files.find((f) => f.shown)?.path ?? next.files[0]?.path ?? ''));
      setShowAll(false);
    } catch (e) {
      if (mine === seq.current) setLoadError((e as Error).message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [server, checkpoint?.hash]);

  useEffect(() => {
    if (!visible || !checkpoint) return;
    setStep('preview');
    setSafe(true);
    setActionError('');
    setResult(null);
    setPreview(null);
    setLoadError('');
    operation.current = '';
    fetchPreview();
    // A new checkpoint opens fresh; reopening the same one reloads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, checkpoint?.hash]);

  const close = () => {
    if (step === 'running') return; // a restore that started must show how it ended
    haptic.selection();
    onClose();
  };

  const startRestore = async () => {
    if (!preview) return;
    const id = operation.current || operationId();
    operation.current = id;
    setStep('running');
    setActionError('');
    try {
      const outcome = await restoreCheckpoint(server, preview.hash, { revision: preview.revision, safe, operation_id: id });
      setResult(outcome);
      setStep('result');
      haptic[outcome.ok ? 'success' : 'error']();
      onChanged();
    } catch (e) {
      const failure = e as ApiError;
      setStep('confirm');
      setActionError(failure.message || 'The restore failed.');
      // A stale preview or a reply that started meanwhile: read the folder again and show it.
      if (failure.status === 409) {
        operation.current = '';
        fetchPreview();
      } else {
        haptic.error();
      }
    }
  };

  const files = preview?.files ?? [];
  const current = useMemo(() => files.find((f) => f.path === selected) ?? files[0], [files, selected]);
  const blocked = preview ? restoreBlocker(preview, { online, busy: preview.busy?.length ? preview.busy : busy }) : '';
  const panelHeight = wide ? Math.min(height - 56, 840) : Math.max(320, height - insets.top - 8);
  const diffHeight = wide ? Math.min(430, Math.round(panelHeight * 0.52)) : Math.max(120, Math.round(panelHeight * 0.4));
  // Native ScrollView needs a bounded parent height. maxHeight alone lets the
  // flex body collapse, hiding restore details while leaving the action visible.
  const sheetHeight = step === 'preview' ? panelHeight : Math.min(panelHeight, step === 'running' ? 320 : 660);

  if (!shown) return null;

  return (
    <Modal visible={visible && !locked} transparent animationType={reduced ? 'none' : 'fade'} onRequestClose={close}
      statusBarTranslucent navigationBarTranslucent>
      <View style={[s.host, wide && s.hostWide]}>
        <View style={s.backdrop}>
          <Tap feedback="none" accessible={false} onPress={close} style={StyleSheet.absoluteFill} />
        </View>
        <View style={[s.panel, wide ? s.panelWide : s.panelPhone,
          { height: sheetHeight }]} accessibilityViewIsModal>
          <Glass style={[s.glass, wide && { borderRadius: t.radius.xl },
            { flex: 1, paddingBottom: wide ? 16 : insets.bottom + 12 }]}>
            <View style={s.heading}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.headingTitle} accessibilityRole="header" numberOfLines={2}>
                  {step === 'confirm' ? 'Restore checkpoint' : step === 'result' ? (result?.ok ? 'Restored' : "Couldn't restore") : shown.label}
                </Text>
                <Text style={s.headingMeta} numberOfLines={1}>
                  {[dayLabel(shown.at), clockTime(shown.at), shown.short].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <IconButton label="Close checkpoint" onPress={close} size={38}><X size={20} color={t.colors.textSecondary} /></IconButton>
            </View>

            {step === 'running' ? (
              <View style={s.running} accessibilityLiveRegion="polite">
                <ActivityIndicator color={t.colors.accent} />
                <Text style={s.runningTitle}>Restoring the folder…</Text>
                <Text style={s.runningBody}>
                  Saving a safety snapshot, then restoring files.
                </Text>
              </View>
            ) : step === 'result' && result ? (
              <ScrollView style={{ flex: 1 }} contentContainerStyle={s.scrollBody} showsVerticalScrollIndicator={false}>
                <ResultBody result={result} onUndo={(hash) => onOpenCheckpoint(hash)} />
              </ScrollView>
            ) : step === 'confirm' && preview ? (
              <ScrollView style={{ flex: 1 }} contentContainerStyle={s.scrollBody} showsVerticalScrollIndicator={false}>
                <ConfirmBody preview={preview} safe={safe} onSafe={setSafe} error={actionError} />
                {actionError ? (
                  <Button title="Look again" variant="secondary" size="sm" style={{ alignSelf: 'flex-start' }}
                    onPress={() => { setActionError(''); fetchPreview(); }} />
                ) : null}
              </ScrollView>
            ) : loading ? (
              <View style={s.center}>
                <ActivityIndicator color={t.colors.accent} />
                <Text style={s.centerText}>Reading what changed…</Text>
              </View>
            ) : loadError ? (
              <View style={s.center}>
                <CircleAlert size={22} color={t.colors.danger} />
                <Text style={s.centerText}>{loadError}</Text>
                <Button title="Try again" variant="secondary" size="sm" onPress={fetchPreview} />
              </View>
            ) : preview ? (
              <PreviewBody preview={preview} current={current} selected={selected} onSelect={(path) => { setSelected(path); setShowAll(false); }}
                wide={wide} diffHeight={diffHeight} fill={!wide} showAll={showAll} onShowAll={() => setShowAll(true)} />
            ) : null}

            <View style={s.footer}>
              {step === 'preview' ? (
                <>
                  <Button title="Done" variant="secondary" onPress={close} style={{ flex: 1 }} />
                  {preview && !blocked ? (
                    <Button title={preview.unchanged ? 'Nothing to restore' : 'Restore this point'} variant="danger" style={{ flex: 1.4 }}
                      disabled={preview.unchanged || !preview.can_restore} onPress={() => { haptic.light(); setStep('confirm'); }} />
                  ) : null}
                </>
              ) : step === 'confirm' ? (
                <>
                  <Button title="Cancel" variant="secondary" onPress={() => { setActionError(''); setStep('preview'); }} style={{ flex: 1 }} />
                  <Button title="Restore" variant="danger" style={{ flex: 1.4 }} onPress={startRestore} />
                </>
              ) : step === 'running' ? null : (
                <Button title="Done" style={{ flex: 1 }} onPress={close} />
              )}
            </View>
            {step === 'preview' && blocked && !preview?.error && !preview?.unchanged
              ? <Text style={s.blocked} accessibilityLiveRegion="polite">{blocked}</Text> : null}
          </Glass>
        </View>
      </View>
    </Modal>
  );
}

/** The preview: what changed, which file, and a bounded diff. */
function PreviewBody({ preview, current, selected, onSelect, wide, diffHeight, fill, showAll, onShowAll }: {
  preview: CheckpointPreview; current?: CheckpointFile; selected: string; onSelect: (path: string) => void;
  wide: boolean; diffHeight: number; fill: boolean; showAll: boolean; onShowAll: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const summary = previewSummary(preview);
  if (preview.error) {
    return <View style={s.center}><CircleAlert size={22} color={t.colors.danger} /><Text style={s.centerText}>{preview.error}</Text></View>;
  }
  if (preview.unchanged) {
    return (
      <View style={s.center}>
        <CheckCircle2 size={26} color={t.colors.success} />
        <Text style={s.centerTitle}>Nothing has changed</Text>
        <Text style={s.centerText}>The folder matches this snapshot.</Text>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, minHeight: 0, paddingTop: 10 }}>
      <View style={s.coverage}>
        <ShieldCheck size={15} color={t.colors.textSecondary} />
        <Text style={s.coverageText} numberOfLines={2}>
          Files only; conversations stay unchanged.
        </Text>
      </View>
      <View style={s.summaryRow}>
        <Text style={s.summary}>{summary || 'Changed files'}</Text>
        <Text style={s.summaryHash}>{preview.workspace.path || preview.workspace.name}</Text>
      </View>
      <View style={{ flex: 1, minHeight: 0, flexDirection: wide ? 'row' : 'column', gap: 10, marginTop: 8 }}>
        {wide ? (
          <ScrollView style={s.fileColumn} contentContainerStyle={{ gap: 4, paddingBottom: 6 }} showsVerticalScrollIndicator={false}>
            {preview.files.map((file) => (
              <FileRow key={file.path} file={file} selected={file.path === selected} onPress={() => onSelect(file.path)} />
            ))}
          </ScrollView>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={s.chips}>
            {preview.files.map((file) => (
              <FileChip key={file.path} file={file} selected={file.path === selected} onPress={() => onSelect(file.path)} />
            ))}
          </ScrollView>
        )}
        <DiffPane preview={preview} file={current} height={diffHeight} fill={fill} showAll={showAll} onShowAll={onShowAll} />
      </View>
      {preview.diff.truncated ? (
        <Text style={s.note}>
          Previewing {preview.shown_files} of {preview.files.length} files. All counts are listed.
        </Text>
      ) : null}
    </View>
  );
}

function FileChip({ file, selected, onPress }: { file: CheckpointFile; selected: boolean; onPress: () => void }) {
  const t = useTheme();
  const s = useStyles();
  return <Chip label={file.path} selected={selected} onPress={onPress}
    icon={<Text style={[s.mark, {color:markColor(t,file)}]}>{fileMark(file)}</Text>}
    accessibilityLabel={`${file.path}, ${file.status}, ${file.insertions} added, ${file.deletions} removed`} />;

}

function FileRow({ file, selected, onPress }: { file: CheckpointFile; selected: boolean; onPress: () => void }) {
  const t = useTheme();
  const s = useStyles();
  return (
    <Tap feedback="selection" onPress={onPress} accessibilityRole="button" accessibilityState={{ selected }}
      accessibilityLabel={`${file.path}, ${file.status}, ${file.insertions} added, ${file.deletions} removed`}
      style={[s.fileRow, selected && { backgroundColor: t.colors.accentSoft }]}>
      <Text style={[s.mark, { color: markColor(t, file) }]}>{fileMark(file)}</Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[s.filePath, selected && { color: t.colors.onAccentSoft }]} numberOfLines={2}>{file.path}</Text>
        <Text style={s.fileMeta}>{file.binary ? 'binary' : `+${file.insertions} −${file.deletions}`}</Text>
      </View>
      {file.shown ? null : <TriangleAlert size={13} color={t.colors.warning} />}
    </Tap>
  );
}

function DiffPane({ preview, file, height, fill, showAll, onShowAll }: {
  preview: CheckpointPreview; file?: CheckpointFile; height: number; fill: boolean; showAll: boolean; onShowAll: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const [box, setBox] = useState(height);
  const lines = useMemo(() => patchLines(preview, file), [preview, file]);
  const limit = showAll ? lines.length : Math.min(lines.length, 260);
  if (!file) return <View style={[s.diffEmpty, { minHeight: height }]}><Text style={s.centerText}>No files to show.</Text></View>;
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 6 }}>
      <View style={s.diffHead}>
        <Text style={s.diffPath} numberOfLines={1}>{file.status === 'renamed' && file.from ? `${file.from} → ${file.path}` : file.path}</Text>
        <Text style={s.diffCounts}>{file.binary ? 'binary' : `+${file.insertions} −${file.deletions}`}</Text>
      </View>
      <View style={[s.diffBox, fill ? { flex: 1, minHeight: height } : { height }]}
        onLayout={(e) => { const next = Math.round(e.nativeEvent.layout.height); if (next > 0 && next !== box) setBox(next); }}>
        {file.binary ? (
          <View style={s.center}>
            <FileText size={22} color={t.colors.textTertiary} />
            <Text style={s.centerText}>Binary file; contents are not previewed.</Text>
          </View>
        ) : !file.shown ? (
          <View style={s.center}>
            <TriangleAlert size={20} color={t.colors.warning} />
            <Text style={s.centerText}>Change too large to preview; counts are still available.</Text>
          </View>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator style={{ flex: 1 }} contentContainerStyle={{ minWidth: '100%' }}>
            <ScrollView style={{ height: box }} contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 10 }} showsVerticalScrollIndicator>
              {lines.slice(0, limit).map((line, index) => (
                <Text key={index} selectable style={[s.diffLine, { color: toneColor(t, diffTone(line)) }]}>{line || ' '}</Text>
              ))}
              {limit < lines.length ? (
                <Button title={`Show ${lines.length - limit} more lines`} variant="ghost" onPress={onShowAll}
                  accessibilityLabel={`Show the other ${lines.length - limit} lines`} />
              ) : null}
            </ScrollView>
          </ScrollView>
        )}
      </View>
      {preview.diff.truncated && file.shown ? null : null}
    </View>
  );
}

function ConfirmBody({ preview, safe, onSafe, error }: {
  preview: CheckpointPreview; safe: boolean; onSafe: (value: boolean) => void; error: string;
}) {
  const t = useTheme();
  const s = useStyles();
  const lines = effectLines(preview.effects, safe);
  return (
    <View style={{ gap: 14, paddingTop: 4 }}>
      <Card style={s.scopeCard}>
        <Text style={s.scopeLabel}>Folder</Text>
        <Text style={s.scopePath} numberOfLines={2}>{preview.workspace.path || preview.workspace.name}</Text>
        <Text style={s.scopeNote}>Every chat with this bot shares this folder.</Text>
      </Card>
      <View style={{ gap: 6 }}>
        <SectionHeader title="What happens" />
        {lines.map((line) => (
          <View key={line} style={s.bullet}>
            <View style={[s.bulletDot, { backgroundColor: t.colors.accent }]} />
            <Text style={s.bulletText}>{line}</Text>
          </View>
        ))}
      </View>
      <ListGroup><ListRow title="Also revert files I edited myself"
        subtitle={safe?'Your later edits are kept.':'Your later edits are overwritten; recover them from the safety snapshot.'}
        right={<Toggle label="Also revert files I edited myself" value={!safe} onValueChange={(value) => onSafe(!value)} />} /></ListGroup>
      <View style={s.assurance}>
        <ShieldCheck size={16} color={t.colors.success} />
        <Text style={s.assuranceText}>
          Undo from the safety snapshot. Chats, memory and skills stay unchanged.
        </Text>
      </View>
      {error ? <Text style={s.error} accessibilityLiveRegion="assertive">{error}</Text> : null}
    </View>
  );
}

function ResultBody({ result, onUndo }: { result: RestoreOutcome; onUndo: (hash: string) => void }) {
  const t = useTheme();
  const s = useStyles();
  const groups = resultGroups(result);
  const safety = safetyOf(result);
  return (
    <View style={{ gap: 14, paddingTop: 6 }}>
      <View style={s.resultHead}>
        {result.ok ? <CheckCircle2 size={30} color={t.colors.success} /> : <CircleAlert size={28} color={t.colors.danger} />}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.resultTitle}>{result.ok ? 'The folder was put back' : 'The restore did not finish'}</Text>
          <Text style={s.resultMessage}>{result.message}</Text>
        </View>
      </View>
      {groups.map((group) => <ResultList key={group.key} group={group} />)}
      {result.reported === false && result.ok ? (
        <Text style={s.note}>Hermes restored the whole folder and did not report which files changed.</Text>
      ) : null}
      {!result.ok ? (
        <View style={s.recovery}>
          <TriangleAlert size={16} color={t.colors.warning} />
          <Text style={s.recoveryText}>
            Some files may already have changed. {safety
              ? `Open the safety snapshot ${safety.short} at the top of the list to see the folder as it is now, or to put it back.`
              : 'Check the folder on the server before trying again.'}
          </Text>
        </View>
      ) : null}
      {safety ? (
        <ListGroup><ListRow icon={<ShieldCheck />} title="Undo this restore" value={safety.short}
          onPress={() => onUndo(safety.hash)} /></ListGroup>
      ) : null}
    </View>
  );
}

function ResultList({ group }: { group: ResultGroup }) {
  const t = useTheme();
  const s = useStyles();
  const [all, setAll] = useState(false);
  const shown = all ? group.files : group.files.slice(0, 5);
  return (
    <View style={{ gap: 4 }}>
      <SectionHeader title={group.title} right={<Text style={s.note}>{group.files.length}</Text>} />
      {shown.map((file) => (
        <Text key={file} style={s.resultFile} numberOfLines={2}>{file}</Text>
      ))}
      {group.files.length > shown.length ? (
        <Button title={`Show ${group.files.length - shown.length} more files`} variant="ghost" onPress={() => setAll(true)} />
      ) : null}
    </View>
  );
}

function markColor(t: ReturnType<typeof useTheme>, file: CheckpointFile): string {
  if (file.status === 'added') return t.colors.success;
  if (file.status === 'deleted') return t.colors.danger;
  if (file.status === 'renamed') return t.colors.warning;
  return t.colors.textSecondary;
}

function toneColor(t: ReturnType<typeof useTheme>, tone: ReturnType<typeof diffTone>): string {
  if (tone === 'added') return t.colors.success;
  if (tone === 'removed') return t.colors.danger;
  if (tone === 'hunk') return t.colors.accent;
  if (tone === 'meta') return t.colors.textTertiary;
  return t.colors.textSecondary;
}

const useStyles = makeStyles((t) => ({
  host: { flex: 1, justifyContent: 'flex-end' },
  hostWide: { justifyContent: 'center', alignItems: 'center', padding: 24 },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: t.colors.overlay },
  panel: { width: '100%', maxHeight: '100%' },
  panelPhone: { paddingBottom: 0 },
  panelWide: { maxWidth: 820, paddingHorizontal: 12 },
  glass: {
    borderTopLeftRadius: t.radius.xl, borderTopRightRadius: t.radius.xl, paddingHorizontal: t.space.lg, paddingTop: t.space.md,
    overflow: 'hidden',
  },
  heading: { flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingLeft: t.space.xs, paddingBottom: t.space.sm },
  headingTitle: { ...t.type.heading, color: t.colors.text },
  headingMeta: { ...t.type.caption, color: t.colors.textTertiary, marginTop: 4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 24, minHeight: 160 },
  centerTitle: { ...t.type.heading, color: t.colors.text, textAlign: 'center' },
  centerText: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center', maxWidth: 420 },
  scrollBody: { paddingBottom: 10, gap: 14 },
  coverage: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: t.radius.sm, backgroundColor: t.colors.surfaceSunken,
  },
  coverageText: { ...t.type.footnote, color: t.colors.textSecondary, flex: 1 },
  summaryRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginTop: 10 },
  summary: { ...t.type.caption, fontFamily: t.fonts.semibold, color: t.colors.text },
  summaryHash: { ...t.type.caption, fontFamily: t.fonts.mono, color: t.colors.textTertiary, flexShrink: 1, textAlign: 'right' },
  chips: { gap: 8, paddingVertical: 2, paddingHorizontal: 2 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 38, paddingHorizontal: 12, borderRadius: t.radius.pill,
    borderWidth: 1, borderColor: t.colors.border, backgroundColor: t.colors.surface, maxWidth: 230,
  },
  chipText: { ...t.type.caption, color: t.colors.text, flexShrink: 1 },
  mark: { ...t.type.caption },
  fileColumn: { width: 232, flexGrow: 0 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 7, borderRadius: t.radius.sm, minHeight: 42 },
  filePath: { ...t.type.caption, fontFamily: t.fonts.mono, color: t.colors.text },
  fileMeta: { ...t.type.caption, color: t.colors.textTertiary, marginTop: 2 },
  diffHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  diffPath: { ...t.type.caption, fontFamily: t.fonts.mono, color: t.colors.textSecondary, flex: 1 },
  diffCounts: { ...t.type.caption, fontFamily: t.fonts.mono, color: t.colors.textTertiary },
  diffBox: {
    borderRadius: t.radius.md, backgroundColor: t.colors.codeBg, borderWidth: 1, borderColor: t.colors.border, overflow: 'hidden',
  },
  diffEmpty: { borderRadius: t.radius.md, backgroundColor: t.colors.codeBg, alignItems: 'center', justifyContent: 'center' },
  diffLine: { ...t.type.footnote, fontFamily: t.fonts.mono },
  moreLines: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 40, paddingHorizontal: 8 },
  moreText: { ...t.type.caption, color: t.colors.accent, fontFamily: t.fonts.semibold },
  note: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textTertiary, lineHeight: 17, marginTop: 6 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 10 },
  blocked: { ...t.type.caption, color: t.colors.textTertiary, textAlign: 'center', marginTop: 8, lineHeight: 16 },
  running: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 24, minHeight: 220 },
  runningTitle: { ...t.type.heading, color: t.colors.text },
  runningBody: { ...t.type.callout, color: t.colors.textSecondary, textAlign: 'center', maxWidth: 420 },
  scopeCard: { gap: 4 },
  scopeLabel: { ...t.type.label, color: t.colors.textSecondary },
  scopePath: { ...t.type.caption, fontFamily: t.fonts.mono, color: t.colors.text },
  scopeNote: { ...t.type.caption, color: t.colors.textTertiary, marginTop: 2 },
  sectionLabel: { ...t.type.label, color: t.colors.textSecondary },
  bullet: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  bulletDot: { width: 5, height: 5, borderRadius: 3, marginTop: 7 },
  bulletText: { ...t.type.callout, color: t.colors.text, flex: 1, lineHeight: 21 },
  safeRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: t.radius.md,
    backgroundColor: t.colors.surfaceSunken,
  },
  safeTitle: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.text },
  safeBody: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textSecondary, lineHeight: 17 },
  assurance: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, paddingHorizontal: 2 },
  assuranceText: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.textSecondary, flex: 1, lineHeight: 18 },
  error: { ...t.type.callout, color: t.colors.danger },
  resultHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  resultTitle: { ...t.type.heading, color: t.colors.text },
  resultMessage: { ...t.type.callout, color: t.colors.textSecondary, marginTop: 4, lineHeight: 21 },
  resultFile: { ...t.type.caption, fontFamily: t.fonts.mono, color: t.colors.text, lineHeight: 18 },
  recovery: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, padding: 12, borderRadius: t.radius.md, backgroundColor: t.colors.warningSoft },
  recoveryText: { ...t.type.caption, fontFamily: t.fonts.regular, color: t.colors.text, flex: 1, lineHeight: 18 },
  undoRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: t.radius.md,
    backgroundColor: t.colors.accentSoft, minHeight: 52,
  },
  undoTitle: { ...t.type.callout, fontFamily: t.fonts.semibold, color: t.colors.onAccentSoft },
  undoBody: { ...t.type.caption, color: t.colors.onAccentSoft, marginTop: 2 },
}));
