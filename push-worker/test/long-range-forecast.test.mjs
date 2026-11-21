import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LONG_RANGE_DAYS,parseLongRangeForecast,fetchLongRangeForecast} from '../src/long-range-forecast.mjs';
const NOW=Date.parse('2026-11-18T15:00:00Z');
const dates=Array.from({length:10},(_,i)=>new Date(Date.parse('2026-11-18T12:00:00Z')+i*86400000).toISOString().slice(0,10));
const data=()=>({
 timezone:'Europe/Paris',
 daily:{
  time:[...dates],
  weather_code:[0,1,2,3,61,63,65,80,95,71],
  temperature_2m_max:[13,12,14,17,15,14,11,10,9,6],
  temperature_2m_min:[6,5,8,7,9,7,5,3,2,-1],
  precipitation_sum:[0,1.2,2.3,0,8.4,6,2,12.6,15,1.1],
  precipitation_probability_max:[0,10,30,20,60,70,50,80,90,40]
 }
});
test('ten full locally-dated days, no fabricated daily rain numbers',()=>{
 const x=parseLongRangeForecast(data(),NOW);
 assert.equal(x.status,'forecast');
 assert.equal(x.days.length,10);
 assert.equal(x.days[0].date,'2026-11-18');
 assert.equal(x.days[0].precipitation_mm,0);
 assert.equal(x.days[7].precipitation_mm,12.6);
 assert.equal(x.days[7].reliability,'low');
 assert.equal(x.model,'open_meteo_best_match');
 assert.equal(x.notForAlerts,true);
 assert.equal(LONG_RANGE_DAYS,10);
});
test('zero precipitation and zero probability are valid; missing probability remains unknown',()=>{
 const d=data();d.daily.precipitation_probability_max[9]=null;
 const x=parseLongRangeForecast(d,NOW);
 assert.equal(x.days[0].precipitation_probability_pct,0);
 assert.equal(x.days[9].precipitation_probability_pct,null);
});
test('missing, stale, duplicate, invalid and implausible days are rejected instead of shown as valid 10-day outlooks',()=>{
 const incomplete=data();incomplete.daily.precipitation_sum[8]=null;
 assert.throws(()=>parseLongRangeForecast(incomplete,NOW),/Missing or implausible/);
 const len=data();len.daily.time.pop();
 assert.throws(()=>parseLongRangeForecast(len,NOW),/Incomplete/);
 const order=data();order.daily.time[8]=order.daily.time[7];
 assert.throws(()=>parseLongRangeForecast(order,NOW),/Nonconsecutive/);
 const stale=data();stale.daily.time=stale.daily.time.map(d=>new Date(Date.parse(d+'T12:00:00Z')-10*86400000).toISOString().slice(0,10));
 assert.throws(()=>parseLongRangeForecast(stale,NOW),/Outdated/);
 const invalid=data();invalid.daily.precipitation_probability_max[0]=200;
 assert.throws(()=>parseLongRangeForecast(invalid,NOW),/probability/);
 const negative=data();negative.daily.precipitation_sum[0]=-1;
 assert.throws(()=>parseLongRangeForecast(negative,NOW),/Missing or implausible/);
 const timezone=data();timezone.timezone='UTC';
 assert.throws(()=>parseLongRangeForecast(timezone,NOW),/timezone/);
});
test('forecast uses selected station official coordinates, local timezone and best-match 10-day source',async()=>{
 const location={code:'Y531201001',name:'Roquebrune',lat:43.44,lon:6.64};
 let calls=0;
 const fetchImpl=async(url,options)=>{
  calls++;
  const req=new URL(url);
  assert.equal(req.origin,'https://api.open-meteo.com');
  assert.equal(req.pathname,'/v1/forecast');
  assert.equal(req.searchParams.get('latitude'),'43.44');
  assert.equal(req.searchParams.get('longitude'),'6.64');
  assert.equal(req.searchParams.get('forecast_days'),'10');
  assert.equal(req.searchParams.get('timezone'),'Europe/Paris');
  for(const name of ['precipitation_sum','precipitation_probability_max','temperature_2m_max','temperature_2m_min','weather_code'])
   assert.ok(req.searchParams.get('daily').includes(name));
  assert.equal(options.cf.cacheTtl,1800);
  return {ok:true,json:async()=>data()};
 };
 const result=await fetchLongRangeForecast(location,{now:NOW,fetchImpl});
 assert.equal(calls,1);
 assert.equal(result.ok,true);
 assert.equal(result.station.code,location.code);
 assert.equal(result.days.length,10);
 assert.equal(result.informationalOnly,true);
});
test('unverified or out-of-France coordinates cannot be sent to forecast provider',async()=>{
 let count=0;
 const fetchImpl=()=>{count++;throw Error('must not fetch')};
 await assert.rejects(fetchLongRangeForecast({code:'X',lat:0,lon:0},{fetchImpl}),/coordinates/);
 assert.equal(count,0);
});
test('page renders expandable 10-day forecast independently of alert and Météo-France short horizon',()=>{
 const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
 const backend=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 assert.ok(html.includes('id="longRangeDetails"'));
 assert.ok(html.includes('id="longRangeDays"'));
 assert.ok(html.includes('Langzeitvorhersage · 10 Tage'));
 assert.ok(html.includes('Regenmengen ab Tag 8 sind besonders unsicher'));
 assert.ok(html.includes('void loadLongRangeForecast(station)'));
 assert.ok(html.includes('argens-language-changed'));
 assert.ok(backend.includes("url.pathname==='/api/forecast/long-range'"));
 assert.ok(backend.includes('const station=await informationalStation(code)'));
 assert.ok(backend.includes('notForAlerts:true'));
 assert.ok(!backend.includes('sendFloodAlarmForLongRange'));
});

// Regression: the public 10-day card must work even when the Cloudflare Worker
// is not deployed or the hydrometry register is temporarily unavailable.
test('direct Open-Meteo browser fallback works without a Cloudflare Worker or Météo-France access',async()=>{
 const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
 const start=html.indexOf('async function loadOpenMeteoDirect(station){');
 const end=html.indexOf('\nasync function loadLongRangeForecast(station){',start);
 assert.ok(start>0&&end>start,'Direct browser forecast function exists');
 assert.match(html,/Promise\.any\(\[loadOpenMeteoDirect\(station\),worker\(\)\]\)/);
 const factory=new Function('fetch','ROQUEBRUNE_STATION_FALLBACK','LOCAL_RAIN_DEFAULT',
  'AbortSignal','URLSearchParams',html.slice(start,end)+'\nreturn loadOpenMeteoDirect;');
 const todayParts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{
  timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'
 }).formatToParts(new Date()).map(p=>[p.type,p.value]));
 const startUtc=Date.UTC(Number(todayParts.year),Number(todayParts.month)-1,Number(todayParts.day));
 const dates=Array.from({length:10},(_,i)=>new Date(startUtc+i*86400000).toISOString().slice(0,10));
 const payload={daily:{time:dates,weather_code:dates.map(()=>3),
  temperature_2m_max:dates.map(()=>19),temperature_2m_min:dates.map(()=>10),
  precipitation_sum:dates.map(()=>2),precipitation_probability_max:dates.map(()=>50)}};
 let requests=0;
 const browserFetch=async url=>{
  requests++;
  const parsed=new URL(url);
  assert.equal(parsed.origin,'https://api.open-meteo.com');
  assert.equal(parsed.searchParams.get('forecast_days'),'10');
  assert.equal(parsed.searchParams.get('timezone'),'Europe/Paris');
  return {ok:true,json:async()=>payload};
 };
 const load=factory(browserFetch,{lat:43.4497,lon:6.6331},'Y531201001',AbortSignal,URLSearchParams);
 const forecast=await load('Y531201001');
 assert.equal(requests,1);
 assert.equal(forecast.ok,true);
 assert.equal(forecast.status,'forecast');
 assert.equal(forecast.source,'Open-Meteo · direct');
 assert.equal(forecast.days.length,10);
 assert.equal(forecast.days[0].date,dates[0]);
 assert.equal(forecast.days[0].precipitation_mm,2);
});
