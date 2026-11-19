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
