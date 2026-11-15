// Separate HTTP paths, same underlying hydrometric observations.
// Hub'Eau/Hydro uses millimetres; Vigicrues "ResObsHydro" uses metres.
// Fail closed: observations without valid timestamps, sensible heights or freshness
// never become an official-looking water level or trigger a flood push.
export const MAX_OBSERVATION_AGE_MS = 3 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 15 * 60 * 1000;
export const validHydroStation = code => typeof code==='string' && /^[A-Z][0-9]{9,11}$/.test(code);

function point(time, mm) {
 const t=typeof time==='number'?time:typeof time==='string'&&/^\d{13}$/.test(time)?Number(time):Date.parse(time);
 if(mm===null||mm===undefined||mm==='')return null;
 const height=Number(mm);
 if(!Number.isFinite(t)||!Number.isFinite(height)||height < -5000||height > 30000) return null;
 return {mm:height,time:t};
}
function normalize(rows) {
 if(!Array.isArray(rows)) throw Error('Observation list missing');
 const clean=rows.filter(Boolean).sort((a,b)=>b.time-a.time);
 const seen=new Set();
 return clean.filter(row=>{if(seen.has(row.time))return false;seen.add(row.time);return true});
}
export function parseHubObservations(payload) {
 return normalize((payload?.data||[]).map(row=>point(row?.date_obs,row?.resultat_obs)));
}
export function parseVigicruesObservations(payload, code) {
 if(!validHydroStation(code))throw Error('Invalid station code');
 const series=Array.isArray(payload?.Serie)?payload.Serie.find(s=>!s?.CdStationHydro||s.CdStationHydro===code):payload?.Serie;
 if(!series||typeof series!=='object')throw Error('Vigicrues series missing');
 const reported=series.CdStationHydro||payload.CdStationHydro;
 if(reported&&String(reported)!==code)throw Error('Vigicrues station mismatch');
 if(series.GrdSerie&&typeof series.GrdSerie==='string'&&series.GrdSerie!=='H')throw Error('Not a height series');
 const rows=series.ObssHydro;
 if(!Array.isArray(rows))throw Error('Vigicrues measurements missing');
 // Convert metres to millimetres, the format consumed by the existing app.
 return normalize(rows.map(row=>{
  if(row?.ResObsHydro===null||row?.ResObsHydro===undefined||row?.ResObsHydro==='')return null;
  const height=typeof row.ResObsHydro==='string'?row.ResObsHydro.replace(',','.'):row.ResObsHydro;
  return point(row.DtObsHydro,Number(height)*1000);
 }));
}
export function assertFresh(points, now=Date.now()) {
 if(!points.length)throw Error('No usable observations');
 const age=now-points[0].time;
 if(!Number.isFinite(age)||age>MAX_OBSERVATION_AGE_MS||age < -FUTURE_TOLERANCE_MS)throw Error('Observations stale or from the future');
 return points;
}
async function readJson(url, fetchImpl=fetch) {
 const response=await fetchImpl(url,{
  headers:{Accept:'application/json'},
  cache:'no-store',
  signal:AbortSignal.timeout(11000),
  cf:{cacheTtl:0}
 });
 if(!response.ok)throw Error('HTTP '+response.status);
 return response.json();
}
export async function readHubObservations(code,{limit=100,fetchImpl=fetch}={}) {
 if(!validHydroStation(code))throw Error('Invalid station code');
 const url='https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr?code_entite='+encodeURIComponent(code)+'&grandeur_hydro=H&size='+Math.min(Math.max(1,limit),1000)+'&sort=desc&format=json';
 const data=await readJson(url,fetchImpl);
 return {source:'hubeau',points:assertFresh(parseHubObservations(data)).slice(0,limit)};
}
export async function readVigicruesObservations(code,{limit=700,fetchImpl=fetch}={}) {
 if(!validHydroStation(code))throw Error('Invalid station code');
 const params='?CdStationHydro='+encodeURIComponent(code)+'&GrdSerie=H&FormatDate=iso';
 const endpoints=[
  'https://www.vigicrues.gouv.fr/services/observations.json/index.php'+params,
  'https://www.vigicrues.gouv.fr/services/observations.json/'+params
 ];
 let error;
 for(const url of endpoints){
  try{
   const data=await readJson(url,fetchImpl);
   const points=assertFresh(parseVigicruesObservations(data,code));
   // No backup alert from a single isolated measurement. This also prevents
   // spurious "back to green" notifications when no trend can be established.
   if(points.length < 2)throw Error('Insufficient backup observations');
   return {source:'vigicrues',points:points.slice(0,Math.min(limit,700))};
  }catch(e){error=e}
 }
 throw Error('Vigicrues unavailable: '+String(error?.message||error||'unknown'));
}
export async function getHydroObservations(code,{limit=100,fetchImpl=fetch}={}) {
 try{
  return await readHubObservations(code,{limit,fetchImpl});
 }catch(hubError){
  try{
   const backup=await readVigicruesObservations(code,{limit,fetchImpl});
   console.warn('Hydro fallback active',code,String(hubError?.message||hubError));
   return backup;
  }catch(backupError){
   throw Error('Both water sources unavailable: Hub '+String(hubError?.message||hubError)+'; Vigicrues '+String(backupError?.message||backupError));
  }
 }
}
