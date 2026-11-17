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

async function getHydro(fetcher, nowMs) {
  try {
    const r=await fetcher('https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr?code_entite='+STATION+'&grandeur_hydro=H&size=150&sort=desc&format=json',{
      headers:{Accept:'application/json'},signal:AbortSignal.timeout(9500)
    });
    if(!r.ok) throw Error('Hub’Eau HTTP '+r.status);
    const data=await r.json();
    const valid=(Array.isArray(data.data)?data.data:[])
      .map(x=>({at:x.date_obs,metres:Number(x.resultat_obs)/1000}))
      .filter(x=>x.at&&Number.isFinite(Date.parse(x.at))&&Number.isFinite(x.metres)&&x.metres>=0&&x.metres<20)
      .sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
    if(!valid.length) return {ok:false,reason:'Keine gültigen Messwerte'};
    const latest=valid[0], age=nowMs-Date.parse(latest.at);
    const old=valid.find(x=>{const delta=Date.parse(latest.at)-Date.parse(x.at);return delta>=55*60000&&delta<=90*60000});
    return {ok:age>=-15*60000 && age<=60*60000,level_m:latest.metres,
      observed_at_utc:latest.at,age_minutes:Math.round(age/60000),
      change_1h_m:old?Math.round((latest.metres-old.metres)*100)/100:null,
      source:'Hub’Eau',reason:age>60*60000?'Pegel älter als 60 Minuten':null};
  } catch(e) {return {ok:false,reason:safeError(e)};}
}

export async function getForecastShadowStatus(env, nowMs=Date.now(), fetcher=fetch) {
  const stamp=new Date(nowMs).toISOString();
  const hydro=await getHydro(fetcher,nowMs);
  let ingest=null, rainRows=[], dbError=null;
  try {
    await ensureTables(env.DB);
    ingest=await env.DB.prepare('SELECT checked_at,accepted,rejected,error_text FROM forecast_shadow_ingest WHERE id=1').first();
    const cutoff=isoHour(nowMs-240*HOUR_MS);
    const query=await env.DB.prepare('SELECT station_id,COUNT(*) AS n,MAX(hour_utc) AS latest_hour_utc FROM forecast_shadow_rain WHERE hour_utc >= ? GROUP BY station_id').bind(cutoff).all();
    rainRows=query.results||[];
  }catch(e){dbError=safeError(e);}
  const rain=summarizeCoverage(rainRows,nowMs);
  rain.api_key_configured=Boolean(env.METEO_FRANCE_OBS_API_KEY);
  rain.source='Météo-France DPObs (beobachtete Stundenwerte)';
  rain.last_ingest=ingest;
  rain.storage_error=dbError;
  return {
    station:STATION,issued_at_utc:stamp,mode:'admin_shadow_only',horizon_hours:6,
    hydro,rain,
    prediction:{forecast_peak_m:null,status:'not_enabled',reason:!hydro.ok?(hydro.observed_at_utc&&hydro.age_minutes>60?'Pegelwert '+hydro.age_minutes+' Minuten alt – für die Testprognose sind maximal 60 Minuten erlaubt':(hydro.reason||'Aktuelle Pegelmessungen fehlen')):!rain.api_key_configured?'Météo-France Observations-API noch nicht eingerichtet':!rain.ready?'Für das trainierte Modell fehlen ausreichend 10-Tage-Regenmessungen':'Python-Modell noch nicht als validierter Live-Inferenzdienst angebunden'},
    safety:'Keine Änderung an öffentlichen Warnungen, Push oder Pegelschwellen.'
  };
}

export const FORECAST_SHADOW_PAGE = `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rivière Alerte · Prognose-Test</title>
<style>body{font:16px system-ui;background:#edf3f6;color:#173749;margin:0}main{max-width:780px;margin:24px auto;padding:26px;background:white;border-radius:20px;box-shadow:0 4px 24px #123f5712}a{color:#087f91;font-weight:700}h1{font-size:23px;margin:12px 0}h2{font-size:17px;margin-top:27px}.muted,small{color:#577280}section{border:1px solid #dce9ee;padding:16px 18px;border-radius:13px;margin:12px 0;background:#f8fbfc}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:10px}.grid section{margin:0}strong{display:block;font-size:23px;margin-top:7px}button{background:#087f91;border:0;border-radius:9px;color:#fff;padding:11px 18px;font-weight:700;cursor:pointer}#detail{white-space:pre-wrap;font-size:13px}.warn{color:#9c5614}#error{color:#b42332}table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:7px 4px;border-bottom:1px solid #dce9ee;text-align:left}th:last-child,td:last-child{text-align:right}@media(max-width:600px){main{margin:0;border-radius:0;padding:17px}}</style>
<main><a href="/">← Zur Admin-Übersicht</a><h1>Hochwasserprognose · Testbetrieb</h1><p class="muted">Nur intern · Roquebrune-sur-Argens · Nächste 6 Stunden</p>
<section><small>Experimentelle Modellprognose</small><strong id="prediction">Noch nicht verfügbar</strong><p class="muted" id="reason">Daten werden geprüft …</p><small>Keine amtliche Hochwasserwarnung. Die bisherige Warnlogik bleibt unverändert.</small></section>
<div class="grid"><section><small>Letzter Pegel (Hub’Eau)</small><strong id="level">–</strong><small id="hydroTime">–</small></section><section><small>Aktuelle Regenstationen</small><strong id="stations">–</strong><small>Mindestens 7 erforderlich</small></section><section><small>10-Tage-Historie vollständig</small><strong id="history">–</strong><small>Mindestens 216 von 240 Stunden pro Station</small></section></div>
<h2>Messdaten und Verfügbarkeit</h2><section><p id="api">Prüfe Météo-France …</p><p id="sync" class="muted"></p><div id="error"></div><table><thead><tr><th>Station</th><th>Letzter Regenwert (UTC)</th><th>10 Tage</th></tr></thead><tbody id="stationsTable"></tbody></table></section>
<button id="probe" type="button">Météo-France-Verbindung testen</button> <button id="syncNow" type="button">Regenimport jetzt starten</button> <button id="refresh" type="button">↻ Aktualisieren</button><p id="probeStatus" class="muted" role="status">Der API-Schlüssel wird bei einem Verbindungstest geprüft.</p><p class="muted" id="updated"></p></main><script>
const el=id=>document.getElementById(id);const stamp=v=>v?new Date(v).toLocaleString('de-DE',{timeZone:'Europe/Paris',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'–';
async function update(){el('refresh').disabled=true;try{const res=await fetch('/api/forecast-shadow',{cache:'no-store'});if(!res.ok)throw Error('HTTP '+res.status);const d=await res.json();el('prediction').textContent=d.prediction.forecast_peak_m==null?'Noch keine freigegebene Modellzahl':d.prediction.forecast_peak_m.toFixed(2)+' m';el('reason').textContent=d.prediction.reason||'Nur experimenteller Test';el('level').textContent=Number.isFinite(d.hydro.level_m)?d.hydro.level_m.toFixed(2)+' m':'–';el('hydroTime').textContent=d.hydro.observed_at_utc?stamp(d.hydro.observed_at_utc)+' · '+(d.hydro.ok?'aktuell':'nicht aktuell'):d.hydro.reason||'Nicht erreichbar';el('stations').textContent=d.rain.recent_stations+'/11';el('history').textContent=d.rain.complete_10d_stations+'/11';el('api').textContent=d.rain.api_key_configured?'Cloudflare-Secret vorhanden (Zugriff noch nicht geprüft)':'Météo-France Observations-API: Secret fehlt';el('sync').textContent=d.rain.last_ingest?'Letzter Import: '+stamp(d.rain.last_ingest.checked_at)+' · '+d.rain.last_ingest.accepted+' übernommen / '+d.rain.last_ingest.rejected+' verworfen':'Noch kein automatischer Import durchgeführt';const missing=d.rain.last_ingest?.rejected||0;const taken=d.rain.last_ingest?.accepted||0;const detail=d.rain.storage_error||d.rain.last_ingest?.error_text||'';el('error').style.color=taken>0&&missing>0&&!d.rain.storage_error?'#94601a':'#b42332';el('error').textContent=taken>0&&missing>0&&!d.rain.storage_error?missing+' von '+(taken+missing)+' Stundenwerten nicht verfügbar (z. B. '+detail+')':detail;const body=el('stationsTable');body.replaceChildren();for(const s of d.rain.stations){const tr=document.createElement('tr');for(const value of [s.name,stamp(s.latest_utc)+(s.fresh?' ✓':''),s.hours_10d+'/240']){const td=document.createElement('td');td.textContent=value;tr.append(td)}body.append(tr)}el('updated').textContent='Abgerufen: '+stamp(d.issued_at_utc)}catch(e){el('error').textContent='Status nicht abrufbar: '+e.message}finally{el('refresh').disabled=false}}
el('refresh').addEventListener('click',update);
el('syncNow').addEventListener('click',async()=>{const btn=el('syncNow');btn.disabled=true;el('probeStatus').textContent='Starte Import der letzten drei abgeschlossenen UTC-Stunden …';try{const r=await fetch('/api/forecast-shadow/sync-now',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const d=await r.json();if(!r.ok)throw Error(d.error||'HTTP '+r.status);el('probeStatus').textContent='Import angestoßen. Über „Aktualisieren“ lässt sich danach das Ergebnis prüfen.';}catch(e){el('probeStatus').textContent='Import nicht gestartet: '+e.message;}finally{btn.disabled=false}});

el('probe').addEventListener('click',async()=>{const btn=el('probe');btn.disabled=true;el('probeStatus').textContent='Prüfe API-Verbindung …';try{const r=await fetch('/api/forecast-shadow/probe',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!r.ok)throw Error('HTTP '+r.status);const d=await r.json();el('probeStatus').textContent=(d.ok?'✓ ':'✕ ')+d.message+(d.reading_available?' · '+d.rain_mm+' mm':'');}catch(e){el('probeStatus').textContent='Verbindungstest fehlgeschlagen: '+e.message}finally{btn.disabled=false}});
update();</script></html>`;
