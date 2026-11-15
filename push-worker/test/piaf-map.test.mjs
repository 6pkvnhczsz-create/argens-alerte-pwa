import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePiafCapabilities,buildPiafMapUrl,fetchPiafFrame,PIAF_LAYER} from '../src/piaf-map.mjs';
const now=Date.parse('2026-11-15T20:30:00Z'),run='2026-11-15T20:25:00Z';
const layer=PIAF_LAYER;
const xml=`<?xml version="1.0"?><WMS_Capabilities><Capability><Layer><Layer><Name>${layer}</Name>
<Dimension name="reference_time" default="${run}">2026-11-15T20:20:00Z,${run}</Dimension>
<Dimension name="time" default="2026-11-15T20:30:00Z">2026-11-15T20:30:00Z,2026-11-15T20:35:00Z,2026-11-15T20:40:00Z</Dimension>
<Style><Name>PRECIP__GROUND__NO_SHADING</Name></Style>
<Style><Name>PRECIP__GROUND__RADAR_SHADING</Name></Style>
</Layer></Layer></Capability></WMS_Capabilities>`;
const meta=parsePiafCapabilities(xml,{now});
test('approved layer, current run and only real forecast times',()=>{
 assert.equal(meta.source,'Météo-France PIAF');
 assert.equal(meta.referenceTime,run);
 assert.equal(meta.style,'PRECIP__GROUND__RADAR_SHADING');
 assert.deepEqual(meta.frames,['2026-11-15T20:30:00Z','2026-11-15T20:35:00Z','2026-11-15T20:40:00Z']);
 assert.equal(meta.kind,'forecast_5min');
 assert.equal(meta.notFloodForecast,true);
});
test('WMS request keeps time, reference time, colour style and EPSG:4326 latitude-first BBOX',()=>{
 const url=new URL(buildPiafMapUrl(meta,meta.frames[0]));
 assert.equal(url.hostname,'api.meteofrance.fr');
 assert.equal(url.searchParams.get('reference_time'),run);
 assert.equal(url.searchParams.get('time'),meta.frames[0]);
 assert.equal(url.searchParams.get('crs'),'EPSG:4326');
 assert.equal(url.searchParams.get('bbox'),'43.18,5.85,43.85,6.91');
 assert.equal(url.searchParams.get('layers'),PIAF_LAYER);
 assert.equal(url.searchParams.get('styles'),'PRECIP__GROUND__RADAR_SHADING');
 assert.equal(url.searchParams.get('transparent'),'true');
 assert.throws(()=>buildPiafMapUrl(meta,'2026-11-15T22:00:00Z'),/Unlisted/);
});
test('unavailable styles, expired runs and invalid metadata fail closed',()=>{
 assert.throws(()=>parsePiafCapabilities(xml.replace('PRECIP__GROUND__RADAR_SHADING','NO_COLOURED_STYLE'),{now}),/No PIAF/);
 assert.throws(()=>parsePiafCapabilities(xml,{now:now+2*3600000}),/old/);
 assert.throws(()=>parsePiafCapabilities('<?xml version="1.0"?><Error>oops</Error>',{now}),/Invalid/);
});
test('a PNG is returned only if type, size and header are valid',async()=>{
 const png=new Uint8Array(64);png.set([137,80,78,71,13,10,26,10],0);
 const dv=new DataView(png.buffer);dv.setUint32(16,720);dv.setUint32(20,500);
 const result=await fetchPiafFrame({METEO_FRANCE_PIAF_API_KEY:'test-local'},meta,meta.frames[0],{
  fetchImpl:async(_url,opts)=>{
   assert.equal(opts.headers.apikey,'test-local');
   return new Response(png,{headers:{'Content-Type':'image/png'}});
  }
 });
 assert.equal(result.length,64);
 await assert.rejects(fetchPiafFrame({METEO_FRANCE_PIAF_API_KEY:'test-local'},meta,meta.frames[0],{
  fetchImpl:async()=>new Response('<xml/>',{headers:{'Content-Type':'text/xml'}})
 }),/no PNG/);
});
