import {useEffect,useRef} from 'react';
import {useTheme} from '../../lib/themeContext';
import type {SourceSelectionProps} from './SourceSelection';
/** Keep DOM selection local to this source; RN Web's read-only selection events vary by browser. */
export function SourceSelection({text,onSelect,colors,fontFamily}:SourceSelectionProps){
  const t=useTheme();
  const ref=useRef<HTMLTextAreaElement>(null);
  const callback=useRef(onSelect);
  callback.current=onSelect;
  useEffect(()=>{
    const node=ref.current;if(!node)return;
    const selected=()=>{if(document.activeElement===node)callback.current(node.selectionStart,node.selectionEnd);};
    node.addEventListener('select',selected);
    node.addEventListener('keyup',selected);
    node.addEventListener('mouseup',selected);
    document.addEventListener('selectionchange',selected);
    return ()=>{
      node.removeEventListener('select',selected);
      node.removeEventListener('keyup',selected);
      node.removeEventListener('mouseup',selected);
      document.removeEventListener('selectionchange',selected);
    };
  },[]);
  return <textarea ref={ref} value={text} readOnly aria-label="Original reply, select text to quote"
    style={{height:180,width:'100%',boxSizing:'border-box',padding:t.space.md,borderRadius:t.radius.md,border:'1px solid '+colors.border,
      background:colors.surface,color:colors.text,fontFamily:fontFamily+', system-ui, sans-serif',fontSize:t.type.callout.fontSize,lineHeight:`${t.type.callout.lineHeight}px`,resize:'vertical',
      userSelect:'text',WebkitUserSelect:'text',outlineOffset:2}} />;
}

