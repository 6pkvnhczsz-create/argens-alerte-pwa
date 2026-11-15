// Rivière Alerte: independent *informational* early indicators, never alter
// users' station thresholds, risk levels, or existing flood-push decisions.
// Météo-France official vigilance needs an API subscription. If credentials are
// missing or the response is stale, show "unavailable" rather than invent colors.
import { getHydroObservations } from './water-sources.mjs';

export const EARLY_SIGNALS_STATION='Y531201001';
export const UPSTREAM_STATIONS=[
 {code:'Y511201001',name:'Carcès · Argens',river:'Argens'},
 {code:'Y530501501',name:'Le Muy · Endre',river:'Endre'},
 {code:'Y520201001',name:'Les Arcs · Argens',river:'Argens'},
 {code:'Y523501002',name:'Trans-en-Provence · Nartuby',river:'Nartuby'},
 {code:'Y521502002',name:'Vidauban · Aille',river:'Aille'}
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
const MAX_UPSTREAM_OBSERVATION_AGE=90*60*1000; // Allow hourly gauges, reject outdated readings.
let cachedToken=null;

export function parseUpstreamPoints(points,now=Date.now()){
 if(!Array.isArray(points)||points.length<2)throw Error('Insufficient upstream observations');
 const sorted=points.filter(p=>Number.isFinite(p?.time)&&Number.isFinite(p?.mm)).sort((a,b)=>b.time-a.time);
 const last=sorted[0];
 if(!last||last.time>now+15*60000||now-last.time>MAX_UPSTREAM_OBSERVATION_AGE||last.mm< -5000||last.mm>30000)throw Error('Stale upstream observations');
 const ref=sorted.find(p=>last.time-p.time>=30*60000&&last.time-p.time<=180*60000);
 if(!ref)throw Error('No recent upstream trend baseline');
 const trend=(last.mm-ref.mm)/10/((last.time-ref.time)/3600000);
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

/**
 * Forecast accumulations are model predictions, never measured rainfall.
 * The dedicated Open-Meteo Météo-France endpoint serves AROME/ARPEGE model
 * output without granting access to Météo-France's separate AROME API.
 */
export function parseRainForecast(data,now=Date.now()){
 const times=data?.hourly?.time,values=data?.hourly?.precipitation;
 if(!Array.isArray(times)||!Array.isArray(values)||times.length!==values.length)throw Error('Missing forecast precipitation series');
 const rows=times.map((t,i)=>({
  t:typeof t==='number'?t*1000:Date.parse(t),
  mm:values[i]
 })).filter(x=>Number.isFinite(x.t)&&typeof x.mm==='number'&&Number.isFinite(x.mm)&&x.mm>=0&&x.mm<=300&&x.t>now&&x.t<=now+25*3600000)
   .sort((a,b)=>a.t-b.t);
 if(!rows.length||rows[0].t>now+90*60000||rows[rows.length-1].t<now+23*3600000)throw Error('Incomplete forecast horizon');
 const first6=rows.filter(x=>x.t<=now+6*3600000),first24=rows.filter(x=>x.t<=now+24*3600000);
 if(first6.length<5||first24.length<23)throw Error('Incomplete forecast precipitation');
 const mm=xs=>Math.round(xs.reduce((total,x)=>total+x.mm,0)*10)/10;
 return {status:'forecast',next6hMm:mm(first6),next24hMm:mm(first24),firstHour:new Date(rows[0].t).toISOString(),lastHour:new Date(first24.at(-1).t).toISOString()};
}
export async function fetchRainForecast(area,{now=Date.now(),fetchImpl=fetch}={}){
 try{
  const params=new URLSearchParams({
   latitude:String(area.lat),longitude:String(area.lon),hourly:'precipitation',
   forecast_hours:'30',timezone:'UTC',timeformat:'unixtime'
  });
  const response=await fetchImpl('https://api.open-meteo.com/v1/meteofrance?'+params,{
   headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000),cf:{cacheTtl:300}
  });
  if(!response.ok)throw Error('Forecast unavailable');
  return {id:area.id,name:area.name,...parseRainForecast(await response.json(),now)};
 }catch{
  return {id:area.id,name:area.name,status:'unavailable',next6hMm:null,next24hMm:null,firstHour:null,lastHour:null};
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
export function parseMeteoVigilance(data,{now=Date.now(),department='83',departmentName=''}={}){
 if(typeof department!=='string'||!/^(?:0[1-9]|[1-8][0-9]|9[0-5]|2A|2B)$/.test(department))
  throw Error('Invalid French department');
 const product=data?.product;
 if(!product||typeof product.update_time!=='string'||!Array.isArray(product.periods))throw Error('Invalid Meteo-France product');
 const published=Date.parse(product.update_time);
 if(!Number.isFinite(published)||published>now+20*60000||now-published>24*3600000)throw Error('Outdated Meteo-France bulletin');
 const periods=product.periods.map(p=>{
  const from=Date.parse(p.begin_validity_time),to=Date.parse(p.end_validity_time);
  if(!Number.isFinite(from)||!Number.isFinite(to)||to<now-3*3600000||from>now+48*3600000)return null;
  const departments=p.timelaps?.domain_ids;
  const selected=Array.isArray(departments)?departments.find(d=>{
   const id=String(d.domain_id||'').trim().toUpperCase();
   return (id.length===1&&/^\d$/.test(id)?'0'+id:id)===department;
  }):null;
  if(!selected)return null;
  const phenomena=(selected.phenomenon_items||[]).flatMap(item=>{
   const label=PHENOMENA[String(item.phenomenon_id)],severity=color(item.phenomenon_max_color_id);
   return label&&severity?[{id:String(item.phenomenon_id),...label,color:severity}]:[];
  });
  const overall=color(selected.max_color_id);
  if(!overall)return null;
  return {period:String(p.echeance||''),begin:new Date(from).toISOString(),
   end:new Date(to).toISOString(),color:overall,phenomena};
 }).filter(Boolean);
 if(!periods.length)throw Error('No valid department vigilance period');
 return {status:'official',provider:'Météo-France',department,
  departmentName:String(departmentName||'').slice(0,70),
  updatedAt:new Date(published).toISOString(),periods,
  link:department==='83'?OFFICIAL_LINK:'https://vigilance.meteofrance.fr/fr'};
}
async function fetchMeteoToken(basic,fetchImpl,now){
 if(cachedToken?.basic===basic&&cachedToken?.until>now+120000)return cachedToken.value;
 let response;
 try{response=await fetchImpl(METEO_TOKEN,{
  method:'POST',
  headers:{Authorization:'Basic '+basic,'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},
  body:'grant_type=client_credentials',signal:AbortSignal.timeout(9000)
 })}catch{throw Error('token_fetch_failed')}
 if(!response.ok)throw Error('token_http_'+response.status);
 let reply;
 try{reply=await response.json()}catch{
  // Only classify metadata, never read or expose the response body (which could contain secrets).
  const type=String(response.headers?.get?.('content-type')||'').toLowerCase();
  const redirected=response.redirected===true;
  if(type.includes('text/html'))throw Error(redirected?'token_html_redirect':'token_html_response');
  if(type.includes('text/plain'))throw Error('token_text_response');
  throw Error('token_invalid_json');
 }
 if(typeof reply.access_token!=='string'||reply.access_token.length<10)throw Error('token_missing');
 const age=Math.min(3300,Math.max(60,Number(reply.expires_in)||3600));
 cachedToken={basic,value:reply.access_token,until:now+age*1000};
 return cachedToken.value;
}
export async function fetchOfficialVigilance(env,{now=Date.now(),fetchImpl=fetch,department='83',departmentName=''}={}){
 const configured=Boolean(env?.METEO_FRANCE_BASIC||env?.METEO_FRANCE_API_KEY);
 const fallback={status:configured?'unavailable':'not_configured',provider:'Météo-France',department,
  departmentName:String(departmentName||'').slice(0,70),periods:[],
  link:department==='83'?OFFICIAL_LINK:'https://vigilance.meteofrance.fr/fr'};
 if(!configured)return fallback;
 try{
  // Météo-France accepts an API key directly. Prefer it when configured to avoid
  // token portal HTML/interstitials; preserve existing OAuth2 as a fallback mode.
  const headers=env.METEO_FRANCE_API_KEY?
   {apikey:env.METEO_FRANCE_API_KEY,Accept:'application/json'}:
   {Authorization:'Bearer '+await fetchMeteoToken(env.METEO_FRANCE_BASIC,fetchImpl,now),Accept:'application/json'};
  let response;
  try{response=await fetchImpl(METEO_VIGILANCE,{headers,
   signal:AbortSignal.timeout(12000)})}catch{throw Error('bulletin_fetch_failed')}
  if(!response.ok)throw Error('bulletin_http_'+response.status);
  let bulletin;
  try{bulletin=await response.json()}catch{throw Error('bulletin_invalid_json')}
  return parseMeteoVigilance(bulletin,{now,department,departmentName});
 }catch(error){
  // Only fixed diagnostic codes are exposed; credentials, response bodies and tokens never are.
  const message=String(error?.message||'');
  const code=/^(?:token_http|bulletin_http)_\d{3}$/.test(message)?message
   :['token_fetch_failed','token_invalid_json','token_html_redirect','token_html_response','token_text_response','bulletin_fetch_failed','bulletin_invalid_json'].includes(message)?message
   :message==='token_missing'?'token_missing'
   :message==='Invalid Meteo-France product'?'invalid_bulletin'
   :message==='Outdated Meteo-France bulletin'?'outdated_bulletin'
   :message==='No valid department vigilance period'?'missing_department_period'
   :'request_or_format_error';
  console.warn('Meteo-France vigilance unavailable:',code);
  return {...fallback,diagnostic:code};
 }
}

/**
 * Only checks the official LAME_D_EAU radar product catalogue.
 * Product downloads are BUFR/HDF5 binaries: no mm estimate is inferred
 * from metadata. Any quantitative radar rainfall requires validated grid
 * decoding and geolocation over the Argens catchment.
 */
export async function fetchRadarCatalogue(env,{now=Date.now(),fetchImpl=fetch}={}){
 const base={provider:'Météo-France',source:'radar_LAME_D_EAU',measurementAvailable:false};
 if(!env?.METEO_FRANCE_API_KEY)return {...base,status:'not_configured',observedAt:null};
 let diagnostic='radar_fetch_failed';
 try{
  const response=await fetchImpl('https://public-api.meteofrance.fr/public/DPRadar/v1/mosaiques/METROPOLE/observations/LAME_D_EAU',{
   headers:{apikey:env.METEO_FRANCE_API_KEY,Accept:'application/json'},
   signal:AbortSignal.timeout(12000),cf:{cacheTtl:240}
  });
  // Expose only a fixed diagnostic code, never response bodies, credentials or headers.
  if(!response.ok){
   diagnostic=[401,403,404,429,500,502,503,504].includes(response.status)?
    'radar_http_'+response.status:'radar_http_other';
   throw Error('radar_unavailable');
  }
  diagnostic='radar_invalid_json';
  const data=await response.json();
  const timestamps=[];
  function walk(v,depth=0){
   if(depth>5||!v||typeof v!=='object')return;
   if(typeof v.validity_time==='string')timestamps.push(Date.parse(v.validity_time));
   if(Array.isArray(v)){for(const item of v.slice(0,100))walk(item,depth+1)}
   else{for(const value of Object.values(v).slice(0,60))walk(value,depth+1)}
  }
  walk(data);
  diagnostic='radar_stale_or_missing_timestamp';
  const newest=Math.max(...timestamps.filter(t=>Number.isFinite(t)&&t<=now+10*60000));
  if(!Number.isFinite(newest)||now-newest>30*60000)throw Error('radar_unavailable');
  return {...base,status:'catalogue_only',observedAt:new Date(newest).toISOString()};
 }catch{
  return {...base,status:'unavailable',observedAt:null,diagnostic};
 }
}

export async function buildEarlySignals(env,{now=Date.now(),fetchImpl=fetch}={}){
 const [upstream,rain,forecast,official,radar]=await Promise.all([
  Promise.all(UPSTREAM_STATIONS.map(x=>fetchUpstreamStation(x,{now,fetchImpl}))),
  Promise.all(RAIN_AREAS.map(x=>fetchRainArea(x,{now,fetchImpl}))),
  Promise.all(RAIN_AREAS.map(x=>fetchRainForecast(x,{now,fetchImpl}))),
  fetchOfficialVigilance(env,{now,fetchImpl}),
  fetchRadarCatalogue(env,{now,fetchImpl})
 ]);
 // Check all candidate stations, but only expose gauges with recent usable measurements.
 const availableUpstream=upstream.filter(x=>x.status==='current'&&Number.isFinite(x.trendCmH)&&Number.isFinite(x.levelM));
 return {ok:true,station:EARLY_SIGNALS_STATION,checkedAt:new Date(now).toISOString(),
  upstream:availableUpstream,upstreamStationsChecked:UPSTREAM_STATIONS.length,rain,forecast,official,radar,
  interpretation:'information_only',changesFloodThresholds:false,
  rainSource:'Open-Meteo past-hour model estimates; not measured rain or calibrated radar',
  forecastSource:'Météo-France AROME/ARPEGE model forecast via Open-Meteo; not measured rain'};
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
