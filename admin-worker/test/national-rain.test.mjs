import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseMeteorologicalCatalogue,chooseNearbyRainStations,distanceKm,syncSelectedStationRain} from '../src/national-rain.js';
const testCoords={lat:46.4,lon:4.8};
const now=Date.parse('2026-11-17T16:25:00Z');
test('official CSV with eight-digit identifiers is parsed without losing leading zeroes',()=>{
 const data='geo_id_insee;nom_station;lat;lon\n01014002;ARBENT;46,40;4,8\n01027003;Proximite;46.42;4.81\n01033001;Troisieme;46.41;4.83';
 const out=parseMeteorologicalCatalogue(data);
 assert.equal(out.length,3);
 assert.equal(out[0].id,'01014002');
 assert.equal(out[0].lat,46.4);
 assert.equal(out[0].lon,4.8);
});
test('GeoJSON official station positions parsed; coordinate order is longitude, latitude',()=>{
 const out=parseMeteorologicalCatalogue({features:[{type:'Feature',properties:{geo_id_insee:'01014002'},geometry:{type:'Point',coordinates:[4.8,46.4]}}]});
 assert.deepEqual(out,[{id:'01014002',name:'01014002',lat:46.4,lon:4.8}]);
});
test('geographic selection is bounded and not confused with catchment topology',()=>{
 const candidates=[
 {id:'01014002',lat:46.4,lon:4.8,name:'Nearest'},
 {id:'01027003',lat:46.42,lon:4.81,name:'Second'},
 {id:'01033001',lat:46.41,lon:4.83,name:'Third'},
 {id:'83075001',lat:43.31,lon:6.35,name:'Other catchment'}
 ];
 const nearby=chooseNearbyRainStations(testCoords,candidates);
 assert.equal(nearby.length,3);
 assert.equal(nearby[0].id,'01014002');
 assert.ok(!nearby.some(x=>x.id==='83075001'));
 assert.ok(distanceKm(testCoords,{lat:46.41,lon:4.81})<2);
});
test('selected station registered in D1 is automatically populated from official rain observations, with 10-call cap',async()=>{
 const ids=['01014002','01027003','01033001'];
 const csv=['geo_id_insee;nom_station;lat;lon',
  ...ids.map((id,i)=>id+';Station '+i+';46.4;'+(4.8+i*.02)),
  ...Array.from({length:101},(_,i)=>String(i+10000).padStart(8,'0')+';Far '+i+';48.9;2.1')].join('\n');
 let calls=0,stored=0,mapping=null,secret='test_key_do_not_leak';
 const db={prepare(sql){
  return {run:async()=>({success:true}),first:async()=>null,
   bind(...values){
    return {
     first:async()=>null,
     all:async()=>({results:sql.includes('FROM forecast_local_rain_targets')?
      [{hydro_code:'Y999999999',hydro_name:'Demo',lat:46.4,lon:4.8,last_seen_ms:now}]:[]}),
     run:async()=>{
      if(sql.includes('SET nearest_json='))mapping=JSON.parse(values[0]);
      if(sql.includes('INSERT INTO forecast_shadow_rain'))stored++;
      return {success:true};
     }
    }
   }};
 }};
 const fetcher=async(url,opts)=>{
  assert.equal(opts.headers.apikey,secret);calls++;
  if(String(url).includes('/liste-stations'))return new Response(csv,{status:200});
  const x=new URL(url),hour=x.searchParams.get('date'),id=x.searchParams.get('id_station');
  assert.ok(ids.includes(id));
  assert.match(hour,/^2026-11-17T\d\d:00:00Z$/);
  return new Response(JSON.stringify([{geo_id_insee:id,validity_time:hour,rr1:1.2,q_rr1:1}]),{status:200});
 };
 const result=await syncSelectedStationRain({DB:db,METEO_FRANCE_OBS_API_KEY:secret},{now,fetcher,maxCalls:10});
 assert.equal(result.imported,10);
 assert.equal(result.api_calls,10);
 assert.equal(stored,10);
 assert.equal(mapping.length,3);
 assert.equal(calls,11);
 assert.equal(JSON.stringify(result).includes(secret),false);
});
test('national station observation collector has a strict capped request budget, no public API key',()=>{
 const src=readFileSync(new URL('../src/national-rain.js',import.meta.url),'utf8');
 assert.ok(src.includes('Math.min(MAX_NEW'));
 assert.ok(src.includes('MAX_NEW=36'));
 const worker=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 assert.ok(worker.includes('syncSelectedStationRain(env,{maxCalls:25})'));
});
