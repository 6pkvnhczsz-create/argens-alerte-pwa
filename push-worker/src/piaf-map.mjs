// Official Météo-France PIAF WMS forecast. Informational only:
// NEVER use this module to change water-level thresholds, warning colours or push.
import { validateBounds } from './piaf-station.mjs';
import {DEFAULT_BOUNDS} from './piaf-station.mjs';
import {fetchMeteoToken} from './early-signals.mjs';
export const PIAF_BOUNDS=DEFAULT_BOUNDS; // west,south,east,north; enlarged Argens default
export const PIAF_LAYER='TOTAL_PRECIPITATION_RATE__GROUND_OR_WATER_SURFACE';
const BASE='https://api.meteofrance.fr/pro/piaf/1.0/wms/MF-NWP-HIGHRES-PIAF-001-FRANCE-WMS/';
const PUBLIC_BASE='https://public-api.meteofrance.fr/public/piaf/1.0/wms/MF-NWP-HIGHRES-PIAF-001-FRANCE-WMS/';
const BASES=[BASE,PUBLIC_BASE];
const FIVE_MIN=300000;
const MAX_XML=3000000;
const MAX_PNG=1500000;
const iso=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const validTime=s=>iso.test(s)&&Number.isFinite(Date.parse(s));
function dimension(section,name){
 const sections=[...section.matchAll(/<(?:Dimension|Extent)\b([^>]*)>([^<]{1,200000})<\/(?:Dimension|Extent)>/gi)];
 const found=sections.find(m=>new RegExp('\\bname=["\\x27]'+name+'["\\x27]','i').test(m[1]));
 if(!found)return null;
 const def=found[1].match(/\bdefault=["']([^"']+)["']/i);
 return {value:found[2].trim(),default:def?.[1]||null};
}
function expandTimes(raw){
 const result=[];
 for(const part of raw.split(',')){
  const value=part.trim();
  if(validTime(value)){result.push(value);continue}
  const interval=value.match(/^([^/]+)\/([^/]+)\/PT5M$/i);
  if(!interval||!validTime(interval[1])||!validTime(interval[2]))continue;
  const from=Date.parse(interval[1]),to=Date.parse(interval[2]);
  if(to<from||to-from>5*86400000)continue;
  for(let ms=from;ms<=to&&result.length<10000;ms+=FIVE_MIN)result.push(new Date(ms).toISOString().replace('.000Z','Z'));
 }
 return [...new Set(result)].sort();
}
function readLayer(xml,name){
 const m=new RegExp('<Name>\\s*'+name+'\\s*</Name>','i').exec(xml);
 if(!m)throw Error('PIAF precipitation layer unavailable');
 const from=xml.lastIndexOf('<Layer',m.index),end=xml.indexOf('</Layer>',m.index);
 if(from<0||end<0)throw Error('PIAF malformed layer');
 return xml.slice(from,end+8);
}
export function parsePiafCapabilities(xml,{now=Date.now()}={}){
 if(typeof xml!=='string'||xml.length>MAX_XML||!/WMS_Capabilities|WMT_MS_Capabilities/.test(xml))throw Error('Invalid PIAF catalogue');
 const section=readLayer(xml,PIAF_LAYER);
 const ref=dimension(section,'reference_time'),valid=dimension(section,'time');
 if(!ref||!valid)throw Error('PIAF forecast times unavailable');
 const referenceTimes=expandTimes(ref.value);
 const referenceTime=validTime(ref.default)?ref.default:referenceTimes[referenceTimes.length-1];
 const referenceMs=Date.parse(referenceTime);
 if(!Number.isFinite(referenceMs)||referenceMs>now+600000||now-referenceMs>75*60000)throw Error('PIAF model run unavailable or old');
 const frames=expandTimes(valid.value).filter(t=>{
  const ms=Date.parse(t);
  return ms>=now-2*60000&&ms<=now+180*60000&&ms>referenceMs&&ms<=referenceMs+180*60000;
 }).slice(0,37);
 if(!frames.length)throw Error('No current PIAF forecast frames');
 const styles=[...section.matchAll(/<Style\b[^>]*>[\s\S]*?<Name>\s*([A-Z0-9_]+)\s*<\/Name>[\s\S]*?<\/Style>/gi)]
  .map(m=>m[1]).filter(x=>/^[A-Z0-9_]{3,100}$/.test(x));
 const style=styles.find(x=>/RADAR_SYNERGIE_SHADING/.test(x))||
  styles.find(x=>/RADAR_SHADING/.test(x))||
  styles.find(x=>/SHADING/.test(x)&&!/NO_SHADING/.test(x));
 if(!style)throw Error('No PIAF coloured WMS style');
 return {source:'Météo-France PIAF',kind:'forecast_5min',bounds:PIAF_BOUNDS,
  referenceTime,frames,layer:PIAF_LAYER,style,intervalMinutes:5,notFloodForecast:true};
}
function apiKey(env){return env.METEO_FRANCE_PIAF_API_KEY||env.METEO_FRANCE_API_KEY}
function allowedBase(meta){return BASES.includes(meta?.wmsBase)?meta.wmsBase:BASE}
// The public Météo-France gateway may require a Bearer token while a legacy
// gateway accepts the API key. Both credentials remain server-side only.
async function requestPiaf(env,url,accept,fetchImpl,timeout,preferred='key'){
 const key=apiKey(env),basic=env?.METEO_FRANCE_BASIC;
 const modes=[...(key?['key']:[]),...(basic?['oauth']:[])];
 if(!modes.length)throw Error('PIAF key unavailable');
 if(preferred==='oauth')modes.reverse();
 let last=null;
 for(const mode of modes){
  try{
   const headers={Accept:accept};
   if(mode==='key')headers.apikey=key;
   else headers.Authorization='Bearer '+await fetchMeteoToken(basic,fetchImpl,Date.now());
   const response=await fetchImpl(url,{headers,redirect:'manual',
    signal:AbortSignal.timeout(timeout),cf:{cacheTtl:0}});
   if(response.ok&&!response.redirected)return {response,authMethod:mode};
   last=Error('PIAF HTTP '+response.status);
   if(![401,403].includes(response.status))throw last;
  }catch(error){last=error}
 }
 throw last||Error('PIAF fetch unavailable');
}
export async function fetchPiafMetadata(env,{fetchImpl=fetch,now=Date.now()}={}){
 let last=null;
 for(const base of BASES){
  try{
   const result=await requestPiaf(env,base+'GetCapabilities?service=WMS&version=1.3.0',
    'application/xml',fetchImpl,12000);
   const res=result.response;
   const type=String(res.headers?.get?.('content-type')||'').toLowerCase();
   if(!type.includes('xml'))throw Error('PIAF capabilities are not XML');
   if(Number(res.headers?.get?.('content-length'))>MAX_XML)throw Error('PIAF catalogue too large');
   const xml=await res.text();
   const parsed=parsePiafCapabilities(xml,{now});
   return {...parsed,wmsBase:base,authMethod:result.authMethod};
  }catch(error){last=error}
 }
 throw last||Error('PIAF metadata unavailable');
}
export function buildPiafMapUrl(meta,time,bounds=PIAF_BOUNDS){
 validateBounds(bounds);
 if(!meta.frames.includes(time)||!validTime(time)||!validTime(meta.referenceTime))throw Error('Unlisted PIAF frame');
 if(meta.layer!==PIAF_LAYER||!/^[A-Z0-9_]{3,100}$/.test(meta.style))throw Error('Invalid PIAF style');
 const params=new URLSearchParams({service:'WMS',version:'1.3.0',crs:'EPSG:4326',
  layers:meta.layer,reference_time:meta.referenceTime,time,
  bbox:[bounds[1],bounds[0],bounds[3],bounds[2]].join(','),format:'image/png',height:'500',width:'720',
  transparent:'true',styles:meta.style});
 return allowedBase(meta)+'GetMap?'+params.toString();
}
export async function fetchPiafFrame(env,meta,time,{fetchImpl=fetch,bounds=PIAF_BOUNDS}={}){
 const url=buildPiafMapUrl(meta,time,bounds);
 const {response}=await requestPiaf(env,url,'image/png',fetchImpl,24000,meta?.authMethod);
 if(!String(response.headers.get('content-type')||'').toLowerCase().startsWith('image/png'))
  throw Error('PIAF returned no PNG');
 if(Number(response.headers.get('content-length'))>MAX_PNG)throw Error('PIAF PNG too large');
 const data=new Uint8Array(await response.arrayBuffer());
 if(data.length<60||data.length>MAX_PNG||![137,80,78,71,13,10,26,10].every((x,i)=>x===data[i]))
  throw Error('PIAF map is not PNG');
 const uint32=i=>((data[i]*16777216)+(data[i+1]<<16)+(data[i+2]<<8)+data[i+3])>>>0;
 if(uint32(16)!==720||uint32(20)!==500)throw Error('PIAF PNG dimensions do not match');
 return data;
}

// The legend is obtained from the SAME official PIAF WMS style as the map.
// Do not invent palette breakpoints: WMS style definitions may change.
export function buildPiafLegendUrl(meta){
 if(meta.layer!==PIAF_LAYER||!/^[A-Z0-9_]{3,100}$/.test(meta.style))
  throw Error('Invalid PIAF legend style');
 const query=new URLSearchParams({
  service:'WMS',version:'1.3.0',request:'GetLegendGraphic',
  layer:meta.layer,style:meta.style,format:'image/png'
 });
 return allowedBase(meta)+'GetLegendGraphic?'+query;
}

function officialStyleLegendUrl(xml,style,base=BASE){
 const styles=[...xml.matchAll(/<Style\b[^>]*>([\s\S]*?)<\/Style>/gi)];
 for(const entry of styles){
  const fragment=entry[1],name=fragment.match(/<Name>\s*([A-Z0-9_]+)\s*<\/Name>/i)?.[1];
  if(name!==style)continue;
  const legend=fragment.match(/<LegendURL\b[^>]*>([\s\S]*?)<\/LegendURL>/i)?.[1];
  const href=legend?.match(/<(?:\w+:)?OnlineResource\b[^>]*?(?:xlink:href|href)\s*=\s*["']([^"']+)["']/i)?.[1];
  if(!href)continue;
  try{
   const url=new URL(href.replace(/&amp;/g,'&'),base);
   if(url.protocol!=='https:'||url.username||url.password||
     !['api.meteofrance.fr','public-api.meteofrance.fr','geoservices.meteofrance.fr','geoservices.meteo.fr'].includes(url.hostname)||
     [...url.searchParams.keys()].some(key=>/secret|token|api.?key|authorization/i.test(key)))continue;
   return url.toString();
  }catch{}
 }
 return null;
}
async function getLegendPng(env,url,fetchImpl,preferred='key'){
 const parsed=new URL(url);
 if(!['api.meteofrance.fr','public-api.meteofrance.fr',
  'geoservices.meteofrance.fr','geoservices.meteo.fr'].includes(parsed.hostname))
  throw Error('Untrusted PIAF legend host');
 const {response}=await requestPiaf(env,url,'image/png',fetchImpl,18000,preferred);
 if(!String(response.headers.get('content-type')||'').toLowerCase().startsWith('image/png'))
  throw Error('PIAF legend is not PNG');
 if(Number(response.headers.get('content-length'))>MAX_PNG)throw Error('PIAF legend too large');
 const data=new Uint8Array(await response.arrayBuffer());
 if(data.length<70||data.length>MAX_PNG||
  ![137,80,78,71,13,10,26,10].every((x,i)=>x===data[i]))
  throw Error('PIAF legend format invalid');
 return data;
}
export async function fetchPiafLegend(env,meta,{fetchImpl=fetch}={}){
 const fallback=buildPiafLegendUrl(meta);
 try{return await getLegendPng(env,fallback,fetchImpl,meta?.authMethod)}
 catch(firstError){
  // Try the publisher's official LegendURL from the same validated catalogue.
  let res;
  try{
   res=(await requestPiaf(env,allowedBase(meta)+'GetCapabilities?service=WMS&version=1.3.0',
    'application/xml',fetchImpl,16000,meta?.authMethod)).response;
  }catch{throw firstError}
  if(!String(res.headers.get('content-type')||'').toLowerCase().includes('xml'))
   throw firstError;
  if(Number(res.headers.get('content-length'))>MAX_XML)throw firstError;
  const xml=await res.text();
  if(xml.length>MAX_XML)throw firstError;
  const styleUrl=officialStyleLegendUrl(xml,meta.style,allowedBase(meta));
  if(!styleUrl||styleUrl===fallback)throw firstError;
  return getLegendPng(env,styleUrl,fetchImpl,meta?.authMethod);
 }
}
