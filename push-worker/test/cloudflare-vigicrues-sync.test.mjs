import test from 'node:test';
import assert from 'node:assert/strict';
import { syncVigicruesFromCloudflare } from '../src/cloudflare-vigicrues-sync.mjs';

test('Cloudflare sync stays off without explicit production opt-in',async()=>{
  const result=await syncVigicruesFromCloudflare({DB:null});
  assert.deepEqual(result,{enabled:false,stored:0});
});
test('Cloudflare sync fails closed without D1',async()=>{
  await assert.rejects(syncVigicruesFromCloudflare({VIGICRUES_CLOUDFLARE_SYNC:'enabled'}),/D1 binding missing/);
});

function mockDb(){
 const calls=[];
 return {
  calls,
  prepare(sql){
   calls.push(sql);
   return {
    bind(){return this},
    async all(){return {results:[]}},
    async first(){return null},
    async run(){return {meta:{changes:1}}}
   };
  }
 };
}
test('opted-in sync persists validated observations without any GitHub identity',async()=>{
 const db=mockDb(),now=Date.now();
 const result=await syncVigicruesFromCloudflare({
  DB:db,VIGICRUES_CLOUDFLARE_SYNC:'enabled'
 },{
  now,reader:async()=>({points:[
   {time:now-5*60_000,mm:1200},
   {time:now-10*60_000,mm:1190}
  ]})
 });
 assert.equal(result.enabled,true);
 assert.equal(result.failed,0);
 assert.equal(result.stored,result.activeCount);
 assert.ok(result.stored>=1);
 assert.ok(db.calls.some(sql=>sql.includes('INSERT INTO vigicrues_backup_snapshots')));
});
test('transient upstream errors do not mark stations unavailable for hours',async()=>{
 const db=mockDb();
 const result=await syncVigicruesFromCloudflare({
  DB:db,VIGICRUES_CLOUDFLARE_SYNC:'enabled'
 },{
  reader:async()=>{throw Error('HTTP 503 upstream unavailable')}
 });
 assert.equal(result.stored,0);
 assert.equal(result.failed,result.activeCount);
 assert.ok(result.failed>=1);
 assert.ok(!db.calls.some(sql=>sql.includes('INSERT INTO vigicrues_backup_failures')));
});
