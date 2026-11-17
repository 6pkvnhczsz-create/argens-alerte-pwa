// Admin-only dynamic Météo-France observations for user-selected hydro stations.
// The API key remains exclusively an encrypted ADMIN Worker secret.
// Strict national rate budget, finite watchlist, separate from Argens hydrology alerts.
import {parseHourlyRain,meteoDate} from './forecast-shadow.js';
const H=3600000,MAX_NEW=36,RETAIN=24*H;
const CATALOG_URL='https://public-api.meteofrance.fr/public/DPObs/v2/liste-stations';
const OBS_URL='https://public-api.meteofrance.fr/public/DPObs/v2/station/horaire';
const isoHour=ms=>new Date(Math.floor(ms/H)*H).toISOString();
const validId=x=>/^\d{8}$/.test(String(x??''));
const validCoord=(lat,lon)=>Number.isFinite(lat)&&Number.isFinite(lon)&&lat>=41&&lat<=52&&lon>=-6&&lon<=11;
const errorText=x=>String(x?.message||x||'Fehler').slice(0,140);

function parseCsv(text){
  const lines=String(text).replace(/^\uFEFF/,'').split(/\r?\n/).filter(x=>x.trim());
  if(!lines.length)return [];
  const delimiter=lines[0].includes(';')?';':',';
  const parseLine=line=>{
    const cells=[];let value='',quoted=false;
    for(let i=0;i<line.length;i++){
      const ch=line[i];
      if(ch==='"'){
        if(quoted&&line[i+1]==='"'){value+='"';i++}else quoted=!quoted;
      }else if(ch===delimiter&&!quoted){cells.push(value.trim());value=''}
      else value+=ch;
    }
    cells.push(value.trim());return cells;
  };
  const headers=parseLine(lines[0]).map(x=>x.toLowerCase().replace(/[^a-z0-9]/g,''));
  return lines.slice(1).map(line=>Object.fromEntries(parseLine(line).map((v,i)=>[headers[i],v])));
}
const choose=(obj,keys)=>keys.map(x=>obj?.[x]).find(x=>x!==null&&x!==undefined&&String(x).trim()!=='');
const num=v=>Number(String(v??'').replace(',','.'));

export function parseMeteorologicalCatalogue(payload){
  let rows;
  if(typeof payload==='string')rows=parseCsv(payload);
  else if(Array.isArray(payload))rows=payload;
  else if(Array.isArray(payload?.features))rows=payload.features;
  else if(Array.isArray(payload?.data))rows=payload.data;
  else rows=[];
  const result=new Map();
  for(const raw of rows){
    const x=raw.properties||raw;
    let id=String(choose(x,['geo_id_insee','geoidinsee','id_station','idstation','num_poste','numposte'])||'').trim();
    // Never coerce to a Number: leading zeroes are part of official IDs.
    if(!validId(id))continue;
    const point=raw.geometry?.coordinates;
    const lat=num(choose(x,['lat','latitude','latitude_station','latitudestation'])??point?.[1]);
    const lon=num(choose(x,['lon','longitude','longitude_station','longitudestation'])??point?.[0]);
    if(!validCoord(lat,lon))continue;
    const name=String(choose(x,['nom_station','nomstation','nom','name','libelle_station','libellestation','libelle'])||id).slice(0,100);
    result.set(id,{id,name,lat,lon});
  }
  return [...result.values()];
}

const rad=Math.PI/180;
export function distanceKm(a,b){
  const dLat=(b.lat-a.lat)*rad,dLon=(b.lon-a.lon)*rad;
  const z=Math.sin(dLat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dLon/2)**2;
  return 12742*Math.atan2(Math.sqrt(z),Math.sqrt(1-z));
}
export function chooseNearbyRainStations(hydro,catalogue){
  if(!validCoord(Number(hydro.lat),Number(hydro.lon)))return [];
  return catalogue.map(x=>({...x,distance_km:distanceKm(hydro,x)}))
    .filter(x=>x.distance_km<=50)
    .sort((a,b)=>a.distance_km-b.distance_km)
    .slice(0,3)
    .map(x=>({id:x.id,name:x.name,distance_km:Math.round(x.distance_km*10)/10}));
}

async function setup(db){
  await db.prepare(`CREATE TABLE IF NOT EXISTS forecast_local_rain_targets (
    hydro_code TEXT PRIMARY KEY, hydro_name TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
    last_seen_ms INTEGER NOT NULL, nearest_json TEXT, nearest_updated_ms INTEGER
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS forecast_local_rain_catalog (
    id INTEGER PRIMARY KEY CHECK(id=1), fetched_ms INTEGER NOT NULL, stations_json TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS forecast_shadow_rain (
    station_id TEXT NOT NULL, hour_utc TEXT NOT NULL, rain_mm REAL NOT NULL,
    inserted_at TEXT NOT NULL,PRIMARY KEY(station_id,hour_utc)
  )`).run();
}

async function getCatalogue(env,now,fetcher){
  const saved=await env.DB.prepare('SELECT fetched_ms,stations_json FROM forecast_local_rain_catalog WHERE id=1').first();
  if(saved?.stations_json&&Number(saved.fetched_ms)>now-24*H){
    const array=JSON.parse(saved.stations_json);
    if(Array.isArray(array)&&array.length>=100)return array;
  }
  try{
    const result=await fetcher(CATALOG_URL,{
      headers:{Accept:'text/csv,application/json',apikey:env.METEO_FRANCE_OBS_API_KEY},
      signal:AbortSignal.timeout(11000)
    });
    if(!result.ok)throw Error('Météo-France catalogue HTTP '+result.status);
    const raw=await result.text();
    if(raw.length>900000)throw Error('Station catalogue too large');
    let parsed;
    if(raw.trim().startsWith('[')||raw.trim().startsWith('{'))parsed=parseMeteorologicalCatalogue(JSON.parse(raw));
    else parsed=parseMeteorologicalCatalogue(raw);
    if(parsed.length<100)throw Error('Catalogue station headers missing or incomplete');
    await env.DB.prepare(`INSERT INTO forecast_local_rain_catalog(id,fetched_ms,stations_json)
      VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET fetched_ms=excluded.fetched_ms,
      stations_json=excluded.stations_json`)
      .bind(now,JSON.stringify(parsed)).run();
    return parsed;
  }catch(error){
    if(saved?.stations_json){
      const arr=JSON.parse(saved.stations_json);
      if(Array.isArray(arr)&&arr.length>=100&&now-Number(saved.fetched_ms)<14*24*H)return arr;
    }
    throw error;
  }
}

export async function syncSelectedStationRain(env,{now=Date.now(),fetcher=fetch,maxCalls=MAX_NEW}={}){
  if(!env?.DB||!env.METEO_FRANCE_OBS_API_KEY)return {status:'unavailable',reason:'No admin Meteo observations key or DB'};
  await setup(env.DB);
  const targets=(await env.DB.prepare(`SELECT hydro_code,hydro_name,lat,lon,last_seen_ms,
      nearest_json,nearest_updated_ms FROM forecast_local_rain_targets
      WHERE last_seen_ms>=? ORDER BY last_seen_ms DESC LIMIT 40`)
    .bind(now-RETAIN).all()).results||[];
  if(!targets.length)return {status:'no_selected_stations',imported:0,api_calls:0};
  const catalog=await getCatalogue(env,now,fetcher);
  const groups=[];
  for(const target of targets){
    const nearest=chooseNearbyRainStations(target,catalog);
    if(!target.nearest_json||JSON.stringify(nearest)!==target.nearest_json||Number(target.nearest_updated_ms)<now-24*H){
      await env.DB.prepare(`UPDATE forecast_local_rain_targets SET nearest_json=?,
       nearest_updated_ms=? WHERE hydro_code=?`)
        .bind(JSON.stringify(nearest),now,target.hydro_code).run();
    }
    if(nearest.length>=2)groups.push({target,nearby:nearest});
  }
  if(!groups.length)return {status:'no_nearby_meteo_stations',imported:0,api_calls:0};
  // Deduplicate shared Météo stations: one observation request serves all nearby hydro stations.
  const chosen=new Map();
  for(const g of groups)for(const station of g.nearby)chosen.set(station.id,station);
  const ids=[...chosen.keys()];
  // Always query recent hours first, then gradually fill the 24h history.
  const end=Math.floor(now/H)*H;
  const lower=isoHour(now-26*H);
  const existing=(await env.DB.prepare('SELECT station_id,hour_utc FROM forecast_shadow_rain WHERE hour_utc>=?')
    .bind(lower).all()).results||[];
  const known=new Set(existing.map(x=>x.station_id+'|'+x.hour_utc));
  const jobs=[];
  for(let k=1;k<=23;k++){
    const hour=isoHour(end-k*H);
    if(now-Date.parse(hour)>23.75*H)continue; // Météo-F limit: older queries can return unrelated oldest point.
    for(const id of ids){
      if(!known.has(id+'|'+hour))jobs.push({id,hour});
    }
  }
  const limit=Math.max(1,Math.min(MAX_NEW,Math.floor(Number(maxCalls)||MAX_NEW)));
  const selection=jobs.slice(0,limit);
  let imported=0,unavailable=0,rateLimited=false,error=null;
  // Bounded batches; never reveal the secret or permit client-selected arbitrary Météo IDs.
  for(let i=0;i<selection.length&&!rateLimited;i+=4){
    const batch=await Promise.allSettled(selection.slice(i,i+4).map(async({id,hour})=>{
      const url=new URL(OBS_URL);
      url.searchParams.set('id_station',id);url.searchParams.set('date',meteoDate(hour));url.searchParams.set('format','json');
      const r=await fetcher(url.toString(),{headers:{Accept:'application/json',apikey:env.METEO_FRANCE_OBS_API_KEY},signal:AbortSignal.timeout(9500)});
      if(r.status===429)return {status:'rate_limited'};
      if(!r.ok)return {status:'http_'+r.status};
      const datum=parseHourlyRain(await r.json(),id,hour);
      if(!datum)return {status:'missing_rr1'};
      await env.DB.prepare(`INSERT INTO forecast_shadow_rain(station_id,hour_utc,rain_mm,inserted_at)
        VALUES(?,?,?,?) ON CONFLICT(station_id,hour_utc)
        DO UPDATE SET rain_mm=excluded.rain_mm, inserted_at=excluded.inserted_at`)
        .bind(datum.station_id,datum.hour_utc,datum.mm,new Date(now).toISOString()).run();
      return {status:'stored'};
    }));
    for(const item of batch){
      const r=item.status==='fulfilled'?item.value:{status:'fetch_error'};
      if(r.status==='stored')imported++;
      else{unavailable++;if(r.status==='rate_limited')rateLimited=true;if(!error)error=r.status}
    }
  }
  return {status:rateLimited?'rate_limited':'ok',active_hydro_stations:groups.length,
    meteo_station_count:ids.length,api_calls:Math.min(selection.length,imported+unavailable),
    imported,unavailable,pending_jobs:Math.max(0,jobs.length-selection.length),error};
}
