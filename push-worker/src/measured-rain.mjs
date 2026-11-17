// Observed rainfall near a user's selected hydro station. Public, informational only.
// Values are read from the shared D1 observations table populated by the ADMIN Worker.
// The Météo-France secret never leaves the ADMIN Worker.
// Nearby stations are selected by distance, NOT by verified river catchment topology.
const HOUR=3600000;
const MAX_TARGETS=40;
const RETAIN=24*HOUR;
const hourIso=ms=>new Date(Math.floor(ms/HOUR)*HOUR).toISOString();
const validCode=x=>typeof x==='string'&&/^[A-Z][A-Z0-9]{7,13}$/.test(x);
const validGeo=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&a>=41&&a<=52&&b>=-6&&b<=11;
const validId=x=>typeof x==='string'&&/^\d{8}$/.test(x);

export async function registerSelectedRainStation(db,station,now=Date.now()){
  if(!db||!validCode(station?.code)||!validGeo(station?.lat,station?.lon))return {status:'ignored'};
  await db.prepare(`CREATE TABLE IF NOT EXISTS forecast_local_rain_targets (
    hydro_code TEXT PRIMARY KEY, hydro_name TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
    last_seen_ms INTEGER NOT NULL, nearest_json TEXT, nearest_updated_ms INTEGER
  )`).run();
  const row=await db.prepare('SELECT last_seen_ms FROM forecast_local_rain_targets WHERE hydro_code=?')
    .bind(station.code).first();
  if(row&&Number(row.last_seen_ms)>now-10*60000)return {status:'recent'};
  if(!row){
    // Prevent public station search from creating unbounded national API demand.
    const c=await db.prepare('SELECT COUNT(*) AS n FROM forecast_local_rain_targets WHERE last_seen_ms >= ?')
      .bind(now-RETAIN).first();
    if(Number(c?.n||0)>=MAX_TARGETS)return {status:'capacity'};
  }
  await db.prepare(`INSERT INTO forecast_local_rain_targets
    (hydro_code,hydro_name,lat,lon,last_seen_ms,nearest_json,nearest_updated_ms)
    VALUES(?,?,?,?,?,NULL,NULL)
    ON CONFLICT(hydro_code) DO UPDATE SET hydro_name=excluded.hydro_name,
      lat=excluded.lat,lon=excluded.lon,last_seen_ms=excluded.last_seen_ms`)
    .bind(station.code,String(station.name||station.code).slice(0,120),station.lat,station.lon,now).run();
  return {status:'registered'};
}

export function summarizeStationRain(station,nearby,rows,now=Date.now()){
  const selected=(Array.isArray(nearby)?nearby:[])
    .filter(x=>validId(String(x.id||''))&&Number.isFinite(x.distance_km)&&x.distance_km<=50)
    .slice(0,3);
  if(selected.length<2)return null;
  const ids=new Set(selected.map(x=>x.id));
  const byHour=new Map();
  for(const row of rows||[]){
    if(!ids.has(String(row.station_id))||row.rain_mm===null||row.rain_mm===undefined||row.rain_mm==='')continue;
    const time=Date.parse(row.hour_utc),mm=Number(row.rain_mm);
    if(!Number.isFinite(time)||!Number.isFinite(mm)||mm<0||mm>400||time%HOUR!==0||time>now+15*60000||time<now-27*HOUR)continue;
    const key=hourIso(time);
    const existing=byHour.get(key)||new Map();
    existing.set(String(row.station_id),mm);
    byHour.set(key,existing);
  }
  const hourNow=Math.floor(now/HOUR)*HOUR;
  // A source observation for the current UTC hour is allowed only if actually present.
  let last=null;
  for(let k=0;k<=2;k++){
    const hour=hourNow-k*HOUR;
    if((byHour.get(hourIso(hour))?.size||0)>=2){last=hour;break}
  }
  if(last===null)return null;
  const sumHours=n=>{
    let amount=0,validHours=0;
    for(let i=0;i<n;i++){
      const values=[...(byHour.get(hourIso(last-i*HOUR))?.values()||[])];
      if(values.length<2)continue;
      amount+=values.reduce((a,b)=>a+b,0)/values.length;
      validHours++;
    }
    return {mm:Math.round(amount*10)/10,valid_hours:validHours,period_hours:n};
  };
  const h3=sumHours(3),h6=sumHours(6),h24=sumHours(24);
  if(h3.valid_hours<3||h6.valid_hours<5)return null;
  return {
    id:'home',name:station.name,status:'observed',model:'meteo_france_dpobs',
    last3hMm:h3.mm,last6hMm:h6.mm,last24hMm:h24.valid_hours>=20?h24.mm:null,
    latestHour:hourIso(last),stationsUsed:selected.length,source_station_ids:selected.map(x=>x.id),
    coverage:{h3:h3.valid_hours,h6:h6.valid_hours,h24:h24.valid_hours},
    description:'Gemessener Durchschnitt naher Météo-France-Wetterstationen, keine Einzugsgebietsmessung'
  };
}

export async function readSelectedRainMeasurements(db,station,now=Date.now()){
  if(!db||!validCode(station?.code))return null;
  try{
    const entry=await db.prepare('SELECT nearest_json,nearest_updated_ms FROM forecast_local_rain_targets WHERE hydro_code=?').bind(station.code).first();
    if(!entry?.nearest_json||!Number.isFinite(Number(entry.nearest_updated_ms))||now-Number(entry.nearest_updated_ms)>3*24*HOUR)return null;
    const nearby=JSON.parse(entry.nearest_json);
    if(!Array.isArray(nearby)||nearby.length<2)return null;
    const ids=nearby.slice(0,3).map(x=>String(x.id)).filter(validId);
    if(ids.length<2)return null;
    // Identifiers originate only from the ADMIN's Météo-France official catalogue.
    const placeholders=ids.map(()=>'?').join(',');
    const values=await db.prepare(`SELECT station_id,hour_utc,rain_mm FROM forecast_shadow_rain
      WHERE station_id IN (${placeholders}) AND hour_utc>=?`)
      .bind(...ids,hourIso(now-27*HOUR)).all();
    return summarizeStationRain(station,nearby,values.results||[],now);
  }catch{return null} // On missing tables or unavailable observations retain labelled estimates.
}
