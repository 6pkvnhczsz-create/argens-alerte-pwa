// Rivière Alerte: independent *informational* early indicators, never alter
// users' station thresholds, risk levels, or existing flood-push decisions.
// Météo-France official vigilance needs an API subscription. If credentials are
// missing or the response is stale, show "unavailable" rather than invent colors.
import { getHydroObservations } from './water-sources.mjs';

export const EARLY_SIGNALS_STATION='Y531201001';
export const UPSTREAM_STATIONS=[
 {code:'Y511201001',name:'Carcès · Argens',river:'Argens'},
 {code:'Y530501501',name:'Le Muy · Argens',river:'Argens'},
 {code:'Y520201001',name:'Les Arcs · Aille',river:'Aille'},
 {code:'Y523501002',name:'Trans-en-Provence · Nartuby',river:'Nartuby'},
 {code:'Y521502002',name:'Vidauban · Endre',river:'Endre'}
];
// Representative grid points, *not* a watershed-wide rainfall measurement.
export const RAIN_AREAS=[
 {id:'central',name:'Argens central',lat:43.48,lon:6.18},
 {id:'nartuby',name:'Nartuby',lat:43.53,lon:6.46},
 {id:'lower',name:'Roquebrune',lat:43.44,lon:6.64}
];
const METEO_TOKEN='https://portail-api.meteofrance.fr/token';
const METEO_VIGILANCE='https://public-api.meteofrance.fr/public/DPVigilance/v1/cartevigilance/encours';
const OFFICIAL_LINK='https://vigilance.meteofrance.fr/fr/var';
const MAX_RESULT_AGE=25*60*1000;
let cachedToken=null;

export function parseUpstreamPoints(points,now=Date.now()){
 if(!Array.isArray(points)||points.length<2)throw Error('Insufficient upstream observations');
 const sorted=points.filter(p=>Number.isFinite(p?.time)&&Number.isFinite(p?.mm)).sort((a,b)=>b.time-a.time);
 const last=sorted[0];
 if(!last||last.time>now+15*60000||now-last.time>3*3600000||last.mm< -5000||last.mm>30000)throw Error('Stale upstream observations');
 const ref=sorted.find(p=>last.time-p.time>=30*60000&&last.time-p.time<=180*60000);
 const trend=ref?(last.mm-ref.mm)/10/((last.time-ref.time)/3600000):null;
 return {
  status:'current',levelM:Math.round(last.mm/10)/100,
  trendCmH:Number.isFinite(trend)?Math.round(trend*10)/10:null,
  observedAt:new Date(last.time).toISOString()
 };
}
export async function fetchUpstreamStation(station,{now=Date.now(),fetchImpl=fetch}={}){
 try{
  const result=await getHydroObservations(station.code,{limit:80,fetchImpl});
  const parsed=parseUpstreamPoints(result.points,now);
  return {...station,...parsed,source:result.source};
 }catch(error){
  return {...station,status:'unavailable',levelM:null,trendCmH:null,observedAt:null,source:null};
 }
}
export function parseRainEstimate(data,now=Date.now()){
 const times=data?.hourly?.time,values=data?.hourly?.precipitation;
 if(!Array.isArray(times)||!Array.isArray(values)||times.length!==values.length)throw Error('Missing precipitation series');
 const rows=times.map((t,i)=>({t:typeof t==='number'?t*1000:NaN,v:typeof values[i]==='number'?values[i]:NaN}))
  .filter(x=>Number.isFinite(x.t)&&Number.isFinite(x.v)&&x.v>=0&&x.v<=300&&x.t<=now&&x.t>=now-8*3600000);
 const last3=rows.filter(x=>x.t>now-3*3600000),last6=rows.filter(x=>x.t>now-6*3600000);
 if(last3.length<2||last6.length<4)throw Error('Incomplete recent rainfall estimate');
 const sum=xs=>Math.round(xs.reduce((v,x)=>v+x.v,0)*10)/10;
 return {status:'estimated',last3hMm:sum(last3),last6hMm:sum(last6),latestHour:new Date(Math.max(...rows.map(x=>x.t))).toISOString()};
}
export async function fetchRainArea(area,{now=Date.now(),fetchImpl=fetch}={}){
 try{
  const params=new URLSearchParams({
   latitude:String(area.lat),longitude:String(area.lon),
   hourly:'precipitation',past_hours:'8',forecast_hours:'1',
   timezone:'UTC',timeformat:'unixtime'
  });
  const response=await fetchImpl('https://api.open-meteo.com/v1/forecast?'+params,{
   headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000),cf:{cacheTtl:300}
  });
  if(!response.ok)throw Error('Model precipitation unavailable');
  return {id:area.id,name:area.name,...parseRainEstimate(await response.json(),now)};
 }catch(error){
  return {id:area.id,name:area.name,status:'unavailable',last3hMm:null,last6hMm:null,latestHour:null};
 }
}
const PHENOMENA={
 '1':{fr:'Vent',en:'Wind'},
 '2':{fr:'Pluie-inondation',en:'Rain and flooding'},
 '3':{fr:'Orages',en:'Thunderstorms'},
 '4':{fr:'Crues',en:'River flooding'},
 '5':{fr:'Neige-verglas',en:'Snow and ice'},
 '6':{fr:'Canicule',en:'Heatwave'},
 '7':{fr:'Grand froid',en:'Extreme cold'},
 '8':{fr:'Avalanches',en:'Avalanches'},
 '9':{fr:'Vagues-submersion',en:'Coastal flooding'}
};
const COLORS=['','green','yellow','orange','red'];
function color(value){
 const num=Number(value);
 return Number.isInteger(num)&&num>=1&&num<=4?COLORS[num]:null;
}
export function parseMeteoVigilance(data,{now=Date.now()}={}){
 const product=data?.product;
 if(!product||typeof product.update_time!=='string'||!Array.isArray(product.periods))throw Error('Invalid Meteo-France product');
 const published=Date.parse(product.update_time);
 if(!Number.isFinite(published)||published>now+20*60000||now-published>24*3600000)throw Error('Outdated Meteo-France bulletin');
 const periods=product.periods.map(p=>{
  const from=Date.parse(p.begin_validity_time),to=Date.parse(p.end_validity_time);
  if(!Number.isFinite(from)||!Number.isFinite(to)||to<now-3*3600000||from>now+48*3600000)return null;
  const departments=p.timelaps?.domain_ids;
  const varDepartment=Array.isArray(departments)?departments.find(d=>String(d.domain_id)==='83'):null;
  if(!varDepartment)return null;
  const phenomena=(varDepartment.phenomenon_items||[]).flatMap(item=>{
   const label=PHENOMENA[String(item.phenomenon_id)],severity=color(item.phenomenon_max_color_id);
   return label&&severity?[{id:String(item.phenomenon_id),...label,color:severity}]:[];
  });
  const overall=color(varDepartment.max_color_id);
  if(!overall)return null;
  return {period:String(p.echeance||''),begin:new Date(from).toISOString(),
   end:new Date(to).toISOString(),color:overall,phenomena};
 }).filter(Boolean);
 if(!periods.length)throw Error('No valid Var vigilance period');
 return {status:'official',provider:'Météo-France',department:'83',updatedAt:new Date(published).toISOString(),periods,link:OFFICIAL_LINK};
}
async function fetchMeteoToken(basic,fetchImpl,now){
 if(cachedToken?.basic===basic&&cachedToken?.until>now+120000)return cachedToken.value;
 const response=await fetchImpl(METEO_TOKEN,{
  method:'POST',
  headers:{Authorization:'Basic '+basic,'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},
  body:'grant_type=client_credentials',signal:AbortSignal.timeout(9000)
 });
 if(!response.ok)throw Error('token_http_'+response.status);
 const reply=await response.json();
 if(typeof reply.access_token!=='string'||reply.access_token.length<10)throw Error('token_missing');
 const age=Math.min(3300,Math.max(60,Number(reply.expires_in)||3600));
 cachedToken={basic,value:reply.access_token,until:now+age*1000};
 return cachedToken.value;
}
export async function fetchOfficialVigilance(env,{now=Date.now(),fetchImpl=fetch}={}){
 const fallback={status:env?.METEO_FRANCE_BASIC?'unavailable':'not_configured',provider:'Météo-France',department:'83',periods:[],link:OFFICIAL_LINK};
 if(!env?.METEO_FRANCE_BASIC)return fallback;
 try{
  const token=await fetchMeteoToken(env.METEO_FRANCE_BASIC,fetchImpl,now);
  const response=await fetchImpl(METEO_VIGILANCE,{headers:{Authorization:'Bearer '+token,Accept:'application/json'},
   signal:AbortSignal.timeout(12000),cf:{cacheTtl:600}});
  if(!response.ok)throw Error('bulletin_http_'+response.status);
  return parseMeteoVigilance(await response.json(),{now});
 }catch(error){
  // Only fixed diagnostic codes are exposed; credentials, response bodies and tokens never are.
  const message=String(error?.message||'');
  const code=/^(?:token_http|bulletin_http)_\d{3}$/.test(message)?message
   :message==='token_missing'?'token_missing'
   :message==='Invalid Meteo-France product'?'invalid_bulletin'
   :message==='Outdated Meteo-France bulletin'?'outdated_bulletin'
   :message==='No valid Var vigilance period'?'missing_var_period'
   :'request_or_format_error';
  console.warn('Meteo-France vigilance unavailable:',code);
  return {...fallback,diagnostic:code};
 }
}
export async function buildEarlySignals(env,{now=Date.now(),fetchImpl=fetch}={}){
 const [upstream,rain,official]=await Promise.all([
  Promise.all(UPSTREAM_STATIONS.map(x=>fetchUpstreamStation(x,{now,fetchImpl}))),
  Promise.all(RAIN_AREAS.map(x=>fetchRainArea(x,{now,fetchImpl}))),
  fetchOfficialVigilance(env,{now,fetchImpl})
 ]);
 return {ok:true,station:EARLY_SIGNALS_STATION,checkedAt:new Date(now).toISOString(),
  upstream,rain,official,
  radar:{status:'not_connected',provider:'Météo-France',source:'actual_radar',note:'Requires API access and validated radar processing'},
  interpretation:'information_only',changesFloodThresholds:false,
  rainSource:'Open-Meteo past-hour model estimates; not measured rain or calibrated radar'};
}
async function ensureTable(db){
 await db.prepare('CREATE TABLE IF NOT EXISTS early_signals (station_code TEXT PRIMARY KEY, checked_ms INTEGER NOT NULL, payload TEXT NOT NULL)').run();
}
export async function refreshEarlySignals(env,{now=Date.now(),fetchImpl=fetch}={}){
 if(!env?.DB)throw Error('D1 unavailable');
 const result=await buildEarlySignals(env,{now,fetchImpl});
 await ensureTable(env.DB);
 await env.DB.prepare('INSERT INTO early_signals(station_code,checked_ms,payload) VALUES(?,?,?) ON CONFLICT(station_code) DO UPDATE SET checked_ms=excluded.checked_ms,payload=excluded.payload')
  .bind(EARLY_SIGNALS_STATION,now,JSON.stringify(result)).run();
 return result;
}
export async function loadEarlySignals(db,{now=Date.now()}={}){
 if(!db)throw Error('D1 unavailable');
 await ensureTable(db);
 const row=await db.prepare('SELECT checked_ms,payload FROM early_signals WHERE station_code=?').bind(EARLY_SIGNALS_STATION).first();
 if(!row||!Number.isSafeInteger(row.checked_ms)||row.checked_ms>now+60000||now-row.checked_ms>MAX_RESULT_AGE)throw Error('Early indicator snapshot unavailable or stale');
 const result=JSON.parse(row.payload);
 if(result?.station!==EARLY_SIGNALS_STATION||result?.ok!==true)throw Error('Invalid early indicator snapshot');
 return result;
}
