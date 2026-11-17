import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../src/forecast-shadow.js',import.meta.url),'utf8');
const {parseHourlyRain,summarizeCoverage,RAIN_STATIONS,probeForecastRain,syncForecastRain,meteoDate,mergeRainHistory,summarizeSixHourRisk} = await import('../src/forecast-shadow.js');
const {archivedRainRows} = await import('../src/rain-archive-2026.js');
const {FORECAST_SHADOW_PAGE} = await import('../src/forecast-shadow-page.js');

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
  assert.equal(source.includes('forecast_peak_m:null'),true);
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
  assert.equal(coverage.complete_10d_stations,11);
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
  assert.ok(FORECAST_SHADOW_PAGE.includes('Nächste 6 Stunden'));
  assert.ok(FORECAST_SHADOW_PAGE.includes('Keine amtliche Warnung'));
});

test('admin page inline JavaScript parses without syntax errors',()=>{
  const m=FORECAST_SHADOW_PAGE.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m,'inline admin script exists');
  assert.doesNotThrow(()=>new Function(m[1]));
});
