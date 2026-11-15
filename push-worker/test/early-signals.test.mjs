import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import {
 UPSTREAM_STATIONS, RAIN_AREAS, parseUpstreamPoints, parseRainEstimate,
 parseMeteoVigilance, fetchOfficialVigilance, buildEarlySignals,
 refreshEarlySignals, loadEarlySignals
} from '../src/early-signals.mjs';

const NOW=Date.parse('2026-11-15T14:00:00Z');
const iso=x=>new Date(x).toISOString();
function fixtureOfficial(){
 return {product:{update_time:iso(NOW-3600000),
  periods:[{echeance:'J',begin_validity_time:iso(NOW-2*3600000),
  end_validity_time:iso(NOW+8*3600000),
  timelaps:{domain_ids:[{domain_id:'83',max_color_id:'3',
   phenomenon_items:[{phenomenon_id:'2',phenomenon_max_color_id:'3'},{phenomenon_id:'4',phenomenon_max_color_id:'1'}]},
   {domain_id:'84',max_color_id:'4',phenomenon_items:[]}]}},
   {echeance:'J1',begin_validity_time:iso(NOW+8*3600000),
    end_validity_time:iso(NOW+32*3600000),timelaps:{domain_ids:[{domain_id:'83',max_color_id:'2',phenomenon_items:[]}]}}
  ]
 }};
}
test('only documented, distinct upstream Argens tributary stations are selected',()=>{
 assert.equal(UPSTREAM_STATIONS.length,3);
 assert.equal(new Set(UPSTREAM_STATIONS.map(x=>x.code)).size,3);
 assert.deepEqual(UPSTREAM_STATIONS.map(x=>x.code),['Y530501501','Y520201001','Y523501001']);
});
test('upstream rates use individual station trends, never compare different gauge zeroes',()=>{
 const points=[{time:NOW-5*60000,mm:1450},{time:NOW-65*60000,mm:1100},{time:NOW-115*60000,mm:900}];
 const r=parseUpstreamPoints(points,NOW);
 assert.equal(r.status,'current');
 assert.equal(r.levelM,1.45);
 assert.equal(r.trendCmH,35);
 assert.throws(()=>parseUpstreamPoints([{time:NOW-4*3600000,mm:900},{time:NOW-5*3600000,mm:800}],NOW),/Stale/);
});
test('model rain accumulates past hourly estimates, never claims radar measurement',()=>{
 const hours=Array.from({length:8},(_,i)=>Math.floor((NOW-(8-i)*3600000)/1000));
 const weather={hourly:{time:hours,precipitation:Array(8).fill(2)}};
 const result=parseRainEstimate(weather,NOW);
 assert.equal(result.status,'estimated');
 assert.equal(result.last3hMm,4);
 assert.equal(result.last6hMm,10);
 assert.throws(()=>parseRainEstimate({hourly:{time:hours,precipitation:[1]}},NOW),/Missing/);
 assert.throws(()=>parseRainEstimate({hourly:{time:hours.slice(0,2),precipitation:[2,2]}},NOW),/Incomplete/);
});
test('official vigilance reads Var department (83), not another department and shows proper colors',()=>{
 const parsed=parseMeteoVigilance(fixtureOfficial(),{now:NOW});
 assert.equal(parsed.status,'official');
 assert.equal(parsed.periods.length,2);
 assert.equal(parsed.periods[0].color,'orange');
 assert.equal(parsed.periods[0].phenomena[0].fr,'Pluie-inondation');
 assert.equal(parsed.periods[1].color,'yellow');
 assert.throws(()=>parseMeteoVigilance({...fixtureOfficial(),product:{...fixtureOfficial().product,update_time:iso(NOW-25*3600000)}},{now:NOW}),/Outdated/);
 assert.throws(()=>parseMeteoVigilance({product:{update_time:iso(NOW),periods:[]}},{now:NOW}),/No valid/);
});
test('without account, Météo-France is unconfigured, never falsely green',async()=>{
 const r=await fetchOfficialVigilance({}, {now:NOW,fetchImpl:async()=>{throw Error('Must not fetch without subscription')}});
 assert.equal(r.status,'not_configured');assert.equal(r.periods.length,0);assert.match(r.link,/meteofrance.fr/);
});
test('configured Météo-France obtains short lived OAuth2 token and validates official response',async()=>{
 const seen=[];
 const fetchImpl=async(url,options)=>{
  seen.push({url,options});
  if(url.endsWith('/token'))return {ok:true,json:async()=>({access_token:'abcdefghijklmnopqrstuvwxyz',expires_in:3600})};
  assert.equal(options.headers.Authorization,'Bearer abcdefghijklmnopqrstuvwxyz');
  return {ok:true,json:async()=>fixtureOfficial()};
 };
 const r=await fetchOfficialVigilance({METEO_FRANCE_BASIC:'fictional-test-only'}, {now:NOW,fetchImpl});
 assert.equal(r.status,'official');assert.equal(seen.length,2);
 assert.equal(seen[0].options.headers.Authorization,'Basic fictional-test-only');
});
test('independent data errors never generate flood alerts or artificial official levels',async()=>{
 const fetchImpl=async()=>({ok:false,status:503});
 const data=await buildEarlySignals({}, {now:NOW,fetchImpl});
 assert.equal(data.upstream.length,3);assert.ok(data.upstream.every(x=>x.status==='unavailable'));
 assert.equal(data.rain.length,3);assert.ok(data.rain.every(x=>x.status==='unavailable'));
 assert.equal(data.official.status,'not_configured');
 assert.equal(data.radar.status,'not_connected');
 assert.equal(data.changesFloodThresholds,false);
 assert.equal(data.interpretation,'information_only');
});
test('D1 cache must be recent, rejects stale indicator data',async()=>{
 let row=null;const db={prepare(sql){
  let args=[];return {bind(...x){args=x;return this},async run(){
   if(sql.startsWith('INSERT INTO early_signals'))row={checked_ms:args[1],payload:args[2]};
  },async first(){return row}};
 }};
 const fetchImpl=async()=>({ok:false,status:503});
 const saved=await refreshEarlySignals({DB:db},{now:NOW,fetchImpl});
 assert.equal(saved.ok,true);
 assert.equal((await loadEarlySignals(db,{now:NOW+100000})).station,'Y531201001');
 await assert.rejects(()=>loadEarlySignals(db,{now:NOW+26*60000}),/stale/);
});
test('worker surface is information only, does not rewrite warning functions',()=>{
 const src=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 const page=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
 assert.match(src,/url.pathname==='\x2fapi\x2fearly-signals'/);
 assert.match(src,/ctx\.waitUntil\(refreshEarlySignals\(env\)/);
 assert.match(src,/function levelFor\(metres,rate\)\{return metres>=4\.5\?'red':metres>=3/);
 assert.match(src,/const rapidLevel=obs.rate!==null&&obs.rate>=50\?'red':obs.rate!==null&&obs.rate>=30/);
 assert.match(page,/id="earlySignalsPanel"/);
 assert.match(page,/id="earlyOfficialLink"/);
 assert.match(page,/id="earlyUpstreamRows"/);
 assert.match(page,/id="earlyRainDisclaimer"/);
 assert.match(page,/keine gemessenen Radardaten/i);
 const inline=[...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(Boolean);
 for(const script of inline) assert.doesNotThrow(()=>new Script(script));
 assert.equal(RAIN_AREAS.length,3);
});
