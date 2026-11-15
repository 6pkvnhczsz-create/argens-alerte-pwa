import test from 'node:test';
import assert from 'node:assert/strict';
import {boundsForStation,validateBounds,resolveStation,validStationCode} from '../src/piaf-station.mjs';
import {localBboxes,connectedUpstream,recentUpstreamReading} from '../src/upstream-topage.mjs';
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
 assert.deepEqual(boundsForStation(43.4497,6.6331,'Y531201001'),[5.85,43.18,6.91,43.85]);
 const paris=boundsForStation(48.86,2.34,'H123456789');
 assert.deepEqual(paris,[1.81,48.525,2.87,49.195]);
 assert.doesNotThrow(()=>validateBounds(paris));
 assert.throws(()=>boundsForStation(16,-61,'X123456789'),/not available/);
 assert.throws(()=>validateBounds([0,0,10,10]),/exceeds/);
 const sample=await resolveStation('H123456789',{fetchImpl:async()=>new Response(JSON.stringify({
   data:[{code_station:'H123456789',latitude_station:48.86,longitude_station:2.34,libelle_station:'Paris'}]
 }),{headers:{'Content-Type':'application/json'}})});
 assert.equal(sample.name,'Paris');
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
