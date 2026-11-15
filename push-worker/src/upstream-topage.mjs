// Verified *local* upstream connectivity for French hydrometric stations.
// Official BD TOPAGE 2025 segment direction + topological node links.
// Never treat proximity or river name alone as upstream connectivity.
// This information is for map display ONLY, never for alarms or forecasting.
import {cachedStation,validStationCode} from './piaf-station.mjs';
const WFS='https://services.sandre.eaufrance.fr/geo/topage2025';
const REG='https://hubeau.eaufrance.fr/api/v2/hydrometrie/referentiel/stations';
const OBS='https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr';
const MAX_EDGES=4500,MAX_BYTES=9500000,MAX_STATIONS=800;
export const NEARBY_RADIUS_KM=40;
const MAX_CORRIDOR_PAGES=8; // bounded targeted network expansion, not full catchment
const MAX_PROBE_TARGETS=3;
const kmPerDegree=111.2;
function delta(lat){return {y:0.045,x:0.045/Math.max(0.55,Math.cos(lat*Math.PI/180))}}
export function distanceKm(latA,lonA,latB,lonB){
 const p=Math.PI/180,dlat=(latB-latA)*p,dlon=(lonB-lonA)*p;
 const a=Math.sin(dlat/2)**2+Math.cos(latA*p)*Math.cos(latB*p)*Math.sin(dlon/2)**2;
 return 12742*Math.asin(Math.min(1,Math.sqrt(a)));
}
export function nearbyBbox(lat,lon,radiusKm=NEARBY_RADIUS_KM){
 const dy=radiusKm/kmPerDegree,dx=dy/Math.max(.45,Math.cos(lat*Math.PI/180));
 return [lon-dx,lat-dy,lon+dx,lat+dy].map(x=>x.toFixed(5)).join(',');
}
export function localBboxes(lat,lon){
 const d=delta(lat);
 const bounds=[lon-d.x,lat-d.y,lon+d.x,lat+d.y];
 return {hubeau:bounds.map(n=>n.toFixed(5)).join(','),
  // WFS 2 EPSG:4326 uses latitude/longitude axis order (verified against Topage).
  topage:[bounds[1],bounds[0],bounds[3],bounds[2],'EPSG:4326'].map((n,i)=>i===4?n:Number(n).toFixed(5)).join(',')};
}
const isPoint=p=>Array.isArray(p)&&p.length>=2&&Number.isFinite(p[0])&&Number.isFinite(p[1]);
function segmentDistance(point,line){
 if(!Array.isArray(line)||line.length<2||!isPoint(point))return null;
 const cosine=Math.cos(point[1]*Math.PI/180);
 let best={km:Infinity,fraction:0};let cumulative=0;
 for(let i=1;i<line.length;i++){
  const a=line[i-1],b=line[i];if(!isPoint(a)||!isPoint(b))return null;
  const dx=(b[0]-a[0])*cosine*kmPerDegree,dy=(b[1]-a[1])*kmPerDegree;
  const px=(point[0]-a[0])*cosine*kmPerDegree,py=(point[1]-a[1])*kmPerDegree;
  const length=Math.hypot(dx,dy);if(length<=0)continue;
  const t=Math.max(0,Math.min(1,(px*dx+py*dy)/(length*length)));
  const km=Math.hypot(px-dx*t,py-dy*t);
  if(km<best.km)best={km,fraction:cumulative+length*t};
  cumulative+=length;
 }
 return best.km===Infinity?null:{km:best.km,fraction:best.fraction,lengthKm:cumulative};
}
function directedFeature(feature){
 const p=feature?.properties||{},geometry=feature?.geometry;
 if(geometry?.type!=='LineString'||!Array.isArray(geometry.coordinates))return null;
 const first=String(p.CdNoeudDebut||''),last=String(p.CdNoeudFin||'');
 const sense=String(p.SensEcoulementTH||'').toLocaleLowerCase('fr-FR');
 if(!first||!last||first===last)return null;
 let from,to,coords;
 if(sense.includes('dans direction tronçon')||sense.includes('dans la direction')){
  from=first;to=last;coords=geometry.coordinates;
 }else if(sense.includes('contre')&&sense.includes('direction')){
  from=last;to=first;coords=[...geometry.coordinates].reverse();
 }else return null; // no confirmed flow direction
 if(coords.length<2||coords.length>2000||!coords.every(isPoint))return null;
 return {from,to,coords};
}
function snap(point,edges,limitKm){
 const hits=[];
 for(let i=0;i<edges.length;i++){
  const distance=segmentDistance(point,edges[i].coords);
  if(distance&&distance.km<=limitKm)hits.push({...distance,index:i});
 }
 hits.sort((a,b)=>a.km-b.km);
 if(!hits.length)return null;
 // Parallel channels / separate nearby rivers can be ambiguous; fail closed
 // unless both nearest edges actually share a network node.
 if(hits.length>1&&hits[1].km-hits[0].km<.025){
  const one=edges[hits[0].index],two=edges[hits[1].index];
  if(![two.from,two.to].includes(one.from)&&![two.from,two.to].includes(one.to))return null;
 }
 return hits[0];
}
export function connectedUpstream(home,candidates,features,{maxStations=8}={}){
 const edges=(features||[]).map(directedFeature).filter(Boolean);
 if(!edges.length)throw Error('No directed Topage river segments');
 const homePoint=[home.lon,home.lat],homeSnap=snap(homePoint,edges,.35);
 if(!homeSnap)throw Error('Home gauge not mapped to directed river graph');
 const byEnd=new Map();
 for(let i=0;i<edges.length;i++){
  const list=byEnd.get(edges[i].to)||[];list.push(i);byEnd.set(edges[i].to,list);
 }
 // Directed walk in reverse flow direction: from the target segment
 // backwards along its upstream node. No geographical-distance shortcut.
 const connected=new Map([[homeSnap.index,homeSnap.fraction<.005?0:homeSnap.fraction]]);
 const queue=[edges[homeSnap.index].from],seen=new Set(queue);
 for(let i=0;i<queue.length&&queue.length<MAX_EDGES;i++){
  const node=queue[i];
  for(const index of byEnd.get(node)||[]){
   if(index===homeSnap.index||connected.has(index))continue;
   connected.set(index,1+i);
   const other=edges[index].from;
   if(!seen.has(other)){seen.add(other);queue.push(other)}
  }
 }
 const verified=[];
 for(const station of candidates||[]){
  if(!validStationCode(station.code)||station.code===home.code)continue;
  if(!Number.isFinite(station.lon)||!Number.isFinite(station.lat))continue;
  const hit=snap([station.lon,station.lat],edges,.18);
  if(!hit||!connected.has(hit.index))continue;
  // Same segment requires the candidate to lie physically upstream of home.
  if(hit.index===homeSnap.index&&hit.fraction>=homeSnap.fraction-.04)continue;
  verified.push({...station,graphHops:connected.get(hit.index),snapKm:hit.km});
 }
 verified.sort((a,b)=>a.graphHops-b.graphHops||a.snapKm-b.snapKm||a.code.localeCompare(b.code));
 return verified.slice(0,Math.max(0,Math.min(maxStations,10)));
}
async function publicJson(url,{fetchImpl=fetch,maxBytes=MAX_BYTES}={}){
 const res=await fetchImpl(url,{headers:{Accept:'application/json'},redirect:'manual',
  signal:AbortSignal.timeout(17000),cf:{cacheTtl:600}});
 if(!res.ok||res.redirected)throw Error('Official source HTTP '+res.status);
 if(Number(res.headers.get('content-length'))>maxBytes)throw Error('Source exceeds maximum size');
 const raw=await res.text();if(raw.length>maxBytes)throw Error('Source exceeds maximum size');
 let json;try{json=JSON.parse(raw)}catch{throw Error('Official source returned incomplete JSON')}
 return json;
}
function wfsUrl(bbox){
 const wfs=new URL(WFS);
 for(const [k,v] of Object.entries({service:'WFS',version:'2.0.0',request:'GetFeature',
  typeNames:'sa:TronconHydrographique_FXX_Topage2025',count:String(MAX_EDGES),
  srsName:'EPSG:4326',bbox,outputFormat:'geojson'}))wfs.searchParams.set(k,v);
 return wfs.toString();
}
function verifiedGraph(data){
 if(!Array.isArray(data?.features)||data.features.length>=MAX_EDGES||
  (Number.isFinite(Number(data.numberMatched))&&Number(data.numberMatched)>data.features.length))
  throw Error('Truncated hydrological network');
 return data.features;
}
function corridorProbes(home,candidates){
 const found=new Map(),radius=NEARBY_RADIUS_KM;
 // A limited set of 9-km square WFS tiles follows straight corridors to nearby
 // candidate gauges. Only exact directed node connectivity can confirm upstream.
 // Meandering paths outside this corridor remain UNVERIFIED, never guessed.
 const latStep=.08,lonStep=.08/Math.cos(home.lat*Math.PI/180);
 for(const st of candidates.slice(0,MAX_PROBE_TARGETS)){
  const d=distanceKm(home.lat,home.lon,st.lat,st.lon);
  if(d<5||d>radius)continue;
  const steps=Math.min(18,Math.ceil(d/4));
  for(let i=0;i<=steps;i++){
   const t=i/steps,lat=home.lat+(st.lat-home.lat)*t,lon=home.lon+(st.lon-home.lon)*t;
   const row=Math.floor(lat/latStep),col=Math.floor(lon/lonStep),key=row+':'+col;
   if(!found.has(key)){
    const y=(row+.5)*latStep,x=(col+.5)*lonStep,box=localBboxes(y,x).topage;
    found.set(key,box);
   }
   if(found.size>=MAX_CORRIDOR_PAGES)return [...found.values()];
  }
 }
 return [...found.values()];
}
export async function findLocalUpstream(code,{fetchImpl=fetch}={}){
 const home=await cachedStation(code,{fetchImpl});
 const bboxes=localBboxes(home.lat,home.lon);
 const reg=new URL(REG);
 for(const [k,v] of Object.entries({bbox:nearbyBbox(home.lat,home.lon),
  format:'json',size:String(MAX_STATIONS),en_service:'true'}))reg.searchParams.set(k,v);
 const [network,nearby]=await Promise.all([
  publicJson(wfsUrl(bboxes.topage),{fetchImpl,maxBytes:MAX_BYTES}),
  publicJson(reg.toString(),{fetchImpl,maxBytes:1200000})
 ]);
 if(!Array.isArray(nearby.data))throw Error('Official station listing unavailable');
 const directoryTruncated=nearby.data.length>=MAX_STATIONS||
  (Number.isFinite(Number(nearby.count))&&Number(nearby.count)>nearby.data.length);
 const stations=nearby.data.map(x=>({code:String(x.code_station||''),
  name:String(x.libelle_station||x.libelle_site||x.code_station||'').slice(0,100),
  lat:Number(x.latitude_station),lon:Number(x.longitude_station)}))
  .filter(x=>validStationCode(x.code)&&Number.isFinite(x.lat)&&Number.isFinite(x.lon))
  .map(x=>({...x,distanceKm:Number(distanceKm(home.lat,home.lon,x.lat,x.lon).toFixed(1))}))
  .filter(x=>x.distanceKm<=NEARBY_RADIUS_KM&&x.code!==code)
  .sort((a,b)=>a.distanceKm-b.distanceKm||a.code.localeCompare(b.code));
 const unique=[...new Map(stations.map(x=>[x.code,x])).values()];
 // The 40-km station directory is not proof of an upstream connection.
 // Explicitly keep unverified stations separate and named "nearby".
 let graph=[],networkVerified=false,coverage='partial';
 try{graph=verifiedGraph(network);networkVerified=true}catch{}
 if(networkVerified&&unique.length){
  const probes=corridorProbes(home,unique.filter(x=>x.distanceKm>5));
  if(probes.length){
   const extra=await Promise.all(probes.map(async bbox=>{
    try{
     const data=await publicJson(wfsUrl(bbox),{fetchImpl,maxBytes:MAX_BYTES});
     return verifiedGraph(data);
    }catch{return []}
   }));
   // Dedupe by exact directed nodes and source geometry endpoints.
   const edges=new Map();
   for(const f of [...graph,...extra.flat()]){
    const p=f?.properties||{},coords=f?.geometry?.coordinates;
    if(!Array.isArray(coords)||coords.length<2)continue;
    const key=[p.CdNoeudDebut,p.CdNoeudFin,p.SensEcoulementTH,
     coords[0]?.join(','),coords[coords.length-1]?.join(',')].join('|');
    edges.set(key,f);
   }
   graph=[...edges.values()];
  }
 }
 let verified=[];
 if(networkVerified){
  try{verified=connectedUpstream(home,unique,graph,{maxStations:10})}
  catch{networkVerified=false}
 }
 const linkedCodes=new Set(verified.map(x=>x.code));
 // Nearby stations are for geographic context ONLY and must never be
 // presented as hydrologically upstream without verified directed graph.
 const neighbours=unique.filter(x=>!linkedCodes.has(x.code)).slice(0,18);
 return {
  home:{code:home.code,name:home.name,lat:home.lat,lon:home.lon},
  candidates:verified,nearby:neighbours,
  evidence:'BD TOPAGE 2025 / Hub Eau',extent:'within-40km-geographical-radius',
  connectivityCoverage:networkVerified?'verified-corridors-partial':'not-verified',
  directoryTruncated,checkedAt:new Date().toISOString()
 };
}
export async function recentUpstreamReading(station,{fetchImpl=fetch,now=Date.now()}={}){
 const url=new URL(OBS);
 for(const [k,v] of Object.entries({code_entite:station.code,grandeur_hydro:'H',size:'65',sort:'desc',format:'json',
  date_debut_obs:new Date(now-3*3600000).toISOString()}))url.searchParams.set(k,v);
 try{
  const data=await publicJson(url.toString(),{fetchImpl,maxBytes:400000});
  const readings=(Array.isArray(data.data)?data.data:[]).filter(x=>Number.isFinite(Number(x.resultat_obs))&&x.resultat_obs!==null)
   .map(x=>({ms:Date.parse(x.date_obs),mm:Number(x.resultat_obs)}))
   .filter(x=>Number.isFinite(x.ms)&&x.ms<=now+15*60000&&now-x.ms<=3*3600000)
   .sort((a,b)=>b.ms-a.ms);
  const latest=readings[0];if(!latest||now-latest.ms>90*60000)return null;
  const earlier=readings.find(x=>latest.ms-x.ms>=30*60000&&latest.ms-x.ms<=180*60000);
  if(!earlier)return null;
  const trend=(latest.mm-earlier.mm)/10/((latest.ms-earlier.ms)/3600000);
  if(!Number.isFinite(trend)||Math.abs(trend)>350)return null;
  return {...station,levelM:latest.mm/1000,trendCmH:Number(trend.toFixed(1)),
   observedAt:new Date(latest.ms).toISOString(),status:'current'};
 }catch{return null}
}
