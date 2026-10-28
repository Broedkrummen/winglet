import { useState } from 'react';
import { Platform, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { JobSheet } from '../../components/JobSheet';
import { Markdown } from '../../components/Markdown';
import { Sheet } from '../../components/Sheet';
import { Button, Field, Footnote, ListGroup, ListRow, Segmented, Toggle } from '../../components/ui';
import { signedApi } from '../../lib/api';
import { idempotencyKey } from '../../lib/control';
import { makeStyles } from '../../lib/themeContext';
import type { Job, Server } from '../../lib/types';

const TEMPLATE = `import json

def echo(args, **kwargs):
    return json.dumps({"text": args.get("text", "")})

def register(ctx):
    ctx.register_tool(
        name="custom_echo", toolset="custom_echo",
        schema={"name": "custom_echo", "description": "Echo text",
                "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
        handler=echo)
`;
type Preview = { token: string; profile: string; kind: string; preview: Record<string, unknown> };

export function CustomAbility({ server, type, onDone }: { server: Server; type: 'skill' | 'tool'; onDone: () => void }) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<'repository' | 'file'>('repository');
  const [identifier, setIdentifier] = useState('');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dependencies, setDependencies] = useState(false);
  const [enable, setEnable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const edit = () => { setPreview(null); setError(''); setDependencies(false); setEnable(false); };
  const review = async () => {
    setBusy(true); setError('');
    try {
      setPreview(await signedApi<Preview>(server, 'POST', '/api/abilities/preview', {
        kind: type === 'skill' ? source === 'file' ? 'skill_create' : 'skill_install' : source === 'file' ? 'tool_python' : 'tool_repository',
        identifier, name, content,
      }, 120000));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const install = async () => {
    if (!preview) return;
    setBusy(true); setError('');
    try {
      const result = await signedApi<{job: Job}>(server, 'POST', '/api/abilities/add', {
        token: preview.token, consent: true, dependencies, enable, idempotency_key: idempotencyKey(),
      });
      setJob(result.job); setOpen(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const upload = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({type: '*/*', copyToCacheDirectory: true});
      if (result.canceled) return;
      const file = result.assets[0];
      if (!file.name.endsWith('.py') || (file.size ?? 0) > 100000) throw new Error('Choose a .py file up to 100 KB.');
      const text = Platform.OS === 'web' ? await (await fetch(file.uri)).text() : await FileSystem.readAsStringAsync(file.uri);
      if (new TextEncoder().encode(text).length > 100000) throw new Error('Choose a .py file up to 100 KB.');
      edit(); setName(file.name.replace(/\.py$/, '').toLowerCase()); setContent(text);
    } catch (e) { setError((e as Error).message); }
  };
  return <>
    <Button title={type === 'skill' ? 'Add Skills' : 'Add Tool'} variant="secondary" disabled={job?.state === 'running'} onPress={() => setOpen(true)} />
    <Sheet title={type === 'skill' ? 'Add Skills' : 'Add Tool'} visible={open} onClose={() => !busy && setOpen(false)} scrollable>
      <View style={s.form}>
        <Footnote>For {server.bot.title}. You review the source before installing.</Footnote>
        {!preview ? <>
        <Segmented label="Source" value={source} onChange={v => { if (!busy) {setSource(v); edit();} }} options={[
          {value: 'repository', label: type === 'skill' ? 'Repository / identifier' : 'Plugin repository'},
          {value: 'file', label: type === 'skill' ? 'Create skill' : 'Python file'},
        ]} />
        {source === 'repository' ? <Field label={type === 'skill' ? 'Skill identifier or URL' : 'Plugin repository'} value={identifier} editable={!busy} autoCapitalize="none"
          onChangeText={v => {setIdentifier(v); edit();}} placeholder={type === 'skill' ? 'https://github.com/owner/repository/tree/main/skill' : 'owner/repository'} /> : <>
          <Field label="Name" value={name} editable={!busy} autoCapitalize="none" onChangeText={v => {setName(v); edit();}} />
          {type === 'tool' ? <View style={s.actions}>
            <Button title="Upload Python file" variant="secondary" onPress={upload} disabled={busy} />
            <Button title="Use tool template" disabled={busy} variant="ghost" onPress={() => {edit(); setName('custom-echo'); setContent(TEMPLATE);}} />
          </View> : null}
          <Field label={type === 'skill' ? 'SKILL.md' : 'Python module'} value={content} editable={!busy} multiline autoCapitalize="none" autoCorrect={false}
            style={{minHeight: 180, textAlignVertical: 'top'}} onChangeText={v => {setContent(v); edit();}} />
          {type === 'tool' ? <Footnote>Single-file tools use register(ctx) and ctx.register_tool with a literal name, toolset, schema and handler. Use a plugin repository for multiple files or dependencies.</Footnote> :
            <Footnote>Include SKILL.md frontmatter with name and description, followed by the skill instructions.</Footnote>}
        </>}
        </> : null}
        {preview ? <>
          <Footnote>Profile: {preview.profile}. Review expires after 15 minutes.</Footnote>
          <AbilityPreview data={preview.preview} />
          <Button title="Edit addition" variant="secondary" disabled={busy} onPress={edit} />
          {type === 'tool' ? <ListGroup>
            {source === 'repository' ? <ListRow title="Allow declared Python dependencies" subtitle="Packages share your Hermes environment"
              right={<Toggle label="Allow declared Python dependencies" value={dependencies} onValueChange={setDependencies} />} /> : null}
            <ListRow title="Enable after installation" subtitle="Runs this plugin’s code on your Hermes server"
              right={<Toggle label="Enable after installation" value={enable} onValueChange={setEnable} />} />
          </ListGroup> : null}
          {preview.preview.node_dependencies ? <Footnote>Node sidecar dependencies need installation in Hermes on the server; this flow does not install them automatically.</Footnote> : null}
          <Button title="Confirm installation" loading={busy} disabled={busy} onPress={install} />
        </> : <Button title="Review addition" loading={busy} disabled={busy || (source === 'repository' ? !identifier.trim() : !name.trim() || !content.trim())} onPress={review} />}
        {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      </View>
    </Sheet>
    <JobSheet server={server} job={job} onClose={() => setJob(null)} onDone={finished => {
      setJob(finished);
      onDone(); if (finished.state === 'succeeded') {setContent(''); setIdentifier(''); setName(''); setPreview(null);}
      else setPreview(null);
    }} />
  </>;
}

function AbilityPreview({data}: {data: Record<string, unknown>}) {
  const s = useStyles();
  const skill = data.skill as {skill_md?: string; files?: string[]; name?: string} | undefined;
  const manifest = data.manifest as {name?: string; provides_tools?: string[]} | undefined;
  const instructions = typeof data.instructions === 'string' ? data.instructions : skill?.skill_md;
  const header = instructions?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/);
  const name = data.name ?? manifest?.name ?? skill?.name;
  const details = [
    ['Name', name], ['Source', data.source], ['Commit', data.revision], ['Description', data.description],
    ['Tools', (data.tools as string[] | undefined)?.join(', ') ?? manifest?.provides_tools?.join(', ')],
    ['Python dependencies', (data.dependencies as string[] | undefined)?.join(', ')],
  ].filter(([, value]) => typeof value === 'string' && value);
  return <View style={{gap: 12}}>
    {details.map(([label, value]) => <View key={String(label)}><Footnote>{String(label)}</Footnote><Text selectable style={s.text}>{String(value)}</Text></View>)}
    {header ? <View><Footnote>Skill metadata</Footnote><Text selectable style={s.text}>{header[1]}</Text></View> : null}
    {instructions ? <Markdown text={header ? instructions.slice(header[0].length) : instructions} /> : null}
    {skill?.files ? <Footnote>Files: {skill.files.join(', ')}</Footnote> : null}
    {typeof data.code === 'string' ? <Text selectable style={s.code}>{data.code}</Text> : null}
    {data.scan ? <View><Footnote>Hermes security scan</Footnote><Text selectable style={s.text}>{JSON.stringify(data.scan, null, 2)}</Text></View> : null}
  </View>;
}

const useStyles = makeStyles(t => ({
  form: {gap: t.space.md}, actions: {flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm},
  text: {...t.type.callout, color: t.colors.text}, error: {...t.type.callout, color: t.colors.danger},
  code: {...t.type.footnote, fontFamily: t.fonts.mono, color: t.colors.text},
}));
