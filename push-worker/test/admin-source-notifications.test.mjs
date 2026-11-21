import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const start=source.indexOf('async function notifyAdminSourceOutage(');
const end=source.indexOf('// Independent precipitation forecast alerts.',start);
assert.ok(start>=0&&end>start,'admin incident functions present');
const snippet=source.slice(start,end);
const now=Date.parse('2026-11-21T12:00:00Z');
const iso=minutes=>new Date(now-minutes*60000).toISOString();

function harness({checked=0,success=0,observed=0,configured=true}={}){
 const state={incident:null,requests:[],fail:false,reading:{last_check_at:iso(checked),last_success_at:iso(success),last_observed_at:iso(observed)}};
 const db={prepare(sql){
  return {bind(...values){return {async first(){if(sql.includes('FROM monitor_status'))return state.reading;if(sql.includes('FROM admin_source_incident'))return state.incident?{incident_state:state.incident}:null;throw Error('unexpected SELECT '+sql)},async run(){if(sql.includes('INSERT INTO admin_source_incident'))state.incident=values[1];else if(sql.includes('UPDATE admin_source_incident'))state.incident=values[0];else throw Error('unexpected write '+sql)}}},async run(){if(!sql.includes('CREATE TABLE'))throw Error('unexpected SQL');}};
 }};
 class FakeDate extends Date{constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}
 const fetch=async(url,options)=>{state.requests.push({url,options});return {ok:!state.fail,status:state.fail?503:200}};
 const context=vm.createContext({Date:FakeDate,fetch,STATION:'Y531201001',console});
 vm.runInContext(snippet+'\nthis.check=notifyAdminSourceOutage',context);
 const env={DB:db,ADMIN_NTFY_TOPIC:configured?'private_admin_topic_2026':undefined,ADMIN_NTFY_TOKEN:configured?'private-token':undefined};
 return {state,env,check:()=>context.check(env)};
}
test('no configured admin topic means no push or writes',async()=>{const h=harness({configured:false,observed:90});await h.check();assert.equal(h.state.requests.length,0);assert.equal(h.state.incident,null)});
test('healthy first check silently establishes baseline',async()=>{const h=harness();await h.check();assert.equal(h.state.incident,'healthy');assert.equal(h.state.requests.length,0)});
test('61 minute stale observation sends one private outage alert',async()=>{const h=harness({observed:61});await h.check();await h.check();assert.equal(h.state.incident,'outage');assert.equal(h.state.requests.length,1);assert.match(h.state.requests[0].url,/ntfy.sh\\/private_admin_topic_2026/);assert.equal(h.state.requests[0].options.headers.Authorization,'Bearer private-token')});
test('stale successful fetch also causes outage',async()=>{const h=harness({success:61});await h.check();assert.equal(h.state.incident,'outage');assert.equal(h.state.requests.length,1)});
test('outage recovery sends exactly one recovery',async()=>{const h=harness({observed:61});await h.check();h.state.reading.last_observed_at=iso(0);await h.check();await h.check();assert.equal(h.state.incident,'healthy');assert.equal(h.state.requests.length,2);assert.match(h.state.requests[1].options.headers.Title,/wieder aktuell/)});
test('failed delivery does not persist transition and retries',async()=>{const h=harness({observed:61});h.state.fail=true;await assert.rejects(h.check(),/503/);assert.equal(h.state.incident,null);h.state.fail=false;await h.check();assert.equal(h.state.incident,'outage');assert.equal(h.state.requests.length,2)});
test('missing cron heartbeat suppresses outage push',async()=>{const h=harness({checked:31,observed:61});await h.check();assert.equal(h.state.requests.length,0);assert.equal(h.state.incident,null)});
test('30 minute delay does not notify',async()=>{const h=harness({observed:31});await h.check();assert.equal(h.state.incident,'healthy');assert.equal(h.state.requests.length,0)});
