import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../src/forecast-shadow.js',import.meta.url),'utf8');
const {parseHourlyRain,summarizeCoverage,RAIN_STATIONS} = await import('data:text/javascript;charset=utf-8,'+encodeURIComponent(source));

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
