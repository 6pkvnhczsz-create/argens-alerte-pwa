// Station-centred PIAF nowcasting for metropolitan France.
// Reference comes ONLY from Hub'Eau, never arbitrary client coordinates.
// Informational display: unrelated to notification thresholds.
export const DEFAULT_STATION='Y531201001';
export const DEFAULT_BOUNDS=[5.85,43.18,6.91,43.85];
const STATIONS='https://hubeau.eaufrance.fr/api/v2/hydrometrie/referentiel/stations';
const LAT_MIN=41.0,LAT_MAX=51.7,LON_MIN=-5.9,LON_MAX=10.2;
export const validStationCode=code=>typeof code==='string'&&/^[A-Z][A-Z0-9]{7,13}$/.test(code);
export function isMetropolitan(lat,lon){
 return Number.isFinite(lat)&&Number.isFinite(lon)&&lat>=41.2&&lat<=51.4&&lon>=-5.3&&lon<=9.8;
}
export function boundsForStation(lat,lon,code=''){
 if(!isMetropolitan(lat,lon))throw Error('PIAF is not available for this station location');
 if(code===DEFAULT_STATION)return [...DEFAULT_BOUNDS];
 const width=1.06,height=.67;
 let west=lon-width/2,south=lat-height/2;
 west=Math.max(LON_MIN,Math.min(LON_MAX-width,west));
 south=Math.max(LAT_MIN,Math.min(LAT_MAX-height,south));
 return [west,south,west+width,south+height].map(v=>Number(v.toFixed(4)));
}
export function validateBounds(bounds){
 if(!Array.isArray(bounds)||bounds.length!==4||bounds.some(v=>!Number.isFinite(v)))throw Error('Invalid PIAF bounds');
 const [w,s,e,n]=bounds;
 if(w<LON_MIN||e>LON_MAX||s<LAT_MIN||n>LAT_MAX||e-w<.3||e-w>1.1||n-s<.25||n-s>.72)
  throw Error('PIAF map exceeds allowed view');
 return bounds;
}
export async function resolveStation(code,{fetchImpl=fetch}={}){
 if(!validStationCode(code))throw Error('Invalid hydrometric station code');
 const url=new URL(STATIONS);
 url.searchParams.set('code_station',code);
 url.searchParams.set('size','10');
 url.searchParams.set('format','json');
 const response=await fetchImpl(url.toString(),{
  headers:{Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(12000),
  cf:{cacheTtl:1800}
 });
 if(!response.ok||response.redirected)throw Error('Hub Eau registry not available');
 if(Number(response.headers.get('content-length'))>200000)throw Error('Station metadata too large');
 const raw=await response.text();
 if(raw.length>200000)throw Error('Station metadata too large');
 let result;try{result=JSON.parse(raw)}catch{throw Error('Station registry did not return JSON')}
 const station=(Array.isArray(result.data)?result.data:[]).find(item=>item.code_station===code);
 if(!station)throw Error('Station not found in official register');
 const lat=Number(station.latitude_station),lon=Number(station.longitude_station);
 if(!isMetropolitan(lat,lon))throw Error('Station outside metropolitan PIAF forecast coverage');
 return {code,lat,lon,name:String(station.libelle_station||station.libelle_site||code).slice(0,120),
  river:String(station.libelle_cours_eau||'').slice(0,90),
  riverCode:String(station.code_cours_eau||'').slice(0,30),
  bounds:boundsForStation(lat,lon,code)};
}
export async function cachedStation(code,{fetchImpl=fetch,cache=globalThis.caches?.default}={}){
 if(!validStationCode(code))throw Error('Invalid station code');
 const key=new Request('https://riviere-alerte.fr/__piaf_cache/station-v1?code='+code);
 if(cache){
  const hit=await cache.match(key);
  if(hit){
   const data=await hit.json().catch(()=>null);
   if(data?.code===code&&isMetropolitan(data.lat,data.lon)){
    validateBounds(data.bounds);
    return data;
   }
  }
 }
 const station=await resolveStation(code,{fetchImpl});
 if(cache)await cache.put(key,new Response(JSON.stringify(station),{headers:{
  'Content-Type':'application/json','Cache-Control':'public, max-age=21600'}}));
 return station;
}
