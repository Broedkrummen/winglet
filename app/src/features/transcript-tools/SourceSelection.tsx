import {TextInput} from 'react-native';
import {useTheme} from '../../lib/themeContext';
export type SourceSelectionProps = {text:string; onSelect:(start:number,end:number)=>void; colors:{text:string;surface:string;border:string}; fontFamily:string};
export function SourceSelection({text,onSelect,colors,fontFamily}:SourceSelectionProps){
  const t=useTheme();
  return <TextInput value={text} readOnly multiline showSoftInputOnFocus={false}
    accessibilityLabel="Original reply, select text to quote" textAlignVertical="top"
    style={{height:180,padding:t.space.md,borderRadius:t.radius.md,borderWidth:1,borderColor:colors.border,backgroundColor:colors.surface,color:colors.text,...t.type.callout,fontFamily}}
    onSelectionChange={event=>onSelect(event.nativeEvent.selection.start,event.nativeEvent.selection.end)} />;
}

