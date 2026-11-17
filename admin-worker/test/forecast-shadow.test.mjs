import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../src/forecast-shadow.js',import.meta.url),'utf8');
const {parseHourlyRain,summarizeCoverage,RAIN_STATIONS,probeForecastRain,syncForecastRain,meteoDate} = await import('data:text/javascript;charset=utf-8,'+encodeURIComponent(source));

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
