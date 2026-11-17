import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../src/forecast-shadow.js',import.meta.url),'utf8');
const {parseHourlyRain,summarizeCoverage,RAIN_STATIONS,probeForecastRain,syncForecastRain,meteoDate,mergeRainHistory,summarizeSixHourRisk,getForecastShadowStatus,backfillForecastRain} = await import('../src/forecast-shadow.js');
const {archivedRainRows} = await import('../src/rain-archive-2026.js');
const {FORECAST_SHADOW_PAGE} = await import('../src/forecast-shadow-page.js');
const {forecastCronPlan,NORMAL_CRON,RECOVERY_CRON}=await import('../src/forecast-shadow-schedule.js');
const {shadowTreePredict,buildShadowFeatureVector,computeShadowForecast,MODEL_INFO}=await import('../src/forecast-shadow-model.js');

test('accepts valid observed zero rain with UTC hour and quality 1',()=>{
  const hour='2026-11-17T10:00:00.000Z';
  assert.deepEqual(parseHourlyRain([{geo_id_insee:'83075001',validity_time:'2026-11-17T10:00:00Z',rr1:0,q_rr1:1}],'83075001',hour),
    {station_id:'83075001',hour_utc:hour,mm:0});
});
test('accepts a GeoJSON feature with measurements',()=>{
  const hour='2026-11-17T10:00:00.000Z';
  const x={features:[{properties:{geo_id_insee:'83075001',validity_time:'2026-11-17T10:00:00Z',rr1:8.4,q_rr1:1}}]};
  assert.equal(parseHourlyRain(x,'83075001',hour).mm,8.4);
});
test('rejects invalid station, timestamps, negative rain and poor quality',()=>{
  const hour='2026-11-17T10:00:00.000Z';
  const base={geo_id_insee:'83075001',validity_time:'2026-11-17T10:00:00Z',rr1:1,q_rr1:1};
  for(const diff of [{geo_id_insee:'wrong'},{validity_time:'2026-11-18T10:00:00Z'},{rr1:-1},{rr1:null},{q_rr1:9}]){
    assert.equal(parseHourlyRain([{...base,...diff}],'83075001',hour),null);
  }
});
test('seven fresh stations with at least 216 of 240 hourly observations are required',()=>{
  const now=Date.parse('2026-11-17T12:00:00Z');
  const rows=RAIN_STATIONS.slice(0,7).map(([id])=>({station_id:id,n:216,latest_hour_utc:'2026-11-17T11:00:00.000Z'}));
  const ok=summarizeCoverage(rows,now);
  assert.equal(ok.ready,true);
  assert.equal(ok.complete_10d_stations,7);
  rows[6].latest_hour_utc='2026-11-16T11:00:00.000Z';
  assert.equal(summarizeCoverage(rows,now).ready,false);
});
test('hourly data from model estimates are never marked as observed',()=>{
  assert.equal(RAIN_STATIONS.length,11);
  assert.equal(source.includes('api.open-meteo.com'),false);
  assert.ok(source.includes('computeShadowForecast(combined.rows')); // no public alert path
});

test('manual probe returns API permission failure without exposing secret', async ()=>{
  const now=Date.parse('2026-11-17T12:35:00Z');
  const key='internal-test-key-do-not-log';
  const result=await probeForecastRain({METEO_FRANCE_OBS_API_KEY:key},now, async (url,options)=>{
    assert.equal(new URL(url).searchParams.get('date'),'2026-11-17T11:00:00Z');
    assert.equal(options.headers.apikey,key);
    return new Response('forbidden',{status:403});
  });
  assert.equal(result.http_status,403);
  assert.equal(result.ok,false);
  assert.ok(!JSON.stringify(result).includes(key));
});
test('manual probe verifies hourly rain and never confuses missing reading with zero',async()=>{
  const now=Date.parse('2026-11-17T12:35:00Z');
  const result=await probeForecastRain({METEO_FRANCE_OBS_API_KEY:'secret'},now, async()=>new Response(
    JSON.stringify([{geo_id_insee:'83075001',validity_time:'2026-11-17T11:00:00Z',rr1:0}]),
    {status:200,headers:{'Content-Type':'application/json'}}));
  assert.equal(result.ok,true);
  assert.equal(result.reading_available,true);
  assert.equal(result.rain_mm,0);
  const missing=await probeForecastRain({METEO_FRANCE_OBS_API_KEY:'secret'},now,async()=>new Response('[]',{status:200}));
  assert.equal(missing.ok,true);
  assert.equal(missing.reading_available,false);
  assert.equal(missing.rain_mm,null);
});

test('Météo-France timestamp omits JS milliseconds',()=>{
  assert.equal(meteoDate('2026-11-17T12:00:00.000Z'),'2026-11-17T12:00:00Z');
});
test('automatic import fetches 3 completed hours without milliseconds and stores true zero values',async()=>{
  const now=Date.parse('2026-11-17T13:31:00Z');
  const queries=[];const rows=[];
  const fakeDb={
    prepare(sql){
      return {
        run:async()=>({success:true}),
        bind(...params){
          return {run:async()=>{
            if(sql.startsWith('INSERT INTO forecast_shadow_rain('))rows.push(params);
            return {success:true};
          }};
        }
      };
    }
  };
  const fakeFetch=async(url,options)=>{
    const u=new URL(url), station=u.searchParams.get('id_station'), date=u.searchParams.get('date');
    queries.push({station,date});
    assert.equal(options.headers.apikey,'example-key');
    // Simulate upstream 400 for the *old* milliseconds format.
    if(/\.000Z$/.test(date))return new Response('invalid date',{status:400});
    assert.match(date,/^2026-11-17T(10|11|12):00:00Z$/);
    return new Response(JSON.stringify([{geo_id_insee:station,validity_time:date,rr1:0}]),{
      status:200,headers:{'Content-Type':'application/json'}
    });
  };
  const result=await syncForecastRain({DB:fakeDb,METEO_FRANCE_OBS_API_KEY:'example-key'},now,fakeFetch);
  assert.equal(result.accepted,33);
  assert.equal(result.rejected,0);
  assert.equal(queries.length,33);
  assert.equal(rows.length,33);
  assert.ok(rows.every(row=>row[2]===0));
  assert.ok(!JSON.stringify(result).includes('example-key'));
});

test('historical CSV archive preserves measured zeros, explicit missing hours and observed rainfall',()=>{
  const start=Date.parse('2026-11-07T00:00:00Z');
  const rows=archivedRainRows(start,start+239*3600000);
  assert.equal(rows.length,2587);
  assert.equal(rows.filter(x=>x.station_id==='83004004').length,227);
  assert.equal(rows.some(x=>x.station_id==='83004004'&&x.hour_utc==='2026-11-08T07:00:00.000Z'),false);
  assert.equal(rows.find(x=>x.station_id==='83075001'&&x.hour_utc==='2026-11-07T00:00:00.000Z').rain_mm,0.2);
  assert.equal(rows.find(x=>x.station_id==='83004004'&&x.hour_utc==='2026-11-12T10:00:00.000Z').rain_mm,12.3);
  assert.deepEqual(archivedRainRows(Date.parse('2026-12-01T00:00:00Z'),Date.parse('2026-12-02T00:00:00Z')),[]);
});
test('history merges 11 stations with recent live values and excludes missing archive time',()=>{
  const now=Date.parse('2026-11-17T14:01:00Z');
  const archive=archivedRainRows(now-239*3600000,now);
  const live=RAIN_STATIONS.map(([station_id])=>({
    station_id,hour_utc:'2026-11-17T13:00:00.000Z',rain_mm:0,source:'live'
  }));
  const combined=mergeRainHistory(live,archive,now);
  const coverage=summarizeCoverage(combined.covered,now);
  assert.equal(coverage.recent_stations,11);
  assert.equal(coverage.complete_10d_stations,10); // Les Arcs has real gaps, never fabricate 0-mm hours.
  assert.equal(coverage.ready,true);
  assert.equal(combined.live_sample_count,11);
  assert.ok(combined.historical_sample_count>2300);
  assert.equal(combined.rolling_24h.mm,null);
  assert.ok(Number.isFinite(combined.rolling_240h.mm));
  assert.ok(combined.rolling_240h.valid_hours>=192);
});
test('hourly zeros must be real measurements, never treat missing or null as zero',()=>{
  const now=Date.parse('2026-11-17T14:01:00Z');
  const fake=[{station_id:'83004004',hour_utc:'2026-11-17T13:00:00.000Z',rain_mm:null}];
  const out=mergeRainHistory(fake,[],now);
  assert.equal(out.live_sample_count,0);
  assert.equal(out.covered.find(x=>x.station_id==='83004004').n,0);
});
test('risk and three thresholds remain strictly informational; model forecast is blocked',()=>{
  const hydro={ok:true,level_m:5.52,change_1h_m:0.42,age_minutes:5};
  const rain={ready:true,rolling_24h:{mm:63}};
  const risk=summarizeSixHourRisk(hydro,rain);
  assert.equal(risk.status,'not_calculated');
  assert.equal(risk.thresholds.length,3);
  assert.equal(risk.thresholds[0].observed_status,'reached');
  assert.equal(risk.thresholds[1].observed_status,'below');
  assert.ok(risk.thresholds.every(x=>x.forecast_crossing===null));
  assert.equal(risk.signals.length,3);
  assert.ok(FORECAST_SHADOW_PAGE.includes('6 Stunden ab Bezugszeitpunkt'));
  assert.ok(FORECAST_SHADOW_PAGE.includes('Keine amtliche Warnung'));
});

test('admin page inline JavaScript parses without syntax errors',()=>{
  const m=FORECAST_SHADOW_PAGE.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m,'inline admin script exists');
  assert.doesNotThrow(()=>new Function(m[1]));
});

test('distilled model matches independent Python sklearn predictions on historical 2024 fixtures',()=>{
 const v=[
 {h:3.25,r_Aille_6h:55.25,r_all_6h:40.1545455,r_Upstream_24h:53.45,r_Nartuby_240h:170.4,r_East_240h:180.6,r_Bresque_72h:70.8,r_Aille_240h:187.5,r_all_3h:21.6,r_Argens_middle_24h:62.7666667,r_Nartuby_6h:33.2},
 {h:5.52,r_Aille_6h:37.8,r_all_6h:35.4909091,r_Upstream_24h:73.5,r_Nartuby_240h:199.8,r_East_240h:232.9,r_Bresque_72h:91.55,r_Aille_240h:216.3,r_all_3h:8.8727273,r_Argens_middle_24h:93.0333333,r_Nartuby_6h:35.2},
 {h:5.77,r_Aille_6h:4.9,r_all_6h:6.5363636,r_Upstream_24h:56.8,r_Nartuby_240h:245.5,r_East_240h:306.7,r_Bresque_72h:95.05,r_Aille_240h:301.15,r_all_3h:1.4454545,r_Argens_middle_24h:99.2666667,r_Nartuby_6h:12.2}
 ];
 for(let i=0;i<v.length;i++)
  assert.ok(Math.abs(shadowTreePredict(v[i])-[5.21261846672676,6.885164701801838,5.956996481011241][i])<0.00001);
 assert.equal(MODEL_INFO.operational,false);
 assert.equal(MODEL_INFO.early_5_40_false_positive_hours,8);
});
test('valid observed rain and fresh gauge produce a real experimental 6-hour shadow estimate',()=>{
 const now=Date.parse('2026-11-17T14:22:00Z'),H=3600000;
 const rain=[];
 for(const [id] of RAIN_STATIONS)
  for(let hours=239;hours>=0;hours--)
   rain.push({station_id:id,hour_utc:new Date(Math.floor(now/H)*H-hours*H).toISOString(),rain_mm:0,source:'live'});
 const gauge=[];
 for(let mins=0;mins<=14*60;mins+=15)
  gauge.push({at:new Date(Date.parse('2026-11-17T14:15:00Z')-mins*60000).toISOString(),metres:1.34});
 const hydro={ok:true,level_m:1.34,age_minutes:7,series:gauge};
 const result=computeShadowForecast(rain,hydro,now,true);
 assert.equal(result.status,'experimental');
 assert.ok(result.peak_m>=1.34);
 assert.equal(result.reference_hour_utc,'2026-11-17T14:00:00.000Z');
 assert.equal(result.valid_until_utc,'2026-11-17T20:00:00.000Z');
 assert.equal(result.rain_station_count,11);
 assert.equal(result.model.operational,false);
});
test('model fails closed on stale gauge and missing 10-day data; no false relief',()=>{
 const now=Date.parse('2026-11-17T14:22:00Z');
 assert.equal(computeShadowForecast([],{ok:false,level_m:1.34},now,true).peak_m,null);
 assert.equal(computeShadowForecast([],{ok:true,series:[{at:'2026-11-17T14:00:00Z',metres:1.34}],level_m:1.34},now,false).status,'unavailable');
 const risk=summarizeSixHourRisk({ok:true,level_m:1.34,change_1h_m:0.0},{ready:true,rolling_24h:{mm:0}},{status:'experimental',peak_m:1.34});
 assert.equal(risk.status,'experimental');
 assert.equal(risk.thresholds[0].forecast_crossing,false);
 assert.ok(risk.label.includes('keine Entwarnung'));
});
test('model threshold crossing shown only as experimental, never official warnings',()=>{
 const hydro={ok:true,level_m:4.5,change_1h_m:0.1};
 const risk=summarizeSixHourRisk(hydro,{ready:true,rolling_24h:{mm:54}},{status:'experimental',peak_m:6.3});
 assert.equal(risk.thresholds.length,3);
 assert.equal(risk.thresholds[0].forecast_crossing,true);
 assert.equal(risk.thresholds[2].forecast_crossing,true);
 assert.equal(risk.thresholds[2].observed_status,'below');
 assert.equal(risk.status,'experimental');
 assert.equal(risk.signals.length,1); // observed rainfall, not predicted rainfall
});

test('admin read API computes shadow forecast using real archive overlap, mocked D1 and Hub-Eau',async()=>{
 const now=Date.parse('2026-11-17T14:22:00Z'),H=3600000;
 const rows=[];
 for(const [id] of RAIN_STATIONS)
  for(let h=0;h<=19;h++)
   rows.push({station_id:id,hour_utc:new Date(Date.parse('2026-11-16T19:00:00Z')+h*H).toISOString(),rain_mm:0.0});
 const gauge=[];
 for(let m=0;m<14*60;m+=15)
  gauge.push({date_obs:new Date(Date.parse('2026-11-17T14:15:00Z')-m*60000).toISOString(),resultat_obs:1340});
 const db={
  prepare(sql){
   const o={run:async()=>({success:true}),first:async()=>({checked_at:'2026-11-17T14:00:00Z',accepted:31,rejected:2,error_text:'einzelne Regenstunden fehlen'}),
    all:async()=>({results:sql.includes('FROM forecast_shadow_rain')?rows:[]}),bind(){return o}};
   return o;
  }
 };
 const fakeFetch=async (url)=>{
  assert.ok(String(url).includes('observations_tr'));
  return new Response(JSON.stringify({data:gauge}),{status:200,headers:{'Content-Type':'application/json'}});
 };
 const out=await getForecastShadowStatus({DB:db,METEO_FRANCE_OBS_API_KEY:'example-key'},now,fakeFetch);
 assert.equal(out.hydro.ok,true);
 assert.equal(out.hydro.series,undefined); // never leak bulk raw series to browser
 assert.ok(out.rain.ready);
 assert.equal(out.prediction.status,'experimental');
 assert.ok(Number.isFinite(out.prediction.forecast_peak_m));
 assert.ok(out.prediction.forecast_peak_m>=1.34);
 assert.equal(out.prediction.model.operational,false);
 assert.equal(out.risk.status,'experimental');
 assert.equal(out.risk.thresholds.length,3);
});

test('24-hour gap backfill requests at most 55 absent measurements without touching archived hours',async()=>{
 const now=Date.parse('2026-11-17T14:41:00Z'),calls=[],writes=[];
 const db={
  prepare(sql){
   const obj={
    bind(...values){
     return {run:async()=>{
       if(sql.includes('INSERT INTO forecast_shadow_rain('))writes.push(values);
       return {meta:{changes:1}};
     },all:async()=>({results:[]})};
    },
    run:async()=>({meta:{changes:1}})
   };
   return obj;
  }
 };
 const fetcher=async(url,options)=>{
  const u=new URL(url),date=u.searchParams.get('date'),station=u.searchParams.get('id_station');
  assert.equal(options.headers.apikey,'example-secret');
  assert.match(date,/^2026-11-(16|17)T\d\d:00:00Z$/);
  assert.equal(date.endsWith('.000Z'),false);
  calls.push({date,station});
  return new Response(JSON.stringify([{geo_id_insee:station,validity_time:date,rr1:0,q_rr1:1}]),{status:200});
 };
 const x=await backfillForecastRain({DB:db,METEO_FRANCE_OBS_API_KEY:'example-secret'},now,fetcher);
 assert.equal(x.status,'completed');
 assert.equal(x.imported,55);
 assert.equal(x.unavailable,0);
 assert.equal(calls.length,55);
 assert.equal(writes.length,55);
 assert.ok(calls.every(x=>x.date>='2026-11-16T20:00:00Z'));
 assert.ok(calls.every(x=>x.date<='2026-11-17T13:00:00Z'));
 assert.ok(writes.every(row=>row[2]===0));
 assert.ok(!JSON.stringify(x).includes('example-secret'));
});
test('backfill refuses parallel calls during cooldown and does not make external requests',async()=>{
 let called=0;
 const db={prepare(){const obj={bind(){return {run:async()=>({meta:{changes:0}})}},run:async()=>({})};return obj}};
 const result=await backfillForecastRain({DB:db,METEO_FRANCE_OBS_API_KEY:'secret'},Date.parse('2026-11-17T14:41:00Z'),async()=>{called++;return new Response('[]')});
 assert.equal(result.status,'cooldown');
 assert.equal(called,0);
});
test('missing RR1 in backfill is recorded as missing rather than inserted as 0 mm',async()=>{
 const now=Date.parse('2026-11-17T14:41:00Z'),rainWrites=[],attemptWrites=[];
 const db={prepare(sql){return {bind(...params){return {run:async()=>{if(sql.includes('INSERT INTO forecast_shadow_rain('))rainWrites.push(params);if(sql.includes('INSERT INTO forecast_shadow_backfill_attempt('))attemptWrites.push(params);return {meta:{changes:1}}},all:async()=>({results:[]})}},run:async()=>({meta:{changes:1}})}}};
 const result=await backfillForecastRain({DB:db,METEO_FRANCE_OBS_API_KEY:'secret'},now,async()=>new Response(JSON.stringify([{geo_id_insee:'wrong',validity_time:'2026-11-16T20:00:00Z',rr1:0}]),{status:200}));
 assert.equal(result.imported,0);
 assert.equal(result.unavailable,55);
 assert.equal(rainWrites.length,0);
 assert.equal(attemptWrites.length,55);
});

test('scheduled automation runs hourly sync plus three additional bounded recovery jobs per hour',()=>{
 const wrangler=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
 assert.deepEqual(wrangler.triggers.crons,[NORMAL_CRON,RECOVERY_CRON]);
 assert.deepEqual(forecastCronPlan('31 * * * *'),{sync:true,backfillLimit:22});
 assert.deepEqual(forecastCronPlan('1,16,46 * * * *'),{sync:false,backfillLimit:55});
 assert.deepEqual(forecastCronPlan('some unapproved cron'),{sync:false,backfillLimit:0});
 const src=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 assert.ok(src.includes('forecastCronPlan(event?.cron)'));
 assert.ok(src.includes('backfillForecastRain(env,Date.now(),fetch,plan.backfillLimit)'));
});
test('page refreshes itself every minute and manual backfill is tucked under technical details',()=>{
 const script=FORECAST_SHADOW_PAGE.match(/<script>([\s\S]*?)<\/script>/)?.[1];
 assert.ok(script);
 assert.ok(script.includes("setInterval"));
 assert.ok(script.includes('60*1000'));
 assert.ok(FORECAST_SHADOW_PAGE.includes('Automatische Nachholung alle 15 Minuten'));
 const positionDetails=FORECAST_SHADOW_PAGE.indexOf('<details id="stationDetails">');
 const positionManualButton=FORECAST_SHADOW_PAGE.indexOf('<button id="backfill"');
 const positionClosingDetails=FORECAST_SHADOW_PAGE.indexOf('</details>');
 assert.ok(positionDetails<positionManualButton&&positionManualButton<positionClosingDetails);
});

test('gauge 62 min old: experimental-only delayed estimate, measured status remains unknown',()=>{
 const now=Date.parse('2026-11-17T15:02:00Z'),H=3600000;
 const rain=[];
 for(const [id] of RAIN_STATIONS)
  for(let hours=239;hours>=0;hours--)
   rain.push({station_id:id,hour_utc:new Date(Date.parse('2026-11-17T14:00:00Z')-hours*H).toISOString(),rain_mm:0,source:'live'});
 const series=[];
 for(let mins=0;mins<=14*60;mins+=15)
  series.push({at:new Date(Date.parse('2026-11-17T14:00:00Z')-mins*60000).toISOString(),metres:1.34});
 const hydro={ok:false,level_m:1.34,observed_at_utc:'2026-11-17T14:00:00Z',age_minutes:62,series,source:'Hub’Eau'};
 const model=computeShadowForecast(rain,hydro,now,true);
 assert.equal(model.status,'experimental_delayed');
 assert.equal(model.gauge_age_minutes,62);
 assert.equal(model.reference_hour_utc,'2026-11-17T14:00:00.000Z');
 assert.equal(model.valid_until_utc,'2026-11-17T20:00:00.000Z');
 assert.ok(Number.isFinite(model.peak_m));
 const risk=summarizeSixHourRisk(hydro,{ready:true,rolling_24h:{mm:0}},model);
 assert.equal(risk.status,'experimental_delayed');
 assert.equal(risk.thresholds[0].observed_status,'unknown');
 assert.ok(risk.reason.includes('62 Minuten'));
 assert.ok(risk.label.includes('Verzögerte'));
 assert.ok(FORECAST_SHADOW_PAGE.includes('Verzögerte Pegelmessung'));
});
test('observations older than 90 minutes never create an admin shadow estimate',()=>{
 const now=Date.parse('2026-11-17T15:31:00Z');
 const old={ok:false,observed_at_utc:'2026-11-17T14:00:00Z',level_m:1.34,
    age_minutes:91,source:'Hub’Eau',series:[{at:'2026-11-17T14:00:00Z',metres:1.34}]};
 assert.equal(computeShadowForecast([],old,now,true).status,'unavailable');
 old.observed_at_utc='2026-11-17T14:00:00Z';
 old.source='unverified';
 assert.equal(computeShadowForecast([],old,Date.parse('2026-11-17T15:02:00Z'),true).status,'unavailable');
});
