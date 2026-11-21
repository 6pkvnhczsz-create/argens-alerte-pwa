// Isolated read-only direct Vigicrues monitoring: no D1, push, or alert side effects.
// GitHub backup remains active until a separately verified production migration.
import {readVigicruesObservations} from '../push-worker/src/water-sources.mjs';
const STATIONS=['Y531201001'];
async function probe(){
 const checkedAt=new Date().toISOString(), results=[];
 for(const station of STATIONS){
  const start=Date.now();
  try{
   const result=await readVigicruesObservations(station,{limit:10});
   const newest=result.points[0];
   results.push({station,ok:true,readings:result.points.length,observedAt:new Date(newest.time).toISOString(),ageMinutes:Math.round((Date.now()-newest.time)/60000),elapsedMs:Date.now()-start});
  }catch(e){
   results.push({station,ok:false,error:String(e?.message||e).slice(0,450),elapsedMs:Date.now()-start});
  }
 }
 return {ok:results.every(r=>r.ok),checkedAt,results};
}
export default {
 async fetch(request){
  if(new URL(request.url).pathname!=='/probe')return new Response('Not found',{status:404});
  const result=await probe();
  return Response.json(result,{status:result.ok?200:503,headers:{'Cache-Control':'no-store'}});
 },
 async scheduled(event,env,ctx){
  ctx.waitUntil(probe().then(result=>{
   // Cloudflare Worker logs permit checking repeated runs; no storage or alerts changed.
   console.log('VIGICRUES_DIRECT_PROBE',JSON.stringify(result));
  }).catch(error=>console.error('VIGICRUES_DIRECT_PROBE_ERROR',String(error))));
 }
};
