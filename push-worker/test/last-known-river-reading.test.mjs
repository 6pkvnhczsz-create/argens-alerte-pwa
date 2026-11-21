import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const start=html.indexOf("const LAST_RIVER_READING_KEY=");
const end=html.indexOf("async function loadMeasurements(",start);
assert.ok(start>0&&end>start,'cached display functions present');
const code=html.slice(start,end);
function harness(){
 const storage=new Map(),elements=new Map();
 const el=id=>{if(!elements.has(id))elements.set(id,{dataset:{},textContent:'',hidden:false,style:{}});return elements.get(id)};
 const ctx={localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},Date,Number,JSON,Intl,
 document:{documentElement:{lang:'fr'},querySelector:el},level:el('#level'),
 mapText:(fr,en)=>fr,renderWaterFreshness:()=>{},console};
 vm.createContext(ctx);vm.runInContext(code,ctx);
 return {ctx,storage,el,save:(...a)=>vm.runInContext('saveLastRiverReading',ctx)(...a),show:c=>vm.runInContext('showLastRiverReading',ctx)(c)};
}
test('valid reading is stored per station and restored as clearly non-live',()=>{
 const h=harness(),date=new Date(Date.now()-65*60000);
 h.save('Y531201001',{value:5200,date},'hubeau');
 assert.equal(h.show('Y531201001'),true);
 assert.equal(h.el('#level').textContent,'5,20');
 assert.equal(h.el('.hero').dataset.alert,'unknown');
 assert.match(h.el('#status').textContent,/aucune alerte calculée/);
 assert.equal(Number(h.el('#stationUpdated').dataset.cachedTime),date.getTime());
 assert.equal(h.show('Y531201002'),false);
});
test('invalid, future and out-of-range saved readings are rejected',()=>{
 const h=harness(),key='argens:last-river-reading:v1:Y531201001';
 for(const entry of [{value:5000,time:'bad'},{value:5000,time:new Date(Date.now()+20*60000).toISOString()},{value:40000,time:new Date().toISOString()}]){
  h.storage.set(key,JSON.stringify(entry));assert.equal(h.show('Y531201001'),false);
 }
});
test('cached reading never calls flood alert calculation or forecast',()=>{
 assert.ok(code.includes("dataset.alert='unknown'"));
 assert.ok(!code.includes('updateHomeAlertFromReadings('));
 assert.ok(!code.includes('renderForecast('));
 assert.match(html,/showLastRiverReading\(code\);/);
});
