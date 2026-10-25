import { Text, View } from 'react-native';
import { Sheet } from '../../components/Sheet';
import { Button } from '../../components/ui';
import { useTheme } from '../../lib/themeContext';
import { phoneDecide, usePhone } from './runtime';
const fields: Record<string,string> = { phone_status:'Battery, network type, sound mode, model and Android version', phone_shared_note:'Only your shared note', phone_location:'Latitude, longitude and horizontal accuracy', phone_contacts:'Up to five names, phone numbers and email addresses', phone_calendar:'Up to 50 event titles, times and calendar names' };
export function PhoneRequestSheet() {
  const t=useTheme();
  const item=usePhone(s=>s.requests[0]);
  const decide=(allow:boolean)=>{ if(item) phoneDecide(item.serverId,item.request.id,allow); };
  const r=item?.request;
  return <Sheet visible={!!r} onClose={()=>decide(false)} title="Phone access" scrollable>
    {r ? <View style={{gap:16}}>
      <Text style={{...t.type.title,color:t.colors.text}}>{r.bot.title} wants to read your phone</Text>
      <Text style={{...t.type.body,color:t.colors.textSecondary}}>From “{r.chat.title}” · only while Winglet is open and unlocked.</Text>
      <Text style={{...t.type.body,color:t.colors.text}}>{fields[r.tool]}</Text>
      {r.tool==='phone_location' ? <Text style={{color:t.colors.text}}>{r.args.precise ? 'Precise location requested. This decision applies once.' : 'Approximate location only (rounded to about 1 km).'}</Text> : null}
      {r.tool==='phone_contacts' ? <Text style={{color:t.colors.text}}>Search: {String(r.args.query)}</Text> : null}
      {r.tool==='phone_calendar' ? <Text style={{color:t.colors.text}}>{new Date(Number(r.args.start_ms)).toLocaleString()} – {new Date(Number(r.args.end_ms)).toLocaleString()}</Text> : null}
      <Text style={{...t.type.caption,color:t.colors.textSecondary}}>Nothing is read until you allow it. The result becomes part of this agent conversation.</Text>
      <Button title="Allow once" onPress={()=>decide(true)}/>
      <Button title="Don’t allow" variant="secondary" onPress={()=>decide(false)}/>
    </View> : null}
  </Sheet>;
}
