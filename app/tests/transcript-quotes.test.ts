import assert from 'node:assert/strict';
import {test} from 'node:test';
import {anchorValid,canQuote,makeAnchor,occurrences,quoteRef,sourceHash} from '../src/features/transcript-tools/model.ts';
import type {Message} from '../src/lib/types.ts';
const message:Message={id:'reply',chat_id:'chat',role:'bot',status:'final',meta:{},created_at:1,updated_at:1,
  text:'First 🌱 repeat, then repeat.\n```py\nprint("safe")\n```\n|a|b|\n$x^2$ <script>no()</script>'};
test('exact anchors distinguish repeated passages with UTF16 offsets',()=>{
  const at=message.text.lastIndexOf('repeat');
  const quote=makeAnchor(message,at,at+6);
  assert.equal(anchorValid(message,quote),true);
  assert.equal(quote.start,at);
  assert.deepEqual(occurrences(message.text,'repeat'),[9,22]);
  assert.equal(quoteRef(quote).text,'repeat');
  assert.equal(quoteRef(quote).quote?.chat_id,'chat');
});
test('emoji, code, table, math and markup are retained as exact plain data',()=>{
  for(const text of ['🌱','print("safe")','|a|b|','$x^2$','<script>no()</script>']){
    const at=message.text.indexOf(text); const q=makeAnchor(message,at,at+text.length);
    assert.equal(q.text,text);assert.ok(anchorValid(message,q));
  }
});
test('changed, removed, wrong message and streaming sources invalidate an anchor',()=>{
  const q=makeAnchor(message,0,5);
  assert.equal(anchorValid({...message,text:message.text+' changed'},q),false);
  assert.equal(anchorValid(undefined,q),false);
  assert.equal(anchorValid({...message,id:'other'},q),false);
  assert.equal(anchorValid({...message,status:'streaming'},q),false);
});
test('invalid ranges, partial surrogate, blank and oversized selections are rejected',()=>{
  const at=message.text.indexOf('🌱');
  for(const [start,end]of [[-1,2],[0,0],[1.5,3],[0,10000],[at,at+1],[at+1,at+2]]) assert.throws(()=>makeAnchor(message,start,end));
  assert.throws(()=>makeAnchor({...message,text:' '},0,1));
  assert.throws(()=>makeAnchor({...message,text:'x'.repeat(4001)},0,4001));
  assert.deepEqual(occurrences(message.text,''),[]);
});
test('activity and internal controls never offer quoted question actions',()=>{
  assert.equal(canQuote({...message,meta:{activity:true}}),false);
  assert.equal(canQuote({...message,meta:{hidden:true}}),false);
  assert.equal(canQuote({...message,role:'user'}),false);
});
test('source digest uses standard SHA256 UTF8',()=>{
  assert.equal(sourceHash('hello'),'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

