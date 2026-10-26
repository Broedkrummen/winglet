import assert from 'node:assert/strict';
import {test} from 'node:test';
import {draftKey, keepDraft, savedDraft, matchingFields, parseConfigValue, type ConfigField} from '../src/features/advanced-config/model.ts';
const field: ConfigField = {key:'agent.max_turns', label:'Maximum agent turns', section:'Execution', type:'integer',
  description:'Iterations per turn', value:30, default:90, source:'override', writable:true, minimum:1, maximum:1000, applies:'next_turn'};
test('configuration drafts stay isolated by server and bot and can be discarded', () => {
  const a=draftKey('a','one'), b=draftKey('a','two'), c=draftKey('b','one');
  const changes={'agent.max_turns':40};
  keepDraft(a,{catalog:{revision:'rev',fields:[field],applies:'next_turn'},changes});
  changes['agent.max_turns']=50;
  assert.equal(savedDraft(a)?.changes['agent.max_turns'],40);
  assert.equal(savedDraft(b),undefined); assert.equal(savedDraft(c),undefined);
  keepDraft(a); assert.equal(savedDraft(a),undefined);
});
test('numeric drafts reject blanks, invalid and non-finite values and fractions for integer fields', () => {
  for(const value of ['', ' ', 'no', 'Infinity','NaN','0','1001','1.5']) assert.throws(()=>parseConfigValue(field,value));
  assert.equal(parseConfigValue(field,'35'),35);
  assert.equal(parseConfigValue({...field,type:'number',minimum:.1,maximum:1},'.75'),.75);
});
test('search finds human labels and descriptions across sections', () => {
  assert.equal(matchingFields([field],'execution turns').length,1);
  assert.equal(matchingFields([field],'iterations').length,1);
  assert.equal(matchingFields([field],'credentials').length,0);
});

