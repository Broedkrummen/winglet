import { useState } from 'react';
import { Text, View } from 'react-native';
import { Sheet } from '../../components/Sheet';
import { Button, Field, Footnote, Segmented } from '../../components/ui';
import { signedApi, serverKey } from '../../lib/api';
import { seal } from '../../lib/crypto';
import { makeStyles } from '../../lib/themeContext';
import type { Server } from '../../lib/types';

export function CustomMcp({server, onDone}: {server: Server; onDone: () => void}) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'url' | 'command'>('url');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [auth, setAuth] = useState<'none' | 'oauth' | 'header'>('none');
  const [token, setToken] = useState('');
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const add = async () => {
    setBusy(true); setError('');
    try {
      const values: Record<string, string> = Object.create(null);
      for (const line of env.split('\n').filter(v => v.trim())) {
        const i = line.indexOf('=');
        if (i < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, i))) throw new Error('Environment entries must be KEY=value, one per line.');
        values[line.slice(0, i)] = line.slice(i + 1);
      }
      const config = mode === 'url' ? {name: name.trim(), url: address.trim(), auth, ...(auth === 'header' ? {bearer_token: token} : {})} :
        {name: name.trim(), command: address.trim(), args: args.split('\n').filter(v => v.length), env: values};
      const key = await serverKey(server.url, server.fingerprint);
      if (!key) throw new Error('Update Winglet on the server before adding credentials.');
      await signedApi(server, 'POST', '/api/mcp/custom', {sealed: seal(key, 'mcp-custom', server.deviceId, config)});
      setToken(''); setEnv(''); setName(''); setAddress(''); setArgs(''); setReview(false); setOpen(false); onDone();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <>
    <Button title="Add MCP" variant="secondary" onPress={() => setOpen(true)} />
    <Sheet visible={open} title="Add MCP" onClose={() => !busy && setOpen(false)} scrollable>
      <View style={s.form}>
        <Footnote>For {server.bot.title}. Add a custom server, then test and reconnect from its server row.</Footnote>
        <Segmented label="Connection" value={mode} onChange={v => {if (!busy) {setMode(v); setAddress(''); setReview(false);}}}
          options={[{value: 'url', label: 'Remote URL'}, {value: 'command', label: 'Local command'}]} />
        <Field label="Server name" value={name} editable={!busy} autoCapitalize="none" onChangeText={v => {setName(v); setReview(false);}} />
        <Field label={mode === 'url' ? 'Server URL' : 'Executable'} value={address} editable={!busy} autoCapitalize="none" autoCorrect={false} onChangeText={v => {setAddress(v); setReview(false);}} />
        {mode === 'url' ? <>
          <Segmented label="Authentication" value={auth} onChange={v => {if (!busy) {setAuth(v); setReview(false);}}}
            options={[{value: 'none', label: 'None'}, {value: 'oauth', label: 'Sign in'}, {value: 'header', label: 'Bearer token'}]} />
          {auth === 'header' ? <Field label="Bearer token" value={token} editable={!busy} secureTextEntry autoCapitalize="none" autoCorrect={false} onChangeText={v => {setToken(v); setReview(false);}} /> : null}
        </> : <>
          <Field label="Arguments — one per line" value={args} editable={!busy} multiline autoCapitalize="none" autoCorrect={false} onChangeText={v => {setArgs(v); setReview(false);}} />
          <Field label="Environment — KEY=value, one per line" value={env} editable={!busy} multiline autoCapitalize="none" autoCorrect={false} onChangeText={v => {setEnv(v); setReview(false);}} />
          <Footnote>Environment values are sealed to your server and are never included in the review summary.</Footnote>
        </>}
        {review ? <>
          <Text selectable style={s.text}>{mode === 'url' ? 'Connects to' : 'Runs on your Hermes server'}: {address}{mode === 'command' ? '\n' + args : ''}</Text>
          <Button title="Confirm Add MCP" loading={busy} disabled={busy} onPress={add} />
        </> : <Button title="Review connection" disabled={!name.trim() || !address.trim()} onPress={() => {setReview(true); setError('');}} />}
        {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      </View>
    </Sheet>
  </>;
}
const useStyles = makeStyles(t => ({form: {gap: t.space.md}, text: {...t.type.callout, color: t.colors.text}, error: {...t.type.callout, color: t.colors.danger}}));
