import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import {
 UPSTREAM_STATIONS, RAIN_AREAS, parseUpstreamPoints, parseRainEstimate,
 parseMeteoVigilance, fetchOfficialVigilance, parseRainForecast, fetchRainForecast, fetchRainArea, fetchRadarCatalogue, buildEarlySignals,
 refreshEarlySignals, loadEarlySignals
} from '../src/early-signals.mjs';

const NOW=Date.parse('2026-11-15T14:00:00Z');
const iso=x=>new Date(x).toISOString();
function fixtureOfficial(){
 return {product:{update_time:iso(NOW-3600000),
  periods:[{echeance:'J',begin_validity_time:iso(NOW-2*3600000),
  end_validity_time:iso(NOW+8*3600000),
  timelaps:{domain_ids:[{domain_id:'83',max_color_id:'3',
   phenomenon_items:[{phenomenon_id:'2',phenomenon_max_color_id:'3'},{phenomenon_id:'4',phenomenon_max_color_id:'1'}]},
   {domain_id:'84',max_color_id:'4',phenomenon_items:[]}]}},
   {echeance:'J1',begin_validity_time:iso(NOW+8*3600000),
    end_validity_time:iso(NOW+32*3600000),timelaps:{domain_ids:[{domain_id:'83',max_color_id:'2',phenomenon_items:[]}]}}
  ]
 }};
}
test('only documented, distinct upstream Argens tributary stations are selected',()=>{
 assert.equal(UPSTREAM_STATIONS.length,5);
 assert.equal(new Set(UPSTREAM_STATIONS.map(x=>x.code)).size,5);
 assert.deepEqual(UPSTREAM_STATIONS.map(x=>x.code),['Y511201001','Y530501501','Y520201001','Y523501002','Y521502002']);
 assert.deepEqual(UPSTREAM_STATIONS.map(x=>x.river),['Argens','Endre','Argens','Nartuby','Aille']);
 assert.deepEqual(UPSTREAM_STATIONS.map(x=>x.name),['Carcès · Argens','Le Muy · Endre','Les Arcs · Argens','Trans-en-Provence · Nartuby','Vidauban · Aille']);
});
test('upstream rates use individual station trends, never compare different gauge zeroes',()=>{
 const points=[{time:NOW-5*60000,mm:1450},{time:NOW-65*60000,mm:1100},{time:NOW-115*60000,mm:900}];
 const r=parseUpstreamPoints(points,NOW);
 assert.equal(r.status,'current');
 assert.equal(r.levelM,1.45);
 assert.equal(r.trendCmH,35);
 assert.throws(()=>parseUpstreamPoints([{time:NOW-4*3600000,mm:900},{time:NOW-5*3600000,mm:800}],NOW),/Stale/);
});

test('upstream observations must be recent and have an actual measured trend',()=>{
 const good=[{time:NOW-25*60000,mm:1250},{time:NOW-85*60000,mm:1180}];
 assert.equal(parseUpstreamPoints(good,NOW).status,'current');
 assert.throws(()=>parseUpstreamPoints([{time:NOW-91*60000,mm:1250},{time:NOW-151*60000,mm:1180}],NOW),/Stale/);
 assert.throws(()=>parseUpstreamPoints([{time:NOW-5*60000,mm:1250},{time:NOW-15*60000,mm:1180}],NOW),/baseline/);
});
test('only working upstream gauges are returned, unavailable gauges remain candidates',async()=>{
 const now=Date.now(),created=time=>new Date(time).toISOString();
 const fetchImpl=async url=>{
  if(String(url).includes('hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr')){
   const station=new URL(url).searchParams.get('code_entite');
   if(station==='Y511201001')return {ok:true,json:async()=>({data:[
    {date_obs:created(now-10*60000),resultat_obs:1100},
    {date_obs:created(now-70*60000),resultat_obs:1050}
   ]})};
   if(station==='Y530501501')return {ok:true,json:async()=>({data:[
    {date_obs:created(now-91*60000),resultat_obs:1200},
    {date_obs:created(now-151*60000),resultat_obs:1100}
   ]})};
  }
  return {ok:false,status:503};
 };
 const out=await buildEarlySignals({}, {now,fetchImpl});
 assert.equal(out.upstreamStationsChecked,5);
 assert.deepEqual(out.upstream.map(x=>x.code),['Y511201001']);
 assert.equal(out.upstream[0].trendCmH,5);
 assert.equal(out.changesFloodThresholds,false);
});

test('model rain accumulates past hourly estimates, never claims radar measurement',()=>{
 const hours=Array.from({length:8},(_,i)=>Math.floor((NOW-(8-i)*3600000)/1000));
 const weather={hourly:{time:hours,precipitation:Array(8).fill(2)}};
 const result=parseRainEstimate(weather,NOW);
 assert.equal(result.status,'estimated');
 assert.equal(result.last3hMm,4);
 assert.equal(result.last6hMm,10);
 assert.throws(()=>parseRainEstimate({hourly:{time:hours,precipitation:[1]}},NOW),/Missing/);
 assert.throws(()=>parseRainEstimate({hourly:{time:hours.slice(0,2),precipitation:[2,2]}},NOW),/Incomplete/);
});

test('Météo-France model forecast uses only future hours and rejects incomplete horizons',()=>{
 const hours=Array.from({length:30},(_,i)=>Math.floor((NOW+i*3600000)/1000));
 const result=parseRainForecast({hourly:{time:hours,precipitation:Array(30).fill(1.5)}},NOW);
 assert.equal(result.status,'forecast');
 assert.equal(result.next6hMm,9);
 assert.equal(result.next24hMm,36);
 assert.throws(()=>parseRainForecast({hourly:{time:hours.slice(0,10),precipitation:Array(10).fill(1.5)}},NOW),/Incomplete/);
 assert.throws(()=>parseRainForecast({hourly:{time:hours,precipitation:[1]}},NOW),/Missing/);
});
test('forecast call uses dedicated Météo-France model API, not generic Open-Meteo model',async()=>{
 let captured='';
 const hours=Array.from({length:30},(_,i)=>Math.floor((NOW+i*3600000)/1000));
 const out=await fetchRainForecast(RAIN_AREAS[0],{now:NOW,fetchImpl:async url=>{
  captured=String(url);
  return {ok:true,json:async()=>({hourly:{time:hours,precipitation:Array(30).fill(0.5)}})};
 }});
 assert.equal(new URL(captured).pathname,'/v1/meteofrance');
 assert.equal(out.next6hMm,3);
 assert.equal(out.status,'forecast');
});
test('forecast failover uses Open-Meteo best-match when the Météo-France model endpoint fails',async()=>{
 const hours=Array.from({length:30},(_,i)=>Math.floor((NOW+i*3600000)/1000));
 const urls=[];
 const out=await fetchRainForecast(RAIN_AREAS[0],{now:NOW,fetchImpl:async url=>{
  urls.push(new URL(url).pathname);
  if(url.includes('/v1/meteofrance'))return {ok:false,status:503};
  return {ok:true,json:async()=>({hourly:{time:hours,precipitation:Array(30).fill(1)}})};
 }});
 assert.deepEqual(urls,['/v1/meteofrance','/v1/forecast']);
 assert.equal(out.model,'open_meteo_best_match');
 assert.equal(out.status,'forecast');
 assert.equal(out.next6hMm,6);
 assert.equal(out.next24hMm,24);
});

test('missing both weather model sources does not invent a forecast',async()=>{
 let calls=0;
 const out=await fetchRainForecast(RAIN_AREAS[0],{now:NOW,fetchImpl:async()=>{
  calls++;return {ok:false,status:503};
 }});
 assert.equal(calls,2);
 assert.equal(out.status,'unavailable');
 assert.equal(out.next24hMm,null);
});

test('radar catalogue only verifies freshness; metadata never masquerades as measured rain',async()=>{
 const secret='RADAR_SECRET_MUST_NOT_APPEAR';
 let seen='';
 const radar=await fetchRadarCatalogue({METEO_FRANCE_API_KEY:secret},{
  now:NOW,fetchImpl:async(url,opts)=>{
   seen=url;
   assert.equal(opts.headers.apikey,secret);
   return {ok:true,json:async()=>({links:[{href:'https://public-api.meteofrance.fr/public/DPRadar/v1/mosaiques/METROPOLE/observations/LAME_D_EAU/produit?maille=500',validity_time:iso(NOW-5*60000)}]})};
  }
 });
 assert.match(seen,/DPRadar\/v1\/mosaiques\/METROPOLE\/observations\/LAME_D_EAU/);
 assert.equal(radar.status,'catalogue_only');
 assert.equal(radar.measurementAvailable,false);
 assert.ok(!JSON.stringify(radar).includes(secret));
 const stale=await fetchRadarCatalogue({METEO_FRANCE_API_KEY:secret},{now:NOW,fetchImpl:async()=>({
  ok:true,json:async()=>({links:[{validity_time:iso(NOW-2*3600000)}]})
 })});
 assert.equal(stale.status,'unavailable');
 assert.equal((await fetchRadarCatalogue({}, {now:NOW,fetchImpl:async()=>{throw Error('must not fetch')}})).status,'not_configured');
});

test('radar access failure is diagnosed without leaking the API key',async()=>{
 const secret='PRIVATE_RADAR_KEY_DO_NOT_LOG';
 for(const [http,expected] of [[401,'radar_http_401'],[403,'radar_http_403'],[429,'radar_http_429']]){
  const out=await fetchRadarCatalogue({METEO_FRANCE_API_KEY:secret},{
   now:NOW,fetchImpl:async()=>({ok:false,status:http,text:async()=>secret})
  });
  assert.equal(out.status,'unavailable');
  assert.equal(out.diagnostic,expected);
  assert.ok(!JSON.stringify(out).includes(secret));
 }
});
test('official vigilance reads Var department (83), not another department and shows proper colors',()=>{
 const parsed=parseMeteoVigilance(fixtureOfficial(),{now:NOW});
 assert.equal(parsed.status,'official');
 assert.equal(parsed.periods.length,2);
 assert.equal(parsed.periods[0].color,'orange');
 assert.equal(parsed.periods[0].phenomena[0].fr,'Pluie-inondation');
 assert.equal(parsed.periods[1].color,'yellow');
 assert.throws(()=>parseMeteoVigilance({...fixtureOfficial(),product:{...fixtureOfficial().product,update_time:iso(NOW-25*3600000)}},{now:NOW}),/Outdated/);
 assert.throws(()=>parseMeteoVigilance({product:{update_time:iso(NOW),periods:[]}},{now:NOW}),/No valid/);
});
test('official warning colors select the right French department, never defaulting to Var',async()=>{
 const a=parseMeteoVigilance(fixtureOfficial(),{now:NOW,department:'84',departmentName:'Vaucluse'});
 assert.equal(a.department,'84');
 assert.equal(a.departmentName,'Vaucluse');
 assert.deepEqual(a.periods.map(p=>p.color),['red']);
 assert.deepEqual(a.periods[0].phenomena,[]);
 assert.equal(a.link,'https://vigilance.meteofrance.fr/fr');
 assert.throws(()=>parseMeteoVigilance(fixtureOfficial(),{now:NOW,department:'06'}),/No valid department/);
 assert.throws(()=>parseMeteoVigilance(fixtureOfficial(),{now:NOW,department:'99'}),/Invalid French department/);
 const api=await fetchOfficialVigilance({METEO_FRANCE_API_KEY:'TEST_ONLY'},{
  department:'84',departmentName:'VAUCLUSE',now:NOW,
  fetchImpl:async()=>({ok:true,json:async()=>fixtureOfficial()})
 });
 assert.equal(api.status,'official');
 assert.equal(api.department,'84');
 assert.equal(api.periods[0].color,'red');
 assert.notEqual(api.periods[0].color,parseMeteoVigilance(fixtureOfficial(),{now:NOW}).periods[0].color);
});
test('Corsican 2A/2B department IDs are matched literally in official vigilance',()=>{
 const input=fixtureOfficial();
 input.product.periods[0].timelaps.domain_ids.push({domain_id:'2A',max_color_id:2,phenomenon_items:[]});
 input.product.periods[0].timelaps.domain_ids.push({domain_id:'2B',max_color_id:4,phenomenon_items:[]});
 assert.equal(parseMeteoVigilance(input,{now:NOW,department:'2A'}).periods[0].color,'yellow');
 assert.equal(parseMeteoVigilance(input,{now:NOW,department:'2B'}).periods[0].color,'red');
});
test('without account, Météo-France is unconfigured, never falsely green',async()=>{
 const r=await fetchOfficialVigilance({}, {now:NOW,fetchImpl:async()=>{throw Error('Must not fetch without subscription')}});
 assert.equal(r.status,'not_configured');assert.equal(r.periods.length,0);assert.match(r.link,/meteofrance.fr/);
});
test('configured Météo-France obtains short lived OAuth2 token and validates official response',async()=>{
 const seen=[];
 const fetchImpl=async(url,options)=>{
  seen.push({url,options});
  if(url.endsWith('/token'))return {ok:true,json:async()=>({access_token:'abcdefghijklmnopqrstuvwxyz',expires_in:3600})};
  assert.equal(options.headers.Authorization,'Bearer abcdefghijklmnopqrstuvwxyz');
  return {ok:true,json:async()=>fixtureOfficial()};
 };
 const r=await fetchOfficialVigilance({METEO_FRANCE_BASIC:'fictional-test-only'}, {now:NOW,fetchImpl});
 assert.equal(r.status,'official');assert.equal(seen.length,2);
 assert.equal(seen[0].options.headers.Authorization,'Basic fictional-test-only');
});
test('Météo-France diagnostics never expose credentials, token body or URL',async()=>{
 const secret='SUPER_PRIVATE_DO_NOT_EXPOSE';
 const cases=[
  {status:401,phase:'token',expected:'token_http_401'},
  {status:403,phase:'bulletin',expected:'bulletin_http_403'},
  {status:503,phase:'bulletin',expected:'bulletin_http_503'}
 ];
 for(const c of cases){
  const fetchImpl=async(url)=>{
   if(url.endsWith('/token'))return c.phase==='token'?{ok:false,status:c.status}:{ok:true,json:async()=>({access_token:'verylongplaceholder-access-token-123',expires_in:3600})};
   return {ok:false,status:c.status};
  };
  const r=await fetchOfficialVigilance({METEO_FRANCE_BASIC:secret+c.expected},{now:NOW,fetchImpl});
  assert.equal(r.status,'unavailable');
  assert.equal(r.diagnostic,c.expected);
  assert.ok(!JSON.stringify(r).includes(secret));
  assert.equal(r.periods.length,0);
 }
});
test('Météo-France malformed bulletin uses generic safe diagnostic',async()=>{
 const r=await fetchOfficialVigilance({METEO_FRANCE_BASIC:'test-key-throw-json-error'},{
  now:NOW,fetchImpl:async(url)=>url.endsWith('/token')?
   {ok:true,json:async()=>({access_token:'abcdefghijklmnopqrstuvwx',expires_in:3600})}:
   {ok:true,json:async()=>{throw Error('sensitive-diagnostic-should-not-escape')}}});
 assert.equal(r.status,'unavailable');
 assert.equal(r.diagnostic,'bulletin_invalid_json');
 assert.ok(!JSON.stringify(r).includes('sensitive'));
});

test('OAuth and official bulletin network failures report safe separate stages',async()=>{
 for(const c of [{phase:'token',expected:'token_fetch_failed'},{phase:'bulletin',expected:'bulletin_fetch_failed'}]){
  const fetchImpl=async url=>{
   if(url.endsWith('/token')){
    if(c.phase==='token')throw Error('connection details SECRET');
    return {ok:true,json:async()=>({access_token:'this-is-an-access-token-with-sufficient-length',expires_in:3600})};
   }
   throw Error('upstream SECRET connection refused');
  };
  const r=await fetchOfficialVigilance({METEO_FRANCE_BASIC:'PRIVATE_CRED_'+c.phase},{now:NOW,fetchImpl});
  assert.equal(r.diagnostic,c.expected);
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.ok(!JSON.stringify(r).includes('PRIVATE_CRED'));
 }
});
test('Météo-France OAuth HTTP 200 with HTML is classified safely without leaking the body',async()=>{
 const privateText='TOP_SECRET';
 const res=await fetchOfficialVigilance({METEO_FRANCE_BASIC:'TEST_HTML_BLOCK'},{
  now:NOW,
  fetchImpl:async url=>url.endsWith('/token')?
   {ok:true,headers:{get:()=> 'text/html; charset=utf-8'},redirected:true,json:async()=>{throw Error(privateText)}}:
   {ok:true,json:async()=>fixtureOfficial()}
 });
 assert.equal(res.diagnostic,'token_html_redirect');
 assert.ok(!JSON.stringify(res).includes(privateText));
 const plain=await fetchOfficialVigilance({METEO_FRANCE_BASIC:'TEST_PLAIN_BLOCK'},{
  now:NOW,fetchImpl:async()=>({ok:true,headers:{get:()=> 'text/plain'},json:async()=>{throw Error('another private value')}})});
 assert.equal(plain.diagnostic,'token_text_response');
});

test('Météo-France API key auth bypasses OAuth portal and parses official Var bulletin',async()=>{
 let calls=0;
 const fetchImpl=async(url,options)=>{
  calls++;
  assert.ok(!url.endsWith('/token'),'Do not hit OAuth portal in API key mode');
  assert.equal(options.headers.apikey,'SENSITIVE_DO_NOT_LOG');
  assert.ok(!('Authorization' in options.headers));
  return {ok:true,json:async()=>fixtureOfficial()};
 };
 const r=await fetchOfficialVigilance({
   METEO_FRANCE_API_KEY:'SENSITIVE_DO_NOT_LOG',
   METEO_FRANCE_BASIC:'Invalid old OAuth key'
  },{now:NOW,fetchImpl});
 assert.equal(r.status,'official');
 assert.equal(r.periods[0].color,'orange');
 assert.equal(calls,1);
 assert.ok(!JSON.stringify(r).includes('SENSITIVE_DO_NOT_LOG'));
});
test('Vigilance permission failure on API key retries a separately configured OAuth2 account',async()=>{
 const calls=[];
 const fetchImpl=async(url,options)=>{
  if(url.endsWith('/token')){
   calls.push('oauth-token');
   assert.equal(options.headers.Authorization,'Basic TEST_ONLY_FALLBACK_BASIC');
   return {ok:true,json:async()=>({access_token:'oauth-fallback-vigilance-test-token',expires_in:3600})};
  }
  if(options.headers.apikey){
   calls.push('key-rejected');
   assert.equal(options.headers.apikey,'TEST_ONLY_KEY_FOR_OTHER_PRODUCTS');
   return {ok:false,status:403};
  }
  calls.push('oauth-bulletin');
  assert.equal(options.headers.Authorization,'Bearer oauth-fallback-vigilance-test-token');
  return {ok:true,json:async()=>fixtureOfficial()};
 };
 const r=await fetchOfficialVigilance({
  METEO_FRANCE_API_KEY:'TEST_ONLY_KEY_FOR_OTHER_PRODUCTS',
  METEO_FRANCE_BASIC:'TEST_ONLY_FALLBACK_BASIC'
 },{now:NOW,fetchImpl});
 assert.equal(r.status,'official');
 assert.equal(r.periods[0].color,'orange');
 assert.deepEqual(calls,['key-rejected','oauth-token','oauth-bulletin']);
 assert.ok(!JSON.stringify(r).includes('TEST_ONLY'));
});
test('API key failure does not claim any valid official warnings',async()=>{
 const r=await fetchOfficialVigilance({METEO_FRANCE_API_KEY:'DO_NOT_LOG'},{
  now:NOW,fetchImpl:async()=>({ok:false,status:401})
 });
 assert.equal(r.status,'unavailable');
 assert.equal(r.diagnostic,'bulletin_http_401');
 assert.equal(r.periods.length,0);
 assert.ok(!JSON.stringify(r).includes('DO_NOT_LOG'));
});
test('independent data errors never generate flood alerts or artificial official levels',async()=>{
 const fetchImpl=async()=>({ok:false,status:503});
 const data=await buildEarlySignals({}, {now:NOW,fetchImpl});
 assert.equal(data.upstream.length,0);assert.equal(data.upstreamStationsChecked,5);
 assert.equal(data.rain.length,3);assert.ok(data.rain.every(x=>x.status==='unavailable'));
 assert.equal(data.official.status,'not_configured');
 assert.equal(data.radar.status,'not_configured');
 assert.ok(data.forecast.every(x=>x.status==='unavailable'));
 assert.ok(data.radar.measurementAvailable===false);
 assert.equal(data.changesFloodThresholds,false);
 assert.equal(data.interpretation,'information_only');
});
test('D1 cache must be recent, rejects stale indicator data',async()=>{
 let row=null;const db={prepare(sql){
  let args=[];return {bind(...x){args=x;return this},async run(){
   if(sql.startsWith('INSERT INTO early_signals'))row={checked_ms:args[1],payload:args[2]};
  },async first(){return row}};
 }};
 const fetchImpl=async()=>({ok:false,status:503});
 const saved=await refreshEarlySignals({DB:db},{now:NOW,fetchImpl});
 assert.equal(saved.ok,true);
 assert.equal((await loadEarlySignals(db,{now:NOW+100000})).station,'Y531201001');
 await assert.rejects(()=>loadEarlySignals(db,{now:NOW+26*60000}),/stale/);
});
test('PWA forecast startup can access its upstream loader without a ReferenceError',()=>{
 const page=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
 const loader=page.indexOf('async function refreshMissingUpstreamReadings(existing){');
 const render=page.indexOf('function renderEarlySignals(){');
 const startup=page.indexOf('async function loadEarlySignalsPanel(){');
 assert.ok(loader>0&&render>0&&startup>0,'All forecast functions must exist');
 assert.ok(loader<render&&render<startup,'Upstream loader must be in shared script scope before startup');
 assert.match(page,/if\(argens\)void refreshMissingUpstreamReadings\(upstreamKnownReadings\)/);
 const inline=[...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(Boolean);
 for(const script of inline)assert.doesNotThrow(()=>new Script(script));
});
test('worker surface is information only, does not rewrite warning functions',()=>{
 const src=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 const page=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
 assert.match(src,/url.pathname==='\x2fapi\x2fearly-signals'/);
 assert.match(src,/ctx\.waitUntil\(refreshEarlySignals\(env\)/);
 assert.match(src,/function levelFor\(metres,rate\)\{return metres>=4\.5\?'red':metres>=3/);
 assert.match(src,/const rapidLevel=obs.rate!==null&&obs.rate>=50\?'red':obs.rate!==null&&obs.rate>=30/);
 assert.match(page,/id="earlySignalsPanel"/);
 assert.match(page,/id="earlyOfficialLink"/);
 assert.match(page,/id="earlyUpstreamRows"/);
 assert.match(page,/id="earlyRainDisclaimer"/);
 assert.match(page,/<button data-tab="Prévisions">/);
 assert.doesNotMatch(page,/<button data-tab="Groupes">/);
 assert.match(page,/id="forecastPage" class="hidden"/);
 assert.ok(page.indexOf('id="overview"')<page.indexOf('id="forecastPage"'));
 assert.ok(page.indexOf('id="forecastPage"')<page.indexOf('id="earlySignalsPanel"'));
 assert.ok(page.indexOf('id="forecastPage"')<page.indexOf('id="piafForecastPanel"'));
 // Essential live risk information remains on the home page.
 const home=page.slice(page.indexOf('id="overview"'),page.indexOf('id="forecastPage"'));
 const forecastPage=page.slice(page.indexOf('id="forecastPage"'),page.indexOf('id="pushSettings"'));
 assert.match(home,/id="forecastPanel"/);
 assert.match(home,/id="homeOfficialPanel"/);
 assert.match(home,/id="earlyOfficialTitle"/);
 assert.match(home,/id="earlyOfficialPeriods"/);
 assert.doesNotMatch(forecastPage,/id="forecastPanel"/);
 assert.doesNotMatch(forecastPage,/id="earlyOfficialPeriods"/);
 assert.match(forecastPage,/id="rainForecastCard"/);
 assert.match(forecastPage,/id="recentRainCard"/);
 assert.match(forecastPage,/id="upstreamForecastCard"/);
 assert.match(forecastPage,/id="piafForecastPanel"/);
 assert.match(forecastPage,/id="piafLegendBlock"/);
 assert.doesNotMatch(forecastPage,/id="weatherPanel"/);
 assert.ok(forecastPage.indexOf('id="rainForecastCard"')<forecastPage.indexOf('id="recentRainCard"'));
 assert.ok(forecastPage.indexOf('id="recentRainCard"')<forecastPage.indexOf('id="upstreamForecastCard"'));
 assert.ok(forecastPage.indexOf('id="piafForecastPanel"')<forecastPage.indexOf('id="upstreamForecastCard"'),'Animated forecast precedes upstream map');
 assert.match(forecastPage,/id="earlyForecastRows" class="forecast-compact-list"/);
 assert.match(forecastPage,/id="earlyRainRows" class="forecast-compact-list"/);
 assert.match(forecastPage,/id="upstreamMap" class="upstream-map"/);
 assert.match(page,/function officialUpstreamPosition\(code\)/);
 assert.match(page,/latitude_station/);
 assert.match(page,/longitude_station/);
 assert.match(page,/code_station:code/);
 assert.match(page,/function updateUpstreamMap\(\)/);
 assert.doesNotMatch(forecastPage,/id="weatherSixLabel"/);
 assert.doesNotMatch(forecastPage,/id="weatherDayLabel"/);
 assert.doesNotMatch(forecastPage,/id="officialRadarSource"/);
 assert.doesNotMatch(forecastPage,/id="radarNote"/);
 assert.doesNotMatch(forecastPage,/id="radarDetails"/);
 assert.match(page,/healthState\.weather=forecasts\.length\?'good':'bad'/);
 assert.doesNotMatch(page,/class="map-add-swarm"/);
 assert.match(page,/id="earlyForecastRows"/);
 assert.match(page,/id="piafBand0"/);
 assert.match(page,/id="piafBand5"/);
 assert.match(page,/piaf-palette.js/);
 assert.match(page,/keine Radarmessung/i);
 assert.match(page,/Windy \(externer Anbieter\)/i);
 const inline=[...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(Boolean);
 for(const script of inline) assert.doesNotThrow(()=>new Script(script));
 assert.equal(RAIN_AREAS.length,3);
});

test('local rainfall follows the selected gauge coordinates and remains informational',async()=>{
 const area={id:'home',name:'Gauge elsewhere in France',lat:47.345,lon:2.678};
 const past=Array.from({length:9},(_,i)=>Math.floor((NOW+(i-8)*3600000)/1000));
 const future=Array.from({length:30},(_,i)=>Math.floor((NOW+(i+1)*3600000)/1000));
 let requests=0;
 const fetchImpl=async url=>{
  const request=new URL(url);
  assert.equal(Number(request.searchParams.get('latitude')),area.lat);
  assert.equal(Number(request.searchParams.get('longitude')),area.lon);
  requests++;
  const forecast=request.pathname==='/v1/meteofrance';
  return {ok:true,json:async()=>({hourly:{
   time:forecast?future:past,precipitation:Array(forecast?30:9).fill(forecast?1.5:2)
  }})};
 };
 const [forecast,rain]=await Promise.all([
  fetchRainForecast(area,{now:NOW,fetchImpl}),fetchRainArea(area,{now:NOW,fetchImpl})
 ]);
 assert.equal(requests,2);
 assert.equal(forecast.id,'home');
 assert.equal(forecast.name,area.name);
 assert.equal(forecast.status,'forecast');
 assert.equal(forecast.next6hMm,9);
 assert.equal(forecast.next24hMm,36);
 assert.equal(rain.status,'estimated');
 assert.equal(rain.last3hMm,6);
 assert.equal(rain.last6hMm,12);
 const page=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
 const national=readFileSync(new URL('../../national-upstream.js',import.meta.url),'utf8');
 const backend=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 assert.match(backend,/\/api\/rain\/station/);
 assert.match(backend,/await cachedStation\(code\)/);
 assert.match(page,/local\.station\?\.code===station/);
 assert.match(page,/document\.addEventListener\('argens-station-selected',rainHomeChanged\)/);
 assert.doesNotMatch(national,/\['rainForecastCard','recentRainCard'/);
});

test('missing recent model hours trigger a full-history retry; zero precipitation is valid',async()=>{
 const area=RAIN_AREAS[0],now=NOW+49*60000;
 const hourlyTimes=Array.from({length:9},(_,i)=>Math.floor((now-(8-i)*3600000)/1000));
 const calls=[];
 const fetchImpl=async url=>{
  const query=new URL(url).searchParams;
  assert.equal(Number(query.get('latitude')),area.lat);
  assert.equal(Number(query.get('longitude')),area.lon);
  calls.push(query);
  const complete=query.has('past_days');
  return {ok:true,json:async()=>({hourly:{time:hourlyTimes,
   precipitation:hourlyTimes.map((_,i)=>complete?0:i<7?null:0)}})};
 };
 const result=await fetchRainArea(area,{now,fetchImpl});
 assert.equal(calls.length,2);
 assert.equal(calls[0].get('past_hours'),'8');
 assert.equal(calls[1].get('past_days'),'2');
 assert.equal(result.status,'estimated');
 assert.equal(result.last3hMm,0);
 assert.equal(result.last6hMm,0);
});
test('Argens model fallback preserves all three catchment area IDs',()=>{
 const backend=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 const page=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
 assert.deepEqual(RAIN_AREAS.map(x=>x.id),['central','nartuby','lower']);
 assert.match(backend,/\/api\/rain\/basin/);
 assert.match(backend,/RAIN_AREAS\.map\(area=>fetchRainArea/);
 assert.match(backend,/RAIN_AREAS\.map\(area=>fetchRainForecast/);
 assert.match(page,/get\('\/api\/rain\/basin'\)/);
 assert.match(page,/\['central','nartuby','lower'\]\.map/);
});

test('Argens gauges remain individually visible and use concurrent independent requests',()=>{
 const page=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
 assert.match(page,/async function refreshMissingUpstreamReadings\(existing\)/);
 assert.match(page,/Promise\.all\(\[fromWorker\(\),fromHubeau\(\)\]\)/);
 assert.match(page,/upstreamFetchInProgress/);
 assert.match(page,/Messwert nicht verfügbar/);
 assert.match(page,/UPSTREAM_CONFLUENCE_ORDER\.map\(\(code,i\)=>/);
 assert.match(page,/saveCachedUpstreamGauges\(merged\)/);
 assert.match(page,/if\(argens\)void refreshMissingUpstreamReadings\(upstreamKnownReadings\)/);
 const loader=page.indexOf('async function refreshMissingUpstreamReadings(existing)');
 const renderer=page.indexOf('function renderEarlySignals(){');
 assert.ok(loader>0&&loader<renderer,'Independent gauge function must be in shared scope');
});
