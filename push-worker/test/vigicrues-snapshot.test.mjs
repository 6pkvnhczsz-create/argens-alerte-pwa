import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { getHydroObservations } from '../src/water-sources.mjs';
import {
 parseSnapshotPayload, ingestSnapshot, storedVigicruesObservations,
 verifyGitHubActionToken, activeBackupStationCodes, isActiveBackupStation,
 markVigicruesUnavailable, HOME_STATION
} from '../src/vigicrues-snapshot.mjs';

const now=Date.now();
const station=HOME_STATION, second='A123456789', third='B123456789';
const date=minutes=>now-minutes*60000;
const payload=(code=station)=>({station:code,collectedAt:now,readings:[[date(8),1450],[date(38),1400],[date(78),1350]]});

function fakeDb({active=[second,second,third]}={}){
 const selected=new Set(active);
 const snapshots=new Map(),misses=new Map();
 return {
  selected,snapshots,misses,
  prepare(sql){
   let params=[];
   return {
    bind(...values){params=values;return this},
    async run(){
     if(sql.startsWith('INSERT INTO vigicrues_backup_snapshots')){
      const old=snapshots.get(params[0]);
      if(!old||params[1]>=old.latest_ms&&params[2]>old.received_ms){
       snapshots.set(params[0],{station_code:params[0],latest_ms:params[1],received_ms:params[2],readings_json:params[3],run_id:params[4]});
       return {meta:{changes:1}};
      }
      return {meta:{changes:0}};
     }
     if(sql.startsWith('INSERT INTO vigicrues_backup_failures')){
      misses.set(params[0],{checked_ms:params[1],reason:params[2]});
     }
     if(sql.startsWith('DELETE FROM vigicrues_backup_failures WHERE station_code=')){
      misses.delete(params[0]);
     }
     if(sql.startsWith('DELETE FROM vigicrues_backup_snapshots WHERE station_code !=')){
      for(const [code,row] of snapshots)if(code!==params[0]&&row.received_ms<params[1]&&!selected.has(code))snapshots.delete(code);
     }
     return {meta:{}};
    },
    async first(){
     if(sql.startsWith('SELECT 1 AS present FROM user_station_settings'))return selected.has(params[0])?{present:1}:null;
     if(sql.startsWith('SELECT latest_ms,received_ms,readings_json'))return snapshots.get(params[0])||null;
     throw Error('Unexpected SQL first: '+sql);
    },
    async all(){
     if(sql.startsWith('SELECT DISTINCT p.station_code'))return {results:[...selected].map(station_code=>({station_code}))};
     if(sql.startsWith('SELECT station_code FROM vigicrues_backup_failures WHERE')){
      return {results:[...misses].filter(([code,m])=>m.reason==='stale'?m.checked_ms>params[0]:m.checked_ms>params[1]).map(([station_code])=>({station_code}))};
     }
     throw Error('Unexpected SQL all: '+sql);
    }
   };
  }
 };
}

test('accepts only plausible fresh station snapshots for any registered station',()=>{
 assert.equal(parseSnapshotPayload(payload(),now)[0].mm,1450);
 assert.equal(parseSnapshotPayload(payload(second),now)[0].mm,1450);
 assert.throws(()=>parseSnapshotPayload(payload('INVALID'),now),/station/);
 assert.throws(()=>parseSnapshotPayload({...payload(),readings:[[date(8),1450000],[date(38),1400]]},now),/Implausible/);
 assert.throws(()=>parseSnapshotPayload({...payload(),readings:[[date(8),null],[date(38),1400]]},now),/Invalid observation/);
 assert.throws(()=>parseSnapshotPayload({...payload(),collectedAt:now-20*60000},now),/Stale snapshot collection/);
 assert.throws(()=>parseSnapshotPayload({...payload(),readings:[[date(8),1450],[now-5*86400000,1440]]},now),/Out-of-range/);
});

test('discovers only active distinct subscriber stations plus permanent home station',async()=>{
 const db=fakeDb();
 const stations=await activeBackupStationCodes(db,{now});
 assert.deepEqual(stations.stations,[second,third,station].sort());
 assert.equal(stations.activeCount,3);
 db.selected.delete(second);
 const afterSwitch=await activeBackupStationCodes(db,{now});
 assert.deepEqual(afterSwitch.stations,[third,station].sort());
 assert.equal(await isActiveBackupStation(db,second),false);
 assert.equal(await isActiveBackupStation(db,station),true);
});

test('new user station is automatically included in the next discovery, without deployment',async()=>{
 const db=fakeDb({active:[]});
 assert.deepEqual((await activeBackupStationCodes(db,{now})).stations,[station]);
 db.selected.add(second);
 assert.deepEqual((await activeBackupStationCodes(db,{now:now+5*60000})).stations,[second,station].sort());
});

test('stores two different user stations independently and prevents arbitrary snapshot injection',async()=>{
 const db=fakeDb({active:[second,third]});
 await ingestSnapshot(db,payload(second),{runId:'123',now});
 await ingestSnapshot(db,{...payload(third),readings:[[date(8),6500],[date(38),6300]]},{runId:'124',now});
 assert.equal(db.snapshots.size,2);
 const one=await storedVigicruesObservations(db,second,{now});
 const two=await storedVigicruesObservations(db,third,{now});
 assert.equal(one.points[0].mm,1450);
 assert.equal(two.points[0].mm,6500);
 await assert.rejects(()=>ingestSnapshot(db,payload('C123456789'),{now}),/Inactive/);
 db.selected.delete(second);
 await assert.rejects(()=>storedVigicruesObservations(db,second,{now}),/no active subscribers/);
});

test('defer unsupported station for six hours, stale readings for 30 minutes',async()=>{
 const db=fakeDb({active:[second,third]});
 const missing=await markVigicruesUnavailable(db,second,'no_data',{now});
 const stale=await markVigicruesUnavailable(db,third,'stale',{now});
 assert.equal(missing.deferredForMinutes,360);
 assert.equal(stale.deferredForMinutes,30);
 const immediate=await activeBackupStationCodes(db,{now:now+10*60000});
 assert.deepEqual(immediate.stations,[station]);
 assert.deepEqual(immediate.deferred,[second,third].sort());
 const thirtyOne=await activeBackupStationCodes(db,{now:now+31*60000});
 assert.deepEqual(thirtyOne.stations,[third,station].sort());
 const sixHours=await activeBackupStationCodes(db,{now:now+361*60000});
 assert.equal(sixHours.stations.length,3);
 assert.rejects(()=>markVigicruesUnavailable(db,'C123456789','no_data',{now}),/Inactive/);
});

test('successful observation clears previous no-data cooldown and older replay does not overwrite',async()=>{
 const db=fakeDb({active:[second]});
 await markVigicruesUnavailable(db,second,'no_data',{now});
 assert.equal((await activeBackupStationCodes(db,{now})).deferred[0],second);
 const saved=await ingestSnapshot(db,payload(second),{runId:'123',now});
 assert.equal(saved.stored,true);
 assert.equal(db.misses.has(second),false);
 const older={...payload(second),collectedAt:now+1000,readings:[[date(12),1350],[date(42),1300]]};
 const replay=await ingestSnapshot(db,older,{runId:'older',now:now+1000});
 assert.equal(replay.stored,false);
 assert.equal(db.snapshots.get(second).latest_ms,date(8));
});

test('rejects stale GitHub deliveries and naturally aging historical observation points',async()=>{
 const db=fakeDb({active:[second]});
 await ingestSnapshot(db,payload(second),{runId:'test',now});
 const backup=await storedVigicruesObservations(db,second,{limit:100,now:now+25*60000});
 assert.equal(backup.source,'vigicrues');
 assert.equal(backup.transport,'github-actions');
 assert.equal(backup.points.length,3);
 await assert.rejects(()=>storedVigicruesObservations(db,second,{now:now+76*60000}),/delivery outdated/);
 const nearCutoff={station:second,collectedAt:now,readings:[[date(8),1450],[date(38),1400],[now-4*86400000+2000,1330]]};
 await ingestSnapshot(db,nearCutoff,{now:now+1000});
 const read=await storedVigicruesObservations(db,second,{now:now+5000});
 assert.equal(read.points.length,2);
});

test('Hub Eau always remains the primary source and outage switches to user station snapshot',async()=>{
 const db=fakeDb({active:[second]});
 await ingestSnapshot(db,payload(second),{now});
 const good=async()=>({ok:true,json:async()=>({data:[{date_obs:new Date(date(8)).toISOString(),resultat_obs:1500},{date_obs:new Date(date(38)).toISOString(),resultat_obs:1450}]})});
 const primary=await getHydroObservations(second,{fetchImpl:good,backupReader:()=>{throw Error('Do not use backup when Hub Eau works')}});
 assert.equal(primary.source,'hubeau');
 const failover=await getHydroObservations(second,{fetchImpl:async()=>({ok:false,status:503}),
  backupReader:(code,limit)=>storedVigicruesObservations(db,code,{limit,now})});
 assert.equal(failover.source,'vigicrues');
 assert.equal(failover.points[0].mm,1450);
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
 const tampered=await issue(claims),parts=tampered.split('.');
 parts[1]=enc({...claims,run_id:'changed'});
 await assert.rejects(()=>verifyGitHubActionToken(parts.join('.'),{now,fetchImpl}),/signature/);
});
