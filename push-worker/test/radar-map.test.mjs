import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {
 RADAR_BOUNDS, RADAR_MAX_AGE_MS, validateRadarFrame,
 verifyRadarWorkflowToken, storeRadarFrame, readRadarFrame, fetchOfficialRadarH5
} from '../src/radar-map.mjs';

const NOW=Date.parse('2026-11-15T18:00:00.000Z');
const png=()=>{
 const bytes=new Uint8Array(80);
 bytes.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
 bytes.set([0,0,2,208],16); // width 720
 bytes.set([0,0,1,244],20); // height 500
 bytes[24]=8;bytes[25]=6; // 8-bit RGBA
 return Buffer.from(bytes).toString('base64');
};
const frame=()=>({bounds:RADAR_BOUNDS,observedMs:NOW-5*60000,generatedMs:NOW-1000,
 coveragePct:80,wetPct:10,imageB64:png()});
const fakeDb=()=>{
 let stored=null;
 return {prepare(sql){
  let params=[];
  return {
   bind(...v){params=v;return this},
   async run(){
    if(sql.startsWith('INSERT INTO radar_argens_map')){
     if(!stored||params[0]>=stored.observed_ms){
      stored={observed_ms:params[0],received_ms:params[1],image_b64:params[2],
       coverage_pct:params[3],wet_pct:params[4]};
      return {meta:{changes:1}};
     }
     return {meta:{changes:0}};
    }
    return {meta:{}};
   },
   async first(){return stored}
  };
 }};
};
test('radar frame enforces fixed Argens extent, verified PNG geometry and freshness',()=>{
 const data=frame();
 assert.equal(validateRadarFrame(data,NOW).coveragePct,80);
 assert.throws(()=>validateRadarFrame({...data,bounds:[-10,0,10,90]},NOW),/extent/);
 assert.throws(()=>validateRadarFrame({...data,observedMs:NOW-50*60000},NOW),/Stale/);
 assert.throws(()=>validateRadarFrame({...data,coveragePct:0},NOW),/coverage/);
 assert.throws(()=>validateRadarFrame({...data,imageB64:Buffer.from('hello').toString('base64')},NOW),/PNG/);
});
test('stores only monotone measured radar frames; fails closed for stale images',async()=>{
 const db=fakeDb();
 const first=await storeRadarFrame(db,frame(),{now:NOW,runId:'11'});
 assert.equal(first.stored,true);
 const loaded=await readRadarFrame(db,{now:NOW+2*60000});
 assert.equal(loaded.observedAt,new Date(NOW-5*60000).toISOString());
 assert.equal(loaded.coveragePct,80);
 assert.deepEqual(loaded.bounds,RADAR_BOUNDS);
 assert.equal((await storeRadarFrame(db,{...frame(),observedMs:NOW-7*60000},{now:NOW,runId:'12'})).stored,false);
 await assert.rejects(()=>readRadarFrame(db,{now:NOW+RADAR_MAX_AGE_MS}),/stale/);
});
test('official Météo-France raw download never leaks key or follows redirects',async()=>{
 const options=[];
 const key='RADAR_PRIVATE_KEY';
 const fetchImpl=async(url,opts)=>{
  options.push(opts);
  assert.match(url,/DPRadar\/v1\/mosaiques\/METROPOLE\/observations\/LAME_D_EAU\/produit\?maille=500/);
  assert.equal(opts.headers.apikey,key);
  assert.equal(opts.redirect,'manual');
  return {ok:true,status:200,redirected:false,headers:{get:()=> '2500'},body:'opaque stream'};
 };
 assert.equal((await fetchOfficialRadarH5({METEO_FRANCE_API_KEY:key},{fetchImpl})).body,'opaque stream');
 assert.equal(options.length,1);
 await assert.rejects(()=>fetchOfficialRadarH5({METEO_FRANCE_API_KEY:key},{
  fetchImpl:async()=>({ok:false,status:403,headers:{get:()=>null}})
 }),/radar_http_403/);
 await assert.rejects(()=>fetchOfficialRadarH5({}, {fetchImpl}),/key not configured/);
});
test('radar OIDC allows only signed main-branch radar workflow, never Vigicrues tokens',async()=>{
 if(!globalThis.crypto)globalThis.crypto=webcrypto;
 const {privateKey,publicKey}=await webcrypto.subtle.generateKey({
  name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'
 },true,['sign','verify']);
 const key=await webcrypto.subtle.exportKey('jwk',publicKey);
 key.kid='testkey';key.use='sig';
 const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 const claims={
  iss:'https://token.actions.githubusercontent.com',aud:'riviere-alerte-radar-map',
  exp:Math.floor(NOW/1000)+200,iat:Math.floor(NOW/1000)-10,
  repository_id:'1457670420',repository_owner_id:'355805597',
  repository:'6pkvnhczsz-create/argens-alerte-pwa',ref:'refs/heads/main',
  workflow_ref:'6pkvnhczsz-create/argens-alerte-pwa/.github/workflows/radar-map-sync.yml@refs/heads/main',
  sub:'repo:6pkvnhczsz-create/argens-alerte-pwa:ref:refs/heads/main',event_name:'workflow_dispatch'
 };
 const issue=async(c)=>{
  const p=enc({kid:'testkey',alg:'RS256'})+'.'+enc(c);
  const signature=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',privateKey,new TextEncoder().encode(p));
  return p+'.'+Buffer.from(signature).toString('base64url');
 };
 const fetchImpl=async()=>({ok:true,json:async()=>({keys:[key]})});
 assert.equal((await verifyRadarWorkflowToken(await issue(claims),{now:NOW,fetchImpl})).runId,'');
 await assert.rejects(async()=>verifyRadarWorkflowToken(await issue({...claims,aud:'riviere-alerte-vigicrues-sync'}),{now:NOW,fetchImpl}),/audience/);
 await assert.rejects(async()=>verifyRadarWorkflowToken(await issue({...claims,workflow_ref:'unexpected'}),{now:NOW,fetchImpl}),/workflow/);
 await assert.rejects(async()=>verifyRadarWorkflowToken(await issue({...claims,ref:'refs/heads/dev'}),{now:NOW,fetchImpl}),/branch/);
});
test('the website retains Windy fallback and never exposes an API key',()=>{
 const page=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
 const worker=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 assert.match(page,/id="officialRadarMap"/);
 assert.match(page,/id="officialRadarLegend"/);
 assert.match(page,/id="windyRadarFrame"/);
 assert.match(page,/id="radarNote"/);
 assert.match(page,/RADAR_MAP_API\+'\/info'/);
 assert.match(page,/RADAR_MAP_API\+'\/image\?t='/);
 assert.match(page,/function showWindyRadarFallback/);
 assert.doesNotMatch(page,/apikey\s*:/);
 assert.match(worker,/api\/radar-map\/raw/);
 assert.match(worker,/verifyRadarWorkflowToken/);
 assert.match(worker,/api\/radar-map\/image/);
 assert.match(worker,/api\/radar-map\/ingest/);
 const scripts=[...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(Boolean);
 for(const script of scripts)assert.doesNotThrow(()=>new Script(script));
});
