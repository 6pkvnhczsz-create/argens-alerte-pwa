import test from 'node:test';
import assert from 'node:assert/strict';
import {
 getHydroObservations,
 readVigicruesObservations,
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
