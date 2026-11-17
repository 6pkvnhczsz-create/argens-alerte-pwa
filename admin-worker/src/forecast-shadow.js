import {archivedRainRows} from './rain-archive-2026.js';
import {computeShadowForecast} from './forecast-shadow-model.js';
// Admin-only, fail-closed preparation for the 6-hour flood forecast shadow test.
// This code does not send alerts, change thresholds, or expose predictions publicly.
// Live precipitation is an observed Météo-France DPObs reading, NOT Open-Meteo model rain.
export const RAIN_STATIONS = [
  ['83004004','Les Arcs'],['83007004','Aups'],['83031001','Le Luc'],
  ['83050007','Draguignan'],['83051001','Entrecasteaux'],
  ['83075001','Les Mayons'],['83083001','Montfort-sur-Argens'],
  ['83116022','Saint-Maximin-la-Sainte-Baume'],['83124002','Seillans'],
  ['83145001','Varages'],['83148002','Vidauban']
];
const STATION = 'Y531201001';
const API = 'https://public-api.meteofrance.fr/public/DPObs/v2/station/horaire';
const HOUR_MS = 3600000;
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}
});
const isoHour = ms => new Date(Math.floor(ms/HOUR_MS)*HOUR_MS).toISOString();
// Météo-France expects YYYY-MM-DDTHH:mm:ssZ, *without* JavaScript's .000 milliseconds.
export const meteoDate = hour => hour.replace(/\.000Z$/, 'Z');
const safeError = error => String(error && error.message || error || 'Fehler').slice(0, 160);

export function parseHourlyRain(payload, stationId, requestedHour) {
  const list = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.features)
    ? payload.features : (payload && Array.isArray(payload.data) ? payload.data : [payload]));
  for (const item of list) {
    const obj = (item && item.properties) || item;
    if (!obj || typeof obj !== 'object') continue;
    const returned = String(obj.geo_id_insee || obj.id_station || obj.NUM_POSTE || stationId);
    if (returned !== stationId) continue;
    const rawDate = obj.validity_time || obj.date || obj.date_obs || obj.date_utc || obj.dateUTC || obj.DATETIME || obj.reference_time;
    if (!rawDate) continue;
    let stamp = String(rawDate).trim().replace(' ', 'T');
    if (!/[zZ]|[+-]\d\d:\d\d$/.test(stamp)) stamp += 'Z';
    const time = Date.parse(stamp);
    if (!Number.isFinite(time) || isoHour(time) !== requestedHour) continue;
    const raw = obj.rr1 ?? obj.RR1;
    if (raw === null || raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 400) continue;
    // Same quality class as the cleaned historical CSV. Unknown quality is not inventively "good".
    const quality = obj.q_rr1 ?? obj.Q_RR1;
    if (quality !== undefined && quality !== null && quality !== '' && Number(quality) !== 1) continue;
    return {station_id:stationId, hour_utc:requestedHour, mm:value};
  }
  return null;
}

async function ensureTables(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS forecast_shadow_rain (station_id TEXT NOT NULL, hour_utc TEXT NOT NULL, rain_mm REAL NOT NULL, inserted_at TEXT NOT NULL, PRIMARY KEY(station_id,hour_utc))').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS forecast_shadow_rain_hour_idx ON forecast_shadow_rain(hour_utc)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS forecast_shadow_ingest (id INTEGER PRIMARY KEY CHECK(id=1), checked_at TEXT NOT NULL, accepted INTEGER NOT NULL, rejected INTEGER NOT NULL, error_text TEXT)').run();
}

// Called by the separate admin Worker's hourly cron or an Access-protected manual test.
// Fetch only the last three completed UTC hours; the current hour can still be unpublished.
export async function syncForecastRain(env, nowMs = Date.now(), fetcher = fetch) {
  if (!env.DB) return {status:'no_database'};
  await ensureTables(env.DB);
  const checkedAt = new Date(nowMs).toISOString();
  if (!env.METEO_FRANCE_OBS_API_KEY) {
    await env.DB.prepare('INSERT INTO forecast_shadow_ingest(id,checked_at,accepted,rejected,error_text) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at, accepted=excluded.accepted, rejected=excluded.rejected, error_text=excluded.error_text')
      .bind(checkedAt, 0, 0, 'Secret METEO_FRANCE_OBS_API_KEY fehlt').run();
    return {status:'key_missing',accepted:0};
  }
  const requested = [1,2,3].map(offset => isoHour(nowMs-offset*HOUR_MS));
  const jobs = requested.flatMap(hour => RAIN_STATIONS.map(station => [station[0],hour]));
  let accepted = 0, rejected = 0, firstError = '';
  // Limit concurrency; official API is rate limited.
  for (let i=0; i<jobs.length; i+=5) {
    const results = await Promise.allSettled(jobs.slice(i,i+5).map(async ([station,hour]) => {
      const u = new URL(API);
      u.searchParams.set('id_station',station);
      u.searchParams.set('date',meteoDate(hour));
      u.searchParams.set('format','json');
      const r = await fetcher(u.toString(),{
        headers:{Accept:'application/json',apikey:env.METEO_FRANCE_OBS_API_KEY},
        signal:AbortSignal.timeout(9500)
      });
      if (!r.ok) throw Error('Météo-France HTTP '+r.status);
      const body = await r.json();
      const datum = parseHourlyRain(body,station,hour);
      if (!datum) return {ok:false,reason:'Kein gültiger RR1-Wert für '+station+' um '+hour};
      await env.DB.prepare('INSERT INTO forecast_shadow_rain(station_id,hour_utc,rain_mm,inserted_at) VALUES(?,?,?,?) ON CONFLICT(station_id,hour_utc) DO UPDATE SET rain_mm=excluded.rain_mm, inserted_at=excluded.inserted_at')
        .bind(datum.station_id,datum.hour_utc,datum.mm,checkedAt).run();
      return {ok:true};
    }));
    for (const result of results) {
      if (result.status==='fulfilled' && result.value?.ok) accepted++;
      else {
        rejected++;
        if (!firstError) firstError = result.status==='rejected' ? safeError(result.reason) : (result.value?.reason||'Keine Messung');
      }
    }
  }
  const expiry = isoHour(nowMs - 15*24*HOUR_MS);
  await env.DB.prepare('DELETE FROM forecast_shadow_rain WHERE hour_utc < ?').bind(expiry).run();
  await env.DB.prepare('INSERT INTO forecast_shadow_ingest(id,checked_at,accepted,rejected,error_text) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at, accepted=excluded.accepted, rejected=excluded.rejected, error_text=excluded.error_text')
    .bind(checkedAt,accepted,rejected,firstError || null).run();
  return {status:accepted?'partial_or_ok':'no_valid_observations',accepted,rejected,error:firstError||null};
}

// Lightweight, manual diagnostic: one request, no database writes and no secret disclosure.
export async function probeForecastRain(env, nowMs=Date.now(), fetcher=fetch) {
  if (!env.METEO_FRANCE_OBS_API_KEY) return {ok:false,configured:false,message:'Cloudflare-Secret METEO_FRANCE_OBS_API_KEY fehlt'};
  const station='83075001'; // Les Mayons, chosen from historical training observations.
  const hour=isoHour(nowMs-HOUR_MS);
  const u=new URL(API);
  u.searchParams.set('id_station',station);
  u.searchParams.set('date',meteoDate(hour));
  u.searchParams.set('format','json');
  try {
    const r=await fetcher(u.toString(),{
      headers:{Accept:'application/json',apikey:env.METEO_FRANCE_OBS_API_KEY},
      signal:AbortSignal.timeout(9500)
    });
    if (!r.ok) return {ok:false,configured:true,http_status:r.status,station,hour_utc:hour,
      message:r.status===401?'API-Key ungültig oder abgelaufen':r.status===403?'Observations-API nicht freigeschaltet oder keine Berechtigung':r.status===429?'Anfragelimit der Météo-France-API erreicht':'Météo-France antwortet HTTP '+r.status};
    const payload=await r.json();
    const datum=parseHourlyRain(payload,station,hour);
    return {ok:true,configured:true,http_status:200,station,hour_utc:hour,
      reading_available:!!datum,rain_mm:datum?datum.mm:null,
      message:datum?'API-Zugriff erfolgreich; gültige Regenmessung empfangen':'API-Zugriff erfolgreich; für Les Mayons fehlt ein gültiger Stunden-Regenwert – Station/Antwortformat prüfen'};
  } catch(error) {
    return {ok:false,configured:true,station,hour_utc:hour,
      message:'API-Verbindungsfehler: '+safeError(error)};
  }
}

export function summarizeCoverage(rows, nowMs) {
  const recentCutoff = nowMs-3*HOUR_MS;
  const names = new Map(RAIN_STATIONS);
  const stations = RAIN_STATIONS.map(([id,name]) => {
    const row = (rows||[]).find(x => x.station_id===id);
    const count = Number(row && row.n || 0);
    const latest = row && row.latest_hour_utc || null;
    const fresh = !!latest && Number.isFinite(Date.parse(latest)) && Date.parse(latest)>=recentCutoff && Date.parse(latest)<=nowMs+15*60000;
    return {id,name:name||names.get(id),hours_10d:count,latest_utc:latest,fresh,complete:count>=216};
  });
  const recent = stations.filter(x=>x.fresh).length;
  const complete = stations.filter(x=>x.fresh&&x.complete).length;
  return {stations,recent_stations:recent,complete_10d_stations:complete,
    ready:complete>=7,required_stations:7,required_hours_per_station:216};
}


const CRITICAL_THRESHOLDS=[
  {id:'strasse',label:'Straße / Grundstück',metres:5.40},
  {id:'zaun',label:'Zaun / Grundstück',metres:5.90},
  {id:'haustuer',label:'Haustür',metres:6.22}
];
export function mergeRainHistory(liveRows,historyRows,nowMs) {
  // Snapshot covers only Nov 7–16, 2026; naturally disappears from the 240-hour sliding window.
  // Live readings always win, no null -> 0 conversion, no extrapolation of missing hours.
  const hour=isoHour(nowMs);
  const endMs=Date.parse(hour);
  const startMs=endMs-239*HOUR_MS;
  const keys=new Set(RAIN_STATIONS.map(x=>x[0]));
  const merged=new Map();
  for(const row of [...historyRows,...liveRows]){
    if(!keys.has(String(row.station_id))||row.rain_mm===null||row.rain_mm===undefined||row.rain_mm==='')continue;
    const ms=Date.parse(row.hour_utc),v=Number(row.rain_mm);
    if(!Number.isFinite(ms)||ms<startMs||ms>endMs||ms%HOUR_MS!==0||!Number.isFinite(v)||v<0||v>400)continue;
    const id=String(row.station_id);
    merged.set(id+'|'+isoHour(ms),{station_id:id,hour_utc:isoHour(ms),rain_mm:v,source:row.source||'live'});
  }
  const rows=[...merged.values()];
  const covered=RAIN_STATIONS.map(([station_id])=>{
    const mine=rows.filter(x=>x.station_id===station_id);
    return {station_id,n:mine.length,latest_hour_utc:mine.map(x=>x.hour_utc).sort().at(-1)||null};
  });
  const byHour=new Map();
  for(const row of rows){
    const list=byHour.get(row.hour_utc)||[];
    list.push(row.rain_mm);
    byHour.set(row.hour_utc,list);
  }
  const sumRolling=(hours)=>{
    let sum=0,validHours=0;
    const stop=endMs,begin=endMs-(hours-1)*HOUR_MS;
    for(let ms=begin;ms<=stop;ms+=HOUR_MS){
      const list=byHour.get(isoHour(ms))||[];
      if(list.length<7)continue;
      sum+=list.reduce((a,b)=>a+b,0)/list.length;
      validHours++;
    }
    return {mm:validHours>=Math.ceil(hours*.8)?Math.round(sum*10)/10:null,
      valid_hours:validHours,required_hours:Math.ceil(hours*.8),period_hours:hours};
  };
  return {rows,covered,rolling_24h:sumRolling(24),rolling_240h:sumRolling(240),
    historical_sample_count:rows.filter(x=>x.source==='historic_csv').length,
    live_sample_count:rows.filter(x=>x.source!=='historic_csv').length};
}
export function summarizeSixHourRisk(hydro,rain,modelForecast=null) {
  const thresholds=CRITICAL_THRESHOLDS.map(x=>({
    ...x,observed_status:hydro.ok?(hydro.level_m>=x.metres?'reached':'below'):'unknown',
    forecast_crossing:modelForecast?.status==='experimental'?modelForecast.peak_m>=x.metres:null,
    forecast_status:modelForecast?.status==='experimental'?'experimental':'not_calculated'
  }));
  const blockedReason=!hydro.ok?(hydro.observed_at_utc&&hydro.age_minutes>60?
    'Der Pegel ist '+hydro.age_minutes+' Minuten alt; maximal 60 Minuten erlaubt.':(hydro.reason||'Aktueller Pegel fehlt.')):
    !rain.ready?'Noch nicht genug durchgängige Regenmessungen.':
    'Live-Modell für Schwellenüberschreitungen noch nicht validiert.';
  const rise=Number.isFinite(hydro.change_1h_m)?hydro.change_1h_m:null;
  const rain24=rain.rolling_24h?.mm;
  const signals=[];
  if(hydro.ok&&rise!==null&&rise>=.4)signals.push('Schneller gemessener Pegelanstieg (≥ 40 cm/h)');
  if(rain.rolling_24h?.mm!==null&&rain24>=50)signals.push('Gemessener regionaler Regen ≥ 50 mm/24 h');
  if(hydro.ok&&hydro.level_m>=5.4)signals.push('Erste kritische Pegelschwelle bereits erreicht');
  const estimated=modelForecast?.status==='experimental';
  const peak=estimated?modelForecast.peak_m:null;
  const label=estimated?(peak>=5.40?'Testmodell: mögliche Überschreitung ab 5,40 m':'Testmodell: Schätzung unter 5,40 m (keine Entwarnung)'):'6-Stunden-Risiko noch nicht berechenbar';
  return {status:estimated?'experimental':'not_calculated',label,
    reason:estimated?'Experimentelle Modellschätzung, nicht als Warnentscheidung geeignet. Einzelne Hochwasser wurden deutlich überschätzt.':modelForecast?.reason||blockedReason,signals,thresholds,
    disclaimer:'Messsignale sind keine validierte 6-Stunden-Vorhersage und ändern keine Warnungen.'};
}

async function getHydro(fetcher, nowMs) {
  try {
    const r=await fetcher('https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr?code_entite='+STATION+'&grandeur_hydro=H&size=500&sort=desc&format=json',{
      headers:{Accept:'application/json'},signal:AbortSignal.timeout(9500)
    });
    if(!r.ok) throw Error('Hub’Eau HTTP '+r.status);
    const data=await r.json();
    const valid=(Array.isArray(data.data)?data.data:[])
      .filter(x=>x.resultat_obs!==null&&x.resultat_obs!==undefined&&x.resultat_obs!=='')
      .map(x=>({at:x.date_obs,metres:Number(x.resultat_obs)/1000}))
      .filter(x=>x.at&&Number.isFinite(Date.parse(x.at))&&Number.isFinite(x.metres)&&x.metres>=0&&x.metres<20)
      .sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
    if(!valid.length) return {ok:false,reason:'Keine gültigen Messwerte'};
    const latest=valid[0], age=nowMs-Date.parse(latest.at);
    const old=valid.find(x=>{const delta=Date.parse(latest.at)-Date.parse(x.at);return delta>=55*60000&&delta<=90*60000});
    return {ok:age>=-15*60000 && age<=60*60000,level_m:latest.metres,
      observed_at_utc:latest.at,age_minutes:Math.round(age/60000),
      change_1h_m:old?Math.round((latest.metres-old.metres)*100)/100:null,
      source:'Hub’Eau',series:valid.slice(0,500),reason:age>60*60000?'Pegel älter als 60 Minuten':null};
  } catch(e) {return {ok:false,reason:safeError(e)};}
}

export async function getForecastShadowStatus(env, nowMs=Date.now(), fetcher=fetch) {
  const stamp=new Date(nowMs).toISOString();
  const hydro=await getHydro(fetcher,nowMs);
  let ingest=null, rainRows=[], dbError=null;
  try {
    await ensureTables(env.DB);
    ingest=await env.DB.prepare('SELECT checked_at,accepted,rejected,error_text FROM forecast_shadow_ingest WHERE id=1').first();
    const cutoff=isoHour(nowMs-239*HOUR_MS);
    const query=await env.DB.prepare('SELECT station_id,hour_utc,rain_mm FROM forecast_shadow_rain WHERE hour_utc >= ?').bind(cutoff).all();
    rainRows=query.results||[];
  }catch(e){dbError=safeError(e);}
  const historical=archivedRainRows(Date.parse(isoHour(nowMs-239*HOUR_MS)),Date.parse(isoHour(nowMs)));
  const combined=mergeRainHistory(rainRows,historical,nowMs);
  const rain=summarizeCoverage(combined.covered,nowMs);
  rain.rolling_24h=combined.rolling_24h;
  rain.rolling_240h=combined.rolling_240h;
  rain.historical_sample_count=combined.historical_sample_count;
  rain.live_sample_count=combined.live_sample_count;
  rain.api_key_configured=Boolean(env.METEO_FRANCE_OBS_API_KEY);
  rain.source='Météo-France DPObs (beobachtete Stundenwerte)';
  rain.last_ingest=ingest;
  rain.storage_error=dbError;
  const forecast=computeShadowForecast(combined.rows,hydro,nowMs,rain.ready&&!dbError);
  const {series:_internalSeries,...publicHydro}=hydro; // do not ship 500 raw samples to the browser
  const risk=summarizeSixHourRisk(hydro,rain,forecast);
  return {
    station:STATION,issued_at_utc:stamp,mode:'admin_shadow_only',horizon_hours:6,
    hydro:publicHydro,rain,risk,
    prediction:{
      forecast_peak_m:forecast.peak_m,status:forecast.status,
      reason:forecast.reason||forecast.warning||null,
      reference_hour_utc:forecast.reference_hour_utc||null,
      valid_until_utc:forecast.valid_until_utc||null,
      model:forecast.model
    },
    safety:'Experimentell und ausschließlich intern. Keine Änderung an öffentlichen Warnungen, Push oder Pegelschwellen.'
  };
}

export {FORECAST_SHADOW_PAGE} from './forecast-shadow-page.js';
