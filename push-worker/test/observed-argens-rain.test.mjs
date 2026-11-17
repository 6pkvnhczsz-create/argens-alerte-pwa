import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ARGENS_OBS_IDS,summarizeArgensObservedRain,loadArgensObservedRain} from '../src/observed-argens-rain.mjs';
const H=3600000,now=Date.parse('2026-11-17T16:45:00Z');
const make=(ids=ARGENS_OBS_IDS,number=6,amount=2)=>ids.flatMap(id=>
 Array.from({length:number},(_,i)=>({
  station_id:id,hour_utc:new Date(Date.parse('2026-11-17T15:00:00Z')-i*H).toISOString(),rain_mm:amount
 })));
test('11 real Météo-France stations yield six-hour and three-hour real station-mean totals',()=>{
 const d=summarizeArgensObservedRain(make(),now);
 assert.equal(d.status,'observed');
 assert.equal(d.model,'meteo_france_dpobs');
 assert.equal(d.last3hMm,6);assert.equal(d.last6hMm,12);
 assert.equal(d.stationsUsed,11);assert.equal(d.latestHour,'2026-11-17T15:00:00.000Z');
 assert.equal(d.measurementScope,'average_per_station_not_catchment');
});
test('station mean uses the same reliable station cohort throughout the window',()=>{
 const rows=make(ARGENS_OBS_IDS.slice(0,5),6,1);
 rows.push(...make(ARGENS_OBS_IDS.slice(5,7),6,3));
 const r=summarizeArgensObservedRain(rows,now);
 assert.equal(r.stationsUsed,7);
 assert.equal(r.last6hMm,Math.round((5*6+2*18)/7*10)/10);
});
test('insufficient station availability or a missing hour never becomes a measured zero',()=>{
 assert.equal(summarizeArgensObservedRain(make(ARGENS_OBS_IDS.slice(0,4)),now),null);
 const broken=make(ARGENS_OBS_IDS.slice(0,7)).filter(r=>r.hour_utc!=='2026-11-17T14:00:00.000Z');
 assert.equal(summarizeArgensObservedRain(broken,now),null);
 assert.equal(summarizeArgensObservedRain(make(ARGENS_OBS_IDS.slice(0,6),6,0),now).last6hMm,0);
});
test('old observations never masquerade as recent rain, and unrelated sites are excluded',()=>{
 assert.equal(summarizeArgensObservedRain(make(),now+5*H),null);
 assert.equal(summarizeArgensObservedRain(make(['01014002','01027003','01033001','01008002','01009002']),now),null);
});
test('database outage leaves model fallback available',async()=>{
 assert.equal(await loadArgensObservedRain(null,now),null);
 const db={prepare(){throw Error('D1 unavailable')}};
 assert.equal(await loadArgensObservedRain(db,now),null);
});
test('public UI distinguishes real rain from Open-Meteo estimates, keeping model future forecast',()=>{
 const index=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
 assert.ok(index.includes("x.status==='observed'"));
 assert.ok(index.includes('Gemessener Niederschlag · Météo-France'));
 assert.ok(index.includes('keine flächendeckende Einzugsgebietsmessung'));
 assert.ok(index.includes('Open-Meteo-Modellschätzungen als Ersatz'));
 const worker=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 assert.ok(worker.includes('loadArgensObservedRain(env.DB)'));
 assert.ok(!worker.includes("METEO_FRANCE_OBS_API_KEY") || !worker.includes("loadArgensObservedRain(env.METEO_FRANCE_OBS_API_KEY"));
});
