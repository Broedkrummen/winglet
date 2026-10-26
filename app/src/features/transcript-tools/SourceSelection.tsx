import {TextInput} from 'react-native';
export type SourceSelectionProps = {text:string; onSelect:(start:number,end:number)=>void; colors:{text:string;surface:string;border:string}; fontFamily:string};
export function SourceSelection({text,onSelect,colors,fontFamily}:SourceSelectionProps){
  return <TextInput value={text} readOnly multiline showSoftInputOnFocus={false}
    accessibilityLabel="Original reply, select text to quote" textAlignVertical="top"
    style={{height:180,padding:12,borderRadius:16,borderWidth:1,borderColor:colors.border,backgroundColor:colors.surface,color:colors.text,fontFamily,fontSize:15,lineHeight:22}}
    onSelectionChange={event=>onSelect(event.nativeEvent.selection.start,event.nativeEvent.selection.end)} />;
}

