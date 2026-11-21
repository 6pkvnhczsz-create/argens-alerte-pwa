// Optional Cloudflare-native replacement for the GitHub Vigicrues snapshot cron.
// Disabled by default until upstream access and D1 parity are verified.
import { readVigicruesObservations } from './water-sources.mjs';
import { activeBackupStationCodes, ingestSnapshot, markVigicruesUnavailable } from './vigicrues-snapshot.mjs';

export async function syncVigicruesFromCloudflare(env, {
  reader=readVigicruesObservations, now=Date.now(), maxStations=200
}={}) {
  if(env.VIGICRUES_CLOUDFLARE_SYNC !== 'enabled')return {enabled:false,stored:0};
  if(!env.DB)throw Error('D1 binding missing');
  const {stations,activeCount,deferred}=await activeBackupStationCodes(env.DB,{now});
  if(activeCount>maxStations)throw Error('Too many Vigicrues stations; refusing silent truncation');
  let stored=0,failed=0;
  const failures=[];
  // Limit concurrency and per-run external requests. A failed station never blocks the others.
  for(let i=0;i<stations.length;i+=4){
    const batch=stations.slice(i,i+4);
    await Promise.all(batch.map(async station=>{
      try{
        const {points}=await reader(station,{limit:700});
        const payload={station,collectedAt:Date.now(),readings:points.map(p=>[p.time,p.mm])};
        const result=await ingestSnapshot(env.DB,payload,{runId:'cloudflare-cron',now:Date.now()});
        if(result.stored)stored++;
      }catch(error){
        failed++;
        const reason=String(error?.message||error).slice(0,160);
        failures.push({station,error:reason});
        // Only genuine missing/stale/unsupported series get a long cooldown.
        // Transport errors (timeouts, 429, 5xx, upstream blocking) must be retried
        // on the next cron, never hidden for six hours.
        const unavailableReason=/stale|future/i.test(reason)?'stale'
          :/\b404\b|not.found/i.test(reason)?'not_found'
          :/\b403\b|denied/i.test(reason)?'access_denied'
          :/insufficient|series missing|measurements missing|no usable/i.test(reason)?'no_data'
          :null;
        if(unavailableReason){
          try{await markVigicruesUnavailable(env.DB,station,unavailableReason)}
          catch(markError){console.error('Vigicrues backoff failed',station,String(markError))}
        }
      }
    }));
  }
  if(failed)console.warn('Cloudflare Vigicrues sync partial failure',JSON.stringify(failures.slice(0,12)));
  return {enabled:true,activeCount,deferred:deferred.length,stored,failed};
}
