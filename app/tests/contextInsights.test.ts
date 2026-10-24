import test from 'node:test';
import assert from 'node:assert/strict';
import { composition, contextPercent, costLabel, sourceLabel, tokenCount, type ContextAmount } from '../src/features/context-insights/model.ts';
const context=(used:unknown,window:unknown)=>({used,window} as ContextAmount);
test('unknown windows never produce invented occupancy percentages',()=>{for(const value of [null,0,NaN,Infinity,-1])assert.equal(contextPercent(context(100,value)),null);assert.equal(contextPercent(context(100,200)),50);assert.equal(contextPercent(context(300,200)),100);assert.equal(contextPercent(context(0,200)),0);});
test('nonfinite and missing telemetry remains unknown, actual zero remains zero',()=>{for(const value of [null,undefined,NaN,Infinity,-1,'123'])assert.equal(tokenCount(value),'Unknown');assert.equal(tokenCount(0),'0');});
test('estimated composition uses category total instead of pretending it equals occupancy',()=>{const rows=composition([{id:'a',label:'Rules',tokens:20},{id:'b',label:'Chat',tokens:80},{id:'c',label:'Unknown',tokens:null}]);assert.deepEqual(rows.map(x=>x.share),[.2,.8]);assert.deepEqual(composition([{id:'a',label:'Empty',tokens:0}]),[]);});
test('cost keeps explicit currency and measurement source',()=>{assert.match(costLabel({value:1.25,currency:'EUR',source:'estimated'}),/Estimated EUR 1.2500/);assert.equal(costLabel({value:null,currency:'USD',source:'unavailable'}),'Unavailable');assert.equal(costLabel({value:0,currency:'USD',source:'measured'}),'Measured USD 0.0000');});
test('anchored provider usage with a local delta remains labelled estimated',()=>{assert.equal(sourceLabel('provider_usage'),'Provider measured');assert.match(sourceLabel('provider_usage_plus_estimate'),/estimate/);assert.equal(sourceLabel('local_estimate'),'Estimated');});
