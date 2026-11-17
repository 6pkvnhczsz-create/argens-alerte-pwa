import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {summarizeStationRain,registerSelectedRainStation,readSelectedRainMeasurements} from '../src/measured-rain.mjs';
const H=3600000;
const t=Date.parse('2026-11-17T16:26:00Z');
const hydro={code:'Y999999999',name:'Ausgewählte Pegelstation',lat:46.4,lon:4.8};
const near=[{id:'01014002',distance_km:8},{id:'01027003',distance_km:11},{id:'01033001',distance_km:14}];
function measured(hours=24,mm=1){
 const rows=[];
 for(let k=0;k<hours;k++){
  for(const x of near)rows.push({station_id:x.id,hour_utc:new Date(Math.floor(t/H)*H-k*H).toISOString(),rain_mm:mm});
 }
 return rows;
}
test('measured rainfall is based on correct local Météo IDs; two to three hourly observations per hour',()=>{
 const d=summarizeStationRain(hydro,near,measured(24),t);
 assert.equal(d.status,'observed');
 assert.equal(d.last3hMm,3);
 assert.equal(d.last6hMm,6);
 assert.equal(d.last24hMm,24);
 assert.equal(d.stationsUsed,3);
 assert.deepEqual(d.coverage,{h3:3,h6:6,h24:24});
 assert.equal(d.model,'meteo_france_dpobs');
 assert.ok(!JSON.stringify(d).includes('catchment-wide total'));
});
test('missing RR1 stays missing, not zero; 3h / 6h need real measured coverage',()=>{
 const one=measured(24);
 const missing=one.filter(row=>!(row.hour_utc==='2026-11-17T15:00:00.000Z'&&row.station_id!=='01014002'));
 assert.equal(summarizeStationRain(hydro,near,missing,t),null);
 const rainy=summarizeStationRain(hydro,near,measured(24,0),t);
 assert.equal(rainy.last3hMm,0);
 assert.equal(rainy.last6hMm,0);
});
test('distant weather stations cannot be labelled as locally measured values',()=>{
 const distant=[{id:'01014002',distance_km:82},{id:'01027003',distance_km:98}];
 assert.equal(summarizeStationRain(hydro,distant,measured(24),t),null);
});
test('rain gauge source rows for a different region do not contaminate selected station',()=>{
 assert.equal(summarizeStationRain(hydro,near,Array.from({length:24},(_,k)=>({
   station_id:'83075001',hour_utc:new Date(Math.floor(t/H)*H-k*H).toISOString(),rain_mm:60
 })),t),null);
});
test('null readings and impossible values never become a measured 0 mm',()=>{
 const rows=measured(24);
 for(const x of rows)if(x.hour_utc==='2026-11-17T16:00:00.000Z')x.rain_mm=null;
 assert.equal(summarizeStationRain(hydro,near,rows,t),null);
});
test('selected station is registered from official coordinates and capped at 40 active targets',async()=>{
 const calls=[];
 const db={prepare(sql){
  return {bind(...values){
   return {first:async()=>sql.includes('COUNT(*)')?{n:0}:null,
    run:async()=>{calls.push({sql,values});return {success:true}}};
  },run:async()=>({success:true})};
 }};
 const x=await registerSelectedRainStation(db,hydro,t);
 assert.equal(x.status,'registered');
 assert.equal(calls.length,1);
 assert.equal(calls[0].values[0],hydro.code);
 assert.equal(calls[0].values[2],hydro.lat);
});
test('no leak of Météo-France key and no API request from public worker',()=>{
 const src=readFileSync(new URL('../src/measured-rain.mjs',import.meta.url),'utf8');
 assert.ok(!src.includes('METEO_FRANCE_OBS_API_KEY'));
 assert.ok(!src.includes('public-api.meteofrance.fr'));
 const worker=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 assert.ok(worker.includes('readSelectedRainMeasurements(env.DB,station,now)'));
 assert.ok(worker.includes('registerSelectedRainStation(env.DB,station)'));
 assert.ok(worker.includes('nearby_gauges_not_catchment'));
});
