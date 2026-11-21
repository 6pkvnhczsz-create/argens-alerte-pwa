// Isolated diagnostic worker: NO D1 writes, NO alert dispatch, NO secrets.
// Deploy under its own name, never replace argens-alerte-push.
const ENDPOINT='https://www.vigicrues.gouv.fr/services/observations.json?CdStationHydro=Y531201001';
export default {
 async fetch(request){
  const url=new URL(request.url);
  if(url.pathname!=='/probe')return new Response('Not found',{status:404});
  const started=Date.now();
  try{
   const upstream=await fetch(ENDPOINT,{headers:{Accept:'application/json','User-Agent':'RiviereAlerteProbe/1.0 (+https://riviere-alerte.fr)'},signal:AbortSignal.timeout(12000),cf:{cacheTtl:0}});
   const contentType=upstream.headers.get('content-type')||'';
   // Do not expose or cache official measurements in the diagnostic endpoint.
   return Response.json({ok:upstream.ok&&contentType.includes('json'),httpStatus:upstream.status,contentType,elapsedMs:Date.now()-started},{headers:{'Cache-Control':'no-store'}});
  }catch(error){
   return Response.json({ok:false,errorType:String(error?.name||'Error'),elapsedMs:Date.now()-started},{headers:{'Cache-Control':'no-store'}});
  }
 }
};
