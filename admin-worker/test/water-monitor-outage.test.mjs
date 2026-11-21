import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const start=source.indexOf('async function loadAdminStatus()');
const end=source.indexOf("document.getElementById('monitorRefresh')",start);
assert.ok(start>=0&&end>start,'Admin monitor renderer exists');
const script=source.slice(start,end).replaceAll('\\n','\n');

async function simulate({checked=0,success=0,observed=0,error=null}){
 const now=Date.parse('2026-11-21T12:00:00Z');
 const iso=minutes=>new Date(now-minutes*60000).toISOString();
 const elements=new Map();
 const get=id=>{if(!elements.has(id))elements.set(id,{dataset:{},textContent:'',hidden:false});return elements.get(id)};
 const document={getElementById:get};
 class FakeDate extends Date{constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}
 const data={last_check_at:checked===null?null:iso(checked),last_success_at:success===null?null:iso(success),last_observed_at:observed===null?null:iso(observed),last_error:error,last_metres:1.2,last_level:'green'};
 const context={document,Date:FakeDate,fetch:async()=>({ok:true,json:async()=>data}),Number,Error};
 vm.runInNewContext(script+'\nloadAdminStatus()',context);
 await new Promise(resolve=>setImmediate(resolve));
 return {state:get('monitorCard').dataset.state,title:get('monitorTitle').textContent,description:get('monitorSubtitle').textContent};
}
test('fresh readings are green',async()=>{assert.equal((await simulate({})).state,'good')});
test('31 minute old observation is delayed',async()=>{const x=await simulate({observed:31});assert.equal(x.state,'stale');assert.match(x.title,/verzögert/)});
test('61 minute old observation triggers outage',async()=>{const x=await simulate({observed:61});assert.equal(x.state,'bad');assert.match(x.title,/60 Minuten/)});
test('61 minute old successful check triggers outage',async()=>{assert.equal((await simulate({success:61})).state,'bad')});
test('31 minute old cron check reports monitor outage',async()=>{const x=await simulate({checked:31});assert.equal(x.state,'bad');assert.match(x.title,/Überwachung ausgefallen/)});
test('last request error remains visible with fresh cached observation',async()=>{const x=await simulate({error:'both sources down'});assert.equal(x.state,'stale');assert.match(x.title,/fehlgeschlagen/)});
test('missing measurement is an outage',async()=>{assert.equal((await simulate({observed:null})).state,'bad')});
