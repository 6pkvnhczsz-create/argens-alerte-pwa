import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { getHydroObservations } from '../src/water-sources.mjs';
import {
 parseSnapshotPayload, ingestSnapshot, storedVigicruesObservations,
 verifyGitHubActionToken
} from '../src/vigicrues-snapshot.mjs';

const now=Date.now(),station='Y531201001';
const date=minutes=>now-minutes*60000;
const payload=()=>({station,collectedAt:now,readings:[[date(8),1450],[date(38),1400],[date(78),1350]]});
function fakeDb(){
 let record=null;
 return {
  prepare(sql){
   let params=[];
   return {
    bind(...args){params=args;return this},
    async run(){
     if(sql.startsWith('INSERT')){
      if(!record||params[1]>=record.latest_ms&&params[2]>record.received_ms){
       record={station_code:params[0],latest_ms:params[1],received_ms:params[2],readings_json:params[3],run_id:params[4]};
       return {meta:{changes:1}};
      }
      return {meta:{changes:0}};
     }
     return {meta:{}};
    },
    async first(){return record?.station_code===params[0]?record:null}
   };
  },
  get record(){return record}
 };
}

test('accepts only plausible, fresh station snapshots',()=>{
 assert.equal(parseSnapshotPayload(payload(),now)[0].mm,1450);
 assert.throws(()=>parseSnapshotPayload({...payload(),station:'E541000401'},now),/station/);
 assert.throws(()=>parseSnapshotPayload({...payload(),readings:[[date(8),1450000],[date(38),1400]]},now),/Implausible/);
 assert.throws(()=>parseSnapshotPayload({...payload(),readings:[[date(8),null],[date(38),1400]]},now),/Invalid observation/);
 assert.throws(()=>parseSnapshotPayload({...payload(),collectedAt:now-20*60000},now),/Stale snapshot collection/);
});

test('writes data to D1 and reads it back for web and push fallback',async()=>{
 const db=fakeDb();
 const saved=await ingestSnapshot(db,payload(),{runId:'test',now});
 assert.equal(saved.stored,true);
 assert.equal(saved.observedAt,new Date(date(8)).toISOString());
 const backup=await storedVigicruesObservations(db,station,{limit:100,now:now+25*60000});
 assert.equal(backup.source,'vigicrues');
 assert.equal(backup.transport,'github-actions');
 assert.equal(backup.points[0].mm,1450);
 assert.equal(backup.points.length,3);
});

test('refuses stale GitHub deliveries and replayed older observations',async()=>{
 const db=fakeDb();
 await ingestSnapshot(db,payload(),{runId:'test',now});
 await assert.rejects(()=>storedVigicruesObservations(db,station,{now:now+76*60000}),/delivery outdated/);
 const older={...payload(),collectedAt:now+1000,readings:[[date(12),1350],[date(42),1300]]};
 const saved=await ingestSnapshot(db,older,{runId:'older',now:now+1000});
 assert.equal(saved.stored,false);
 assert.equal(db.record.latest_ms,date(8));
});

test('Hub Eau always remains the first source',async()=>{
 const fetchImpl=async()=>({ok:true,json:async()=>({data:[{date_obs:new Date(date(8)).toISOString(),resultat_obs:1500},{date_obs:new Date(date(38)).toISOString(),resultat_obs:1450}]})});
 const out=await getHydroObservations(station,{fetchImpl,backupReader:()=>{throw Error('backup must not be called')}});
 assert.equal(out.source,'hubeau');
});

test('Hub Eau outage switches to authenticated stored backup',async()=>{
 const db=fakeDb();await ingestSnapshot(db,payload(),{now});
 const out=await getHydroObservations(station,{fetchImpl:async()=>({ok:false,status:503}),
  backupReader:(code,limit)=>storedVigicruesObservations(db,code,{limit,now})});
 assert.equal(out.source,'vigicrues');assert.equal(out.points[0].mm,1450);
});

test('rejects forged OIDC tokens and accepts signed GitHub main workflow',async()=>{
 if(!globalThis.crypto)globalThis.crypto=webcrypto;
 const {privateKey,publicKey}=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const key=await webcrypto.subtle.exportKey('jwk',publicKey);key.kid='testkey';key.use='sig';
 const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 const claims={
  iss:'https://token.actions.githubusercontent.com',aud:'riviere-alerte-vigicrues-sync',
  exp:Math.floor(now/1000)+240,iat:Math.floor(now/1000)-5,
  repository_id:'1457670420',repository_owner_id:'355805597',
  repository:'6pkvnhczsz-create/argens-alerte-pwa',ref:'refs/heads/main',
  workflow_ref:'6pkvnhczsz-create/argens-alerte-pwa/.github/workflows/vigicrues-backup-sync.yml@refs/heads/main',
  event_name:'workflow_dispatch',sub:'repo:6pkvnhczsz-create/argens-alerte-pwa:ref:refs/heads/main',
  run_id:'123456'
 };
 const issue=async c=>{
  const value=enc({alg:'RS256',typ:'JWT',kid:'testkey'})+'.'+enc(c);
  const signature=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',privateKey,new TextEncoder().encode(value));
  return value+'.'+Buffer.from(signature).toString('base64url');
 };
 const fetchImpl=async()=>({ok:true,json:async()=>({keys:[key]})});
 const accepted=await verifyGitHubActionToken(await issue(claims),{now,fetchImpl});
 assert.equal(accepted.runId,'123456');
 const badBranch=await issue({...claims,ref:'refs/heads/attacker'});
 await assert.rejects(()=>verifyGitHubActionToken(badBranch,{now,fetchImpl}),/repository or branch/);
 const badWorkflow=await issue({...claims,workflow_ref:'unexpected.yml'});
 await assert.rejects(()=>verifyGitHubActionToken(badWorkflow,{now,fetchImpl}),/workflow or event/);
 const tampered=await issue(claims);
 const parts=tampered.split('.');
 parts[1]=enc({...claims,run_id:'changed'});
 await assert.rejects(()=>verifyGitHubActionToken(parts.join('.'),{now,fetchImpl}),/signature/);
});
