// Simulate actual forecast page and official Hub'Eau station-coordinate responses.
// This checks that one list per rainfall source and five genuine positioned pins
// work at runtime, without a real network or credential.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
const page=readFileSync(new URL('../index.html',import.meta.url),'utf8')
 .replace(/<script src="\.\/i18n-de\.js"><\/script>/,'');
const codes=['Y511201001','Y530501501','Y520201001','Y523501002','Y521502002'];
const names=['Carcès · Argens','Le Muy · Argens','Les Arcs · Aille','Trans-en-Provence · Nartuby','Vidauban · Endre'];
const coords=[[43.48,6.18],[43.47,6.56],[43.46,6.48],[43.50,6.48],[43.43,6.43]];
const current=new Date(Date.now()-10*60000).toISOString();
const areas=['central','nartuby','lower'];
const model={
 ok:true,checkedAt:new Date().toISOString(),official:{status:'unavailable'},radar:{status:'catalogue_only'},
 forecast:areas.map((id,i)=>({id,name:id,status:'forecast',next6hMm:i+1,next24hMm:i+6})),
 rain:areas.map((id,i)=>({id,name:id,status:'estimated',last3hMm:i+2,last6hMm:i+3})),
 upstream:codes.map((code,i)=>({code,name:names[i],status:'current',levelM:1.1+i*.1,trendCmH:i-2,observedAt:current}))
};
const errors=[],coordRequests=[],pins=[];
const vc=new VirtualConsole();
vc.on('jsdomError',e=>errors.push(String(e?.message||e)));
vc.on('error',e=>errors.push(String(e)));
const map={
 fitBounds(){return this},invalidateSize(){return this},
 setView(){return this}
};
const leaflet={
 map(){return map},
 tileLayer(){return {addTo(){return this}}},
 layerGroup(){return {addTo(){return this},clearLayers(){pins.length=0},addLayer(pin){pins.push(pin);return this}}},
 divIcon(opts){return opts},
 marker(position,opts){return {position,opts,bindTooltip(node,config){this.tooltip=node;this.tooltipOptions=config;return this},bindPopup(node){this.popup=node;return this}}},
 latLngBounds(points){return points},
 circleMarker(){return {bindTooltip(){return {addTo(){}}}}}
};
const dom=new JSDOM(page,{url:'https://riviere-alerte.fr/',runScripts:'dangerously',
 pretendToBeVisual:true,virtualConsole:vc,
 beforeParse(w){
  w.L=leaflet;
  w.scrollTo=()=>{};
  w.matchMedia=()=>({matches:false,addListener(){},removeListener(){}});
  w.AbortSignal.timeout=()=>new w.AbortController().signal;
  w.fetch=async url=>{
   const str=String(url);
   let data={data:[]};
   if(str.includes('/referentiel/stations')){
    const code=new URL(str).searchParams.get('code_station');
    coordRequests.push(code);
    const i=codes.indexOf(code);
    data={data:i<0?[]:[{code_station:code,latitude_station:coords[i][0],longitude_station:coords[i][1]}]};
   }else if(str.includes('/observations_tr')){
    data={data:[{date_obs:current,resultat_obs:1340},{date_obs:new Date(Date.now()-65*60000).toISOString(),resultat_obs:1320},{date_obs:new Date(Date.now()-125*60000).toISOString(),resultat_obs:1300}]};
   }else if(str.includes('/api/early-signals'))data=model;
   else if(str.includes('/api/radar-map/info'))data={available:false};
   else if(str.includes('/health'))data={ok:true,pushConfigured:true};
   return {ok:true,status:200,json:async()=>data,text:async()=>JSON.stringify(data),headers:{get:()=>null}};
  };
 }});
const w=dom.window,d=w.document;
await new Promise(resolve=>setTimeout(resolve,350));
d.querySelector('[data-tab="Prévisions"]').click();
await new Promise(resolve=>setTimeout(resolve,750));
const blocks=[...d.querySelectorAll('#earlyForecastRows .rain-list-row')];
const rain=[...d.querySelectorAll('#earlyRainRows .rain-list-row')];
assert.equal(blocks.length,3,'Forecast must show precisely three regional rows');
assert.equal(rain.length,3,'Recent rain must show precisely three regional rows');
assert.equal(d.querySelectorAll('#earlyForecastRows .forecast-datum').length,0,'No more forecast mini cards');
assert.equal(d.querySelectorAll('#earlyRainRows .forecast-datum').length,0,'No more rain mini cards');
assert.match(blocks[0].textContent,/mm/);
assert.deepEqual(new Set(coordRequests),new Set(codes),'Map must get exact coordinates from official registry');
assert.equal(pins.length,5,'Exactly five current stations must appear as map pins');
assert.equal(d.getElementById('upstreamMap').hidden,false,'Map must become visible');
for(let i=0;i<pins.length;i++){
 const p=pins[i];
 assert.equal(p.position[0],coords[i][0]);
 assert.equal(p.position[1],coords[i][1]);
 assert.match(p.tooltip.textContent,/m.*cm\/h/,'Water level and trend beside pin');
 assert.equal(p.tooltipOptions.permanent,true);
}
const html=d.documentElement.outerHTML;
assert.ok(html.indexOf('id="rainForecastCard"')<html.indexOf('id="recentRainCard"'));
assert.ok(html.indexOf('id="recentRainCard"')<html.indexOf('id="upstreamForecastCard"'));
assert.ok(html.indexOf('id="upstreamForecastCard"')<html.indexOf('id="weatherPanel"'),'Radar belongs at bottom');
// Simulate an old station; it must disappear from the map even if still cached.
model.upstream[0].observedAt=new Date(Date.now()-120*60000).toISOString();
w.renderEarlySignals();
await new Promise(resolve=>setTimeout(resolve,200));
assert.equal(pins.length,4,'Outdated stations must not stay on map');
for(const lang of ['de','en','fr']){
 d.querySelector('[data-lang="'+lang+'"]').click();
 await new Promise(resolve=>setTimeout(resolve,80));
 assert.equal(d.documentElement.lang,lang);
 assert.equal(d.querySelectorAll('#earlyForecastRows .rain-list-row').length,3);
}
d.querySelector('[data-tab="Alertes"]').click();
assert.equal(d.querySelector('#pushSettings').classList.contains('hidden'),false,'Alerts still clickable');
assert.deepEqual(errors,[],'No runtime errors after map/list or language changes');
console.log('PASS: compact forecast lists, five verified station pins with readings, old-station removal, radar-last layout, translations, navigation');
process.exit(0);
