import test from 'node:test';
import assert from 'node:assert/strict';
import {boundsForStation,validateBounds,resolveStation,validStationCode,normalizeDepartmentCode} from '../src/piaf-station.mjs';
import {localBboxes,nearbyBbox,distanceKm,findLocalUpstream,connectedUpstream,recentUpstreamReading} from '../src/upstream-topage.mjs';
const edge=(from,to,a,b,sense='dans direction tronçon')=>({
 geometry:{type:'LineString',coordinates:[a,b]},
 properties:{CdNoeudDebut:from,CdNoeudFin:to,SensEcoulementTH:sense}
});
const home={code:'Y531201001',name:'Home',lat:43.5,lon:6.58};
const flow=[
 edge('A','B',[6.4,43.5],[6.5,43.5]),
 edge('B','C',[6.5,43.5],[6.6,43.5]),
 edge('D','B',[6.5,43.6],[6.5,43.5]),
 edge('E','F',[6.3,43.51],[6.45,43.51]),
];
test('PIAF view uses the official reference location, not arbitrary browser coordinates',async()=>{
 assert.equal(validStationCode('Y531201001'),true);
 assert.equal(validStationCode('../../foo'),false);
 assert.deepEqual(boundsForStation(43.4497,6.6331,'Y531201001'),[5.6331,42.8097,7.6331,44.0897]);
 const paris=boundsForStation(48.86,2.34,'H123456789');
 assert.deepEqual(paris,[1.34,48.22,3.34,49.5]);
 assert.doesNotThrow(()=>validateBounds(paris));
 assert.throws(()=>boundsForStation(16,-61,'X123456789'),/not available/);
 assert.throws(()=>validateBounds([0,0,10,10]),/exceeds/);
 const sample=await resolveStation('H123456789',{fetchImpl:async()=>new Response(JSON.stringify({
   data:[{code_station:'H123456789',latitude_station:48.86,longitude_station:2.34,libelle_station:'Paris'}]
 }),{headers:{'Content-Type':'application/json'}})});
 assert.equal(sample.name,'Paris');
 assert.equal(sample.department,null,'Missing official department must never be guessed from coordinates');
 assert.deepEqual(sample.bounds,paris);
});
test('TOPAGE WFS uses official latitude-first bbox but Hub Eau registry longitude-first bbox',()=>{
 const view=localBboxes(43.5,6.58);
 assert.match(view.topage,/^43\.45500,6\.\d+,43\.54500,6\.\d+,EPSG:4326$/);
 assert.match(view.hubeau,/^6\.\d+,43\.45500,6\.\d+,43\.54500$/);
});
test('directed graph accepts genuinely upstream mainstem and tributaries but not nearby/downstream channels',()=>{
 const stations=[
 {code:'Y111111111',name:'Above on river',lat:43.5,lon:6.45},
 {code:'Y222222222',name:'Tributary',lat:43.55,lon:6.5},
 {code:'Y333333333',name:'Downstream',lat:43.5,lon:6.59},
 {code:'Y444444444',name:'Nearby but disconnected',lat:43.51,lon:6.36}
 ];
 const found=connectedUpstream(home,stations,flow);
 assert.deepEqual(found.map(x=>x.code).sort(),['Y111111111','Y222222222']);
 assert.ok(found.every(x=>x.graphHops>=1&&x.snapKm<=.18));
 const notFlow=flow.map(x=>({...x,properties:{...x.properties,SensEcoulementTH:'indéterminé'}}));
 assert.throws(()=>connectedUpstream(home,stations,notFlow),/No directed/);
});
test('fresh Hub Eau observations supply genuine per-hour trend and reject stale observations',async()=>{
 const now=Date.parse('2026-11-15T21:00:00Z');
 const station={code:'Y111111111',name:'Up',lat:43.5,lon:6.45};
 const points=[{resultat_obs:1210,date_obs:'2026-11-15T20:50:00Z'},
  {resultat_obs:1110,date_obs:'2026-11-15T19:50:00Z'}];
 const fetchImpl=async()=>new Response(JSON.stringify({data:points}),{headers:{'Content-Type':'application/json'}});
 const sample=await recentUpstreamReading(station,{fetchImpl,now});
 assert.equal(sample.levelM,1.21);assert.equal(sample.trendCmH,10);
 assert.equal(sample.status,'current');
 assert.equal(await recentUpstreamReading(station,{fetchImpl,now:now+3*3600000}),null);
});

test('40-km radius includes surrounding French stations without falsely marking unrelated rivers as upstream',async()=>{
 const box=nearbyBbox(43.5,6.58);
 assert.equal(box.split(',').length,4);
 assert.ok(Number(box.split(',')[0])<6.1 && Number(box.split(',')[2])>7.05);
 assert.ok(Math.abs(distanceKm(43.5,6.58,43.5,7.0)-34)<2);
 const near=[
  {code_station:'Y531201001',libelle_station:'Home',latitude_station:43.5,longitude_station:6.58},
  {code_station:'Y111111111',libelle_station:'Upstream',latitude_station:43.5,longitude_station:6.45},
  {code_station:'Y222222222',libelle_station:'Tributary',latitude_station:43.55,longitude_station:6.5},
  {code_station:'Y444444444',libelle_station:'Nearby only',latitude_station:43.51,longitude_station:6.36},
  {code_station:'Y555555555',libelle_station:'Outside 40km',latitude_station:43.5,longitude_station:5.6}
 ];
 const calls=[];
 const fetchImpl=async uri=>{
  const url=new URL(uri);calls.push(url.toString());
  if(url.pathname.includes('/referentiel/stations')){
   const station=url.searchParams.get('code_station');
   return new Response(JSON.stringify({data:station?[near[0]]:near}),{headers:{'Content-Type':'application/json'}});
  }
  if(url.pathname.includes('/geo/topage2025')){
   return new Response(JSON.stringify({type:'FeatureCollection',features:flow,numberMatched:flow.length}),{
    headers:{'Content-Type':'application/json'}});
  }
  throw Error('Unexpected API');
 };
 const result=await findLocalUpstream('Y531201001',{fetchImpl});
 assert.equal(result.extent,'within-40km-geographical-radius');
 assert.ok(result.candidates.some(x=>x.code==='Y111111111'),'Hydrologically upstream remains verified');
 assert.ok(result.nearby.some(x=>x.code==='Y444444444'),'Nearby unconnected gauge is shown separately');
 assert.ok(!result.candidates.some(x=>x.code==='Y444444444'),'Unconnected gauge is not upstream');
 assert.ok(!result.nearby.some(x=>x.code==='Y555555555'),'Stations beyond 40 km are excluded');
 assert.ok(calls.filter(x=>x.includes('/geo/topage2025')).length>1,'Additional selected river corridors are probed');
 assert.ok(calls.some(x=>x.includes('bbox=')&&x.includes('en_service=true')));
});

test('40-km nearby gauges remain available if TOPAGE network is unreachable (never mislabeled upstream)',async()=>{
 const home={code_station:'Y531201001',latitude_station:43.5,longitude_station:6.58,libelle_station:'Home'};
 const nearby={code_station:'Y444444444',latitude_station:43.52,longitude_station:6.23,libelle_station:'Other river'};
 const fetchImpl=async input=>{
  const url=new URL(input);
  if(url.pathname.includes('/geo/topage2025'))throw Error('WFS timeout');
  return new Response(JSON.stringify({data:url.searchParams.has('code_station')?[home]:[home,nearby]}),{
   headers:{'Content-Type':'application/json'}});
 };
 const result=await findLocalUpstream('Y531201001',{fetchImpl});
 assert.equal(result.connectivityCoverage,'not-verified');
 assert.deepEqual(result.candidates,[],'Unknown network must never create a verified upstream gauge');
 assert.equal(result.nearby.length,1,'Nearby discovery still works');
 assert.equal(result.nearby[0].code,'Y444444444');
 assert.ok(result.nearby[0].distanceKm<=40);
});

test('Hub Eau INSEE department codes, not hydrographic prefixes, decide local vigilance',async()=>{
 for(const [input,expected] of [['6','06'],['83','83'],['2a','2A'],['2B','2B'],['31','31'],['75','75'],['971',null],['99',null],['',null]]){
  assert.equal(normalizeDepartmentCode(input),expected);
 }
 const makeStation=async(code_station,code_departement,libelle_departement)=>resolveStation(code_station,{
  fetchImpl:async()=>new Response(JSON.stringify({data:[{
   code_station,latitude_station:43.45,longitude_station:6.63,libelle_station:'Gauge',
   code_departement,libelle_departement
  }]}),{headers:{'Content-Type':'application/json'}})
 });
 const roq=await makeStation('Y531201001','83','VAR');
 assert.equal(roq.department,'83');assert.equal(roq.departmentName,'VAR');
 const other=await makeStation('O200004001','31','HAUTE-GARONNE');
 assert.equal(other.department,'31');assert.equal(other.departmentName,'HAUTE-GARONNE');
 const corsica=await makeStation('X123456789','2A','CORSE-DU-SUD');
 assert.equal(corsica.department,'2A');
});
