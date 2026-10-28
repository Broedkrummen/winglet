import { View } from 'react-native';
import { Sheet } from '../../components/Sheet';
import { Button, Footnote, ListGroup, ListRow, SectionHeader } from '../../components/ui';
import { makeStyles, useTheme } from '../../lib/themeContext';
import { phoneDecide, usePhone } from './runtime';

const fields: Record<string,string> = {
  phone_status:'Battery, network type, sound mode, model and Android version',
  phone_shared_note:'Only your shared note',
  phone_location:'Latitude, longitude and horizontal accuracy',
  phone_contacts:'Up to five names, phone numbers and email addresses',
  phone_calendar:'Up to 50 event titles, times and calendar names',
};

export function PhoneRequestSheet() {
  const t=useTheme(),s=useStyles();
  const item=usePhone(s=>s.requests[0]);
  const decide=(allow:boolean)=>{ if(item) phoneDecide(item.serverId,item.request.id,allow); };
  const r=item?.request;
  return <Sheet visible={!!r} onClose={()=>decide(false)} title="Phone access" scrollable>
    {r ? <View style={s.content}>
      <ListGroup><ListRow title="Waiting for your permission" icon={<View style={s.dot}/>} iconColor={t.colors.warning}/></ListGroup>
      <SectionHeader title="Request"/>
      <ListGroup>
        <ListRow title="Bot" value={r.bot.title}/>
        <ListRow title="Conversation" value={r.chat.title}/>
        <ListRow title="Data requested" subtitle={fields[r.tool]}/>
        {r.tool==='phone_location' ? <ListRow title="Location" value={r.args.precise?'Precise, once':'Approximate (1 km)'}/> : null}
        {r.tool==='phone_contacts' ? <ListRow title="Search" value={String(r.args.query)}/> : null}
        {r.tool==='phone_calendar' ? <ListRow title="Time range" subtitle={`${new Date(Number(r.args.start_ms)).toLocaleString()} – ${new Date(Number(r.args.end_ms)).toLocaleString()}`}/> : null}
      </ListGroup>
      <Footnote>Read once, only while Winglet is open and unlocked. Results stay in this conversation.</Footnote>
      <View style={s.actions}>
        <Button title="Allow once" onPress={()=>decide(true)}/>
        <Button title="Don’t allow" variant="secondary" onPress={()=>decide(false)}/>
      </View>
    </View> : null}
  </Sheet>;
}

const useStyles=makeStyles(t=>({
  content:{paddingBottom:t.space.sm},
  dot:{width:t.space.sm,height:t.space.sm,borderRadius:t.radius.pill,backgroundColor:t.colors.warning},
  actions:{gap:t.space.sm,marginTop:t.space.lg},
}));
