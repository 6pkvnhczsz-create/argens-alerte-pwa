import test from 'node:test';
import assert from 'node:assert/strict';
import {
 getHydroObservations,
 readVigicruesObservations,
 readHubObservations,
 parseHubObservations,
 parseVigicruesObservations,
 validHydroStation
} from '../src/water-sources.mjs';

const date=mins=>new Date(Date.now()-mins*60000).toISOString();
const station='Y531201001';
const hub={data:[{date_obs:date(10),resultat_obs:5400},{date_obs:date(70),resultat_obs:5100}]};
const vig={Serie:{CdStationHydro:station,GrdSerie:'H',ObssHydro:[{DtObsHydro:date(70),ResObsHydro:5.1},{DtObsHydro:date(10),ResObsHydro:5.4}]}};
const mock=(primary,backup)=>(url)=>Promise.resolve({
 ok:url.includes('hubeau.eaufrance.fr')?primary.ok:backup.ok,
 status:url.includes('hubeau.eaufrance.fr')?(primary.status||200):(backup.status||200),
 json:async()=>url.includes('hubeau.eaufrance.fr')?primary.body:backup.body
});

test('uses Hub Eau when the primary readings are current',async()=>{
 const result=await getHydroObservations(station,{fetchImpl:mock({ok:true,body:hub},{ok:false,status:503})});
 assert.equal(result.source,'hubeau');
 assert.equal(result.points[0].mm,5400);
});

test('falls back to Vigicrues when Hub Eau is down and converts metres to millimetres',async()=>{
 const result=await getHydroObservations(station,{fetchImpl:mock({ok:false,status:503},{ok:true,body:vig})});
 assert.equal(result.source,'vigicrues');
 assert.equal(result.points[0].mm,5400);
 assert.equal(result.points[1].mm,5100);
});

test('switches if Hub Eau responds but has stale readings',async()=>{
 const old={data:[{date_obs:date(350),resultat_obs:5400}]};
 const result=await getHydroObservations(station,{fetchImpl:mock({ok:true,body:old},{ok:true,body:vig})});
 assert.equal(result.source,'vigicrues');
});

test('supports Vigicrues epoch-millisecond timestamps as well as ISO',()=>{
 const now=Date.now();
 const payload={Serie:{CdStationHydro:station,ObssHydro:[
  {DtObsHydro:now-600000,ResObsHydro:5.4},
  {DtObsHydro:now-3600000,ResObsHydro:5.1}
 ]}};
 const points=parseVigicruesObservations(payload,station);
 assert.equal(points[0].mm,5400);
 assert.equal(points[0].time,now-600000);
});

test('rejects a response identifying a different station',()=>{
 assert.throws(()=>parseVigicruesObservations({Serie:{CdStationHydro:'E541000401',ObssHydro:vig.Serie.ObssHydro}},station),/mismatch/);
});

test('rejects missing numeric values rather than converting null to a false zero',()=>{
 const readings=parseHubObservations({data:[{date_obs:date(10),resultat_obs:null}]});
 assert.equal(readings.length,0);
});

test('rejects stale backup measurements',async()=>{
 const old={Serie:{CdStationHydro:station,ObssHydro:[
  {DtObsHydro:date(320),ResObsHydro:5.4},
  {DtObsHydro:date(380),ResObsHydro:5.1}
 ]}};
 await assert.rejects(()=>readVigicruesObservations(station,{fetchImpl:mock({ok:false,status:503},{ok:true,body:old})}),/unavailable/);
});

test('rejects implausible flood level values',async()=>{
 const broken={Serie:{CdStationHydro:station,ObssHydro:[
  {DtObsHydro:date(10),ResObsHydro:9000},
  {DtObsHydro:date(70),ResObsHydro:5.1}
 ]}};
 await assert.rejects(()=>readVigicruesObservations(station,{fetchImpl:mock({ok:false,status:503},{ok:true,body:broken})}),/unavailable/);
});

test('fails closed when both providers are unavailable',async()=>{
 await assert.rejects(()=>getHydroObservations(station,{fetchImpl:mock({ok:false,status:503},{ok:false,status:503})}),/Both water sources unavailable/);
});

test('only permits canonical hydrometric station codes',()=>{
 assert.equal(validHydroStation(station),true);
 assert.equal(validHydroStation('https://example.com'),false);
 assert.equal(validHydroStation('../secret'),false);
});

test('Cloudflare hydrometry requests use only one compatible cache directive',async()=>{
 const called=[];
 const fetchImpl=async(url,options)=>{
  called.push({url,options});
  return {ok:true,status:200,json:async()=>hub};
 };
 const result=await readHubObservations(station,{fetchImpl});
 assert.equal(result.source,'hubeau');
 assert.equal(called.length,1);
 assert.equal(called[0].options.cf.cacheTtl,0);
 assert.equal(called[0].options.cache,undefined,'Do not combine cache: no-store with cf.cacheTtl: 0 in Cloudflare Workers');
});

test('tries canonical Vigicrues route before legacy index.php',async()=>{
 const called=[];
 const fetchImpl=async(url)=>{
  called.push(url);
  if(url.includes('/index.php'))return {ok:true,status:200,json:async()=>vig};
  return {ok:false,status:404};
 };
 const data=await readVigicruesObservations(station,{fetchImpl});
 assert.equal(data.source,'vigicrues');
 assert.equal(data.points[0].mm,5400);
 assert.ok(called[0].includes('/services/observations.json?CdStationHydro='+station));
 assert.ok(!called[0].includes('GrdSerie='),'The first request must use the minimal documented Vigicrues query');
 assert.ok(!called[0].includes('FormatDate='),'The first request must omit optional date format parameters');
 assert.ok(called[1].includes('/services/observations.json/index.php?'));
});

test('reports endpoint-specific Vigicrues failures for admin diagnostics',async()=>{
 const fetchImpl=async()=>({ok:false,status:403});
 await assert.rejects(
  ()=>readVigicruesObservations(station,{fetchImpl}),
  error=>error.message.includes('observations.json: HTTP 403')
    &&error.message.includes('index.php: HTTP 403')
    &&error.message.includes('trailing-slash: HTTP 403')
 );
});

test('Hub Eau returns a 200 HTML maintenance page: reject it and use Vigicrues backup',async()=>{
 const calls=[];
 const fetchImpl=async url=>{
  calls.push(url);
  return url.includes('hubeau.eaufrance.fr')?
   new Response('<!DOCTYPE html><title>Site en maintenance</title>',{
    status:200,headers:{'Content-Type':'text/html; charset=UTF-8'}}):
   new Response(JSON.stringify(vig),{
    status:200,headers:{'Content-Type':'application/json'}});
 };
 const result=await getHydroObservations(station,{fetchImpl});
 assert.equal(result.source,'vigicrues');
 assert.equal(result.points[0].mm,5400);
 assert.ok(calls.some(x=>x.includes('observations.json')));
});

test('Hub Eau maintenance HTML is classified, not surfaced as a JSON SyntaxError',async()=>{
 const fetchImpl=async()=>new Response('<!DOCTYPE html><title>Site en maintenance</title>',{
  status:200,headers:{'Content-Type':'text/html'}});
 await assert.rejects(()=>readHubObservations(station,{fetchImpl}),
  error=>/Upstream maintenance: HTML instead of JSON/.test(error.message));
});

test('retries a timed-out Hub Eau request once and keeps primary data when recovered',async()=>{
 let calls=0;
 const fetchImpl=async()=>{
  calls++;
  if(calls===1)throw new DOMException('The operation was aborted due to timeout','TimeoutError');
  return {ok:true,status:206,json:async()=>hub};
 };
 const result=await readHubObservations(station,{fetchImpl});
 assert.equal(result.source,'hubeau');
 assert.equal(calls,2);
});

test('uses Vigicrues backup after both Hub Eau timeout attempts fail',async()=>{
 let hubCalls=0,backupCalls=0;
 const fetchImpl=async url=>{
  if(url.includes('hubeau.eaufrance.fr')){
   hubCalls++;
   throw new DOMException('Timeout','TimeoutError');
  }
  backupCalls++;
  return {ok:true,status:200,json:async()=>vig};
 };
 const result=await getHydroObservations(station,{fetchImpl});
 assert.equal(result.source,'vigicrues');
 assert.equal(hubCalls,2);
 assert.equal(backupCalls,1);
});

test('does not retry Hub Eau maintenance HTML',async()=>{
 let hubCalls=0;
 const fetchImpl=async url=>{
  if(url.includes('hubeau.eaufrance.fr')){
   hubCalls++;
   return new Response('<!DOCTYPE html>',{status:200,headers:{'Content-Type':'text/html'}});
  }
  return {ok:true,status:200,json:async()=>vig};
 };
 const result=await getHydroObservations(station,{fetchImpl});
 assert.equal(result.source,'vigicrues');
 assert.equal(hubCalls,1);
});
