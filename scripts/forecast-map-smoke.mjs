// Simulate actual forecast page and official Hub'Eau station-coordinate responses.
// This checks that one list per rainfall source and five genuine gauge pins plus Roquebrune reference
// work at runtime, without a real network or credential.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
const piafScript=readFileSync(new URL('../piaf-player.js',import.meta.url),'utf8');
const paletteScript=readFileSync(new URL('../piaf-palette.js',import.meta.url),'utf8');
const nationalScript=readFileSync(new URL('../national-upstream.js',import.meta.url),'utf8');
const page=readFileSync(new URL('../index.html',import.meta.url),'utf8')
 .replace(/<script src="\.\/i18n-de\.js"><\/script>/,'')
 .replace('<script src="./piaf-palette.js"></script>','<script>'+paletteScript+'</script>')
 .replace('<script src="./piaf-player.js"></script>','<script>'+piafScript+'</script>')
 .replace('<script src="./national-upstream.js"></script>','<script>'+nationalScript+'</script>');
const codes=['Y511201001','Y530501501','Y520201001','Y523501002','Y521502002'];
const names=['Carcès · Argens','Le Muy · Endre','Les Arcs · Argens','Trans-en-Provence · Nartuby','Vidauban · Aille'];
const coords=[[43.4777864,6.1964135],[43.5033105,6.5896057],[43.4466067,6.471459],[43.5045146,6.4839904],[43.3971748,6.45585]];
const downstream={lat:43.4497,lon:6.6331};
const current=new Date(Date.now()-10*60000).toISOString();
const areas=['central','nartuby','lower'];
const model={
 ok:true,checkedAt:new Date().toISOString(),official:{status:'unavailable'},radar:{status:'catalogue_only'},
 forecast:areas.map((id,i)=>({id,name:id,status:'forecast',next6hMm:i+1,next24hMm:i+6})),
 rain:areas.map((id,i)=>({id,name:id,status:'estimated',last3hMm:i+2,last6hMm:i+3})),
 upstream:codes.map((code,i)=>({code,name:names[i],status:'current',levelM:1.1+i*.1,trendCmH:i-2,observedAt:current}))
};
const errors=[],coordRequests=[],pins=[],piafOverlays=[],mappedPixels=[];
const forecastBase=Math.ceil(Date.now()/300000)*300000;
const forecastFrames=[0,1,2].map(i=>new Date(forecastBase+i*300000).toISOString().replace('.000Z','Z'));
const piafMock={ok:true,available:true,source:'Météo-France PIAF',kind:'forecast_5min',bounds:[5.6331,42.8097,7.6331,44.0897],station:{code:'Y531201001',name:'Roquebrune-sur-Argens',lat:43.4497,lon:6.6331},referenceTime:new Date(forecastBase-300000).toISOString().replace('.000Z','Z'),frames:forecastFrames};
const parisMock={...piafMock,bounds:[1.34,48.22,3.34,49.5],station:{code:'H123456789',name:'Paris',lat:48.86,lon:2.34}};
const parisUpstream={ok:true,status:'verified',home:{code:'H123456789',name:'Paris',lat:48.86,lon:2.34},
stations:[{code:'H123456788',name:'Seine upstream',lat:48.81,lon:2.31,levelM:2.3,trendCmH:1.1,observedAt:current}],
nearby:[{code:'H123456787',name:'Nearby unrelated river',lat:48.7,lon:2.3,distanceKm:19.2,
classification:'nearby_not_verified',status:'current',levelM:1.5,trendCmH:-2.1}],
nearbyRadiusKm:40,hydrologicalConnectivity:'directed_verified_local_only'};
const argensUpstream={ok:true,status:'no_current_verified',home:{code:'Y531201001',name:'Roquebrune',lat:43.4497,lon:6.6331},
stations:[],nearby:[{code:'Y999999999',name:'Nearby Var river',lat:43.6,lon:6.5,distanceKm:25,
classification:'nearby_not_verified',status:'no_recent_measurement'}],
nearbyRadiusKm:40,hydrologicalConnectivity:'directed_verified_local_only'};
const vc=new VirtualConsole();
vc.on('jsdomError',e=>errors.push(String(e?.message||e)));
vc.on('error',e=>errors.push(String(e)));
const map={
 fitBounds(){return this},invalidateSize(){return this},panTo(){return this},
 setView(){return this},removeLayer(){return this}
};
const leaflet={
 map(){return map},
 tileLayer(){return {addTo(){return this}}},
 layerGroup(){return {addTo(){return this},clearLayers(){pins.length=0},addLayer(pin){pins.push(pin);return this}}},
 divIcon(opts){return opts},
 imageOverlay(url,bounds,opts){return {url,bounds,opts,handlers:{},once(name,fn){this.handlers[name]=fn;return this},setOpacity(v){this.opacity=v;return this},addTo(){piafOverlays.push(this);queueMicrotask(()=>this.handlers.load?.());return this}}},
 marker(position,opts){return {position,opts,bindTooltip(node,config){this.tooltip=node;this.tooltipOptions=config;return this},bindPopup(node){this.popup=node;return this},openPopup(){this.opened=true;return this}}},
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
  w.Image=class {constructor(){this.naturalWidth=6;this.naturalHeight=1}set src(url){this._src=url;setTimeout(()=>this.onload?.(),3)}get src(){return this._src}decode(){return Promise.resolve()}};
  w.HTMLCanvasElement.prototype.getContext=function(){
   return {drawImage(){},getImageData(){
    return {data:new Uint8ClampedArray([
     99,0,110,255, 0,0,254,255, 0,177,254,255,
     0,240,20,255, 255,255,0,255, 255,20,0,255
    ])};
   },putImageData(pixels){mappedPixels.push(Array.from(pixels.data))}};
  };
  w.HTMLCanvasElement.prototype.toDataURL=()=>('data:image/png;base64,AAAB');

  w.fetch=async url=>{
   const str=String(url);
   let data={data:[]};
   if(str.includes('/referentiel/stations')){
    const code=new URL(str).searchParams.get('code_station');
    coordRequests.push(code);
    const i=codes.indexOf(code);
    data={data:code==='Y531201001'?[{code_station:code,latitude_station:downstream.lat,longitude_station:downstream.lon}]:
     i<0?[]:[{code_station:code,latitude_station:coords[i][0],longitude_station:coords[i][1]}]};
   }else if(str.includes('/observations_tr')){
    data={data:[{date_obs:current,resultat_obs:1340},{date_obs:new Date(Date.now()-65*60000).toISOString(),resultat_obs:1320},{date_obs:new Date(Date.now()-125*60000).toISOString(),resultat_obs:1300}]};
   }else if(str.includes('/api/early-signals'))data=model;
   else if(str.includes('/api/radar-map/info'))data={available:false};
   else if(str.includes('/api/piaf/metadata'))data=new URL(str).searchParams.get('station')==='H123456789'?parisMock:piafMock;
   else if(str.includes('/api/upstream/stations'))data=new URL(str).searchParams.get('station')==='H123456789'?parisUpstream:argensUpstream;
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
assert.deepEqual(new Set(coordRequests),new Set([...codes,'Y531201001']),'Distances must reference official downstream station');
assert.equal(pins.length,6,'Five current gauges plus the Roquebrune reference pin');
assert.equal(d.getElementById('piafForecastMap').hidden,false,'Official forecast map must become visible');
assert.match(d.getElementById('piafForecastPanel').textContent,/🗺️/,'Map icon must replace film icon');
assert.match(d.getElementById('piafForecastTitle').textContent,/jusqu’à|until|bis/,'Forecast heading includes last available model frame');
assert.equal(d.getElementById('piafForecastStatus').hidden,true,'No redundant forecast-for time line after loading');
assert.equal(d.getElementById('nearbyGaugesBlock').hidden,false,'Argens also shows surrounding gauges out to 40 km');
assert.match(d.getElementById('nearbyGaugesRows').textContent,/Nearby Var river/);
assert.equal(d.getElementById('piafForecastControls').hidden,false,'Forecast time controls must appear');
assert.equal(d.getElementById('piafSlider').max,'2');
assert.equal(piafOverlays.length>=1,true,'A valid PIAF forecast image should be requested');
assert.equal(d.getElementById('weatherPanel'),null,'Redundant still radar map is removed');
assert.ok(d.getElementById('piafLegendBlock'),'PIAF legend block must be displayed');
assert.equal(d.getElementById('piafLegendImage'),null,'The old WMS palette is no longer shown');
assert.equal(d.querySelectorAll('.piaf-custom-color-key>div').length,6,'The six own intensity bands are visible');
assert.equal(d.getElementById('piafBand0').textContent,'Très faible');
assert.match(d.getElementById('piafLegendNote').textContent,/relative/);
assert.equal(piafOverlays[0].opacity,0.82,'Decoded and recoloured forecast is visible');
assert.match(piafOverlays[0].url,/^data:image\/png;base64,/,'The map renders recoloured data, never the raw violet WMS frame');
assert.ok(mappedPixels.length,'Browser canvas should recolour at least one frame');
assert.deepEqual(mappedPixels[0].slice(0,3),[186,233,255],'Original violet maps to very light blue');
assert.deepEqual(mappedPixels[0].slice(4,7),[80,184,240],'Original blue maps to light blue');
assert.deepEqual(mappedPixels[0].slice(8,11),[21,85,165],'Original cyan maps to dark blue');
d.getElementById('piafSlider').value='1';
d.getElementById('piafSlider').dispatchEvent(new w.Event('input',{bubbles:true}));
await new Promise(resolve=>setTimeout(resolve,210));
assert.match(d.getElementById('piafFrameTime').textContent,/\d\d[:.]\d\d/);
assert.equal(piafOverlays.length>=2,true,'Moving the slider requests a different official forecast time');
assert.equal(d.getElementById('upstreamMap').hidden,false,'Map must become visible');
assert.equal(d.getElementById('upstreamMapShell'),null,'Old legend wrapper removed');
assert.equal(d.getElementById('upstreamTrendLegend'),null,'Old detached trend legend removed');
assert.equal(d.querySelectorAll('#upstreamMap .upstream-map-tooltip').length,0,'No permanent tooltip boxes');
const flowIndex=[1,3,4,2,0]; // Endre, Nartuby, Aille, Argens Les Arcs, Argens Carcès
for(let i=0;i<5;i++){
 const p=pins[i],point=coords[flowIndex[i]];
 assert.equal(p.position[0],point[0]);
 assert.equal(p.position[1],point[1]);
 assert.match(p.opts.title,new RegExp('^'+(i+1)+'\.'),'Map pins must be numbered by tributary junction order');
 assert.equal(p.tooltipOptions,undefined,'A second Leaflet tooltip must not open on mobile tap');
 assert.match(p.opts.icon.html,/upstream-gauge-trend/,'Compact semi-transparent trend chip must be attached to pin');
 assert.match(p.opts.icon.html,/cm\/h/,'Each pin shows its own rate');
 assert.match(p.opts.icon.html,/[↑↓→]/,'Each pin shows a direction arrow');
 assert.match(p.popup.textContent,/m.*cm\/h/,'Compact popup shows level and trend');
 assert.equal(p.popup.querySelectorAll('details.upstream-popup-extra').length,1,'More details must be expandable inside the same popup');
 assert.equal(p.popup.querySelector('details.upstream-popup-extra').open,false,'Extra details start collapsed');
}
const home=pins[5];
assert.equal(home.position[0],downstream.lat,'Roquebrune latitude must match the official station');
assert.equal(home.position[1],downstream.lon,'Roquebrune longitude must match the official station');
assert.match(home.opts.title,/Roquebrune-sur-Argens/);
assert.match(home.opts.icon.className,/upstream-home-pin-wrap/,'Reference pin must be visually distinct');
assert.equal(home.tooltipOptions,undefined,'Roquebrune must not show two info bubbles');
assert.match(home.popup.textContent,/Y531201001/);
const rows=[...d.querySelectorAll('#earlyUpstreamRows .upstream-distance-row')];
assert.equal(rows.length,5,'All five recent upstream observations should be present');
assert.deepEqual(rows.map(x=>x.querySelector('.upstream-distance-rank').textContent),['1','2','3','4','5']);
assert.deepEqual(rows.map(row=>row.querySelector('.upstream-distance-info strong').textContent),
 flowIndex.map(i=>names[i]),'Hydrographic branch order must be independent from air distance');
for(const row of rows){
 assert.doesNotMatch(row.textContent,/Luftlinie|à vol d’oiseau|straight line| km/,'Must not show irrelevant airline distances');
 assert.match(row.textContent,/m.*cm\/h/,'Water level and trends stay visible');
}
assert.match(rows[0].textContent,/Endre/);
assert.match(rows[1].textContent,/Nartuby/);
assert.match(rows[2].textContent,/Aille/);
pins[1].openPopup();
assert.equal(pins[1].opened,true,'Tapping station opens its existing popup');
rows[0].click();
assert.equal(pins[0].opened,true,'Selecting a list entry should open the corresponding pin');
assert.match(d.getElementById('upstreamMapMessage').textContent,/Ordre des confluences|Junction order|Einmündungen/);
assert.match(d.querySelector('.bottom [data-tab="Alertes"]').textContent,/Messages d’alerte|Alert messages|Warnmeldungen/);
assert.equal(d.getElementById('earlySignalsHeading'),null,'Redundant forecast heading must be removed');
assert.equal(d.getElementById('earlySignalsIntro'),null,'Redundant model-value intro must be removed');
const html=d.documentElement.outerHTML;
assert.ok(html.indexOf('id="rainForecastCard"')<html.indexOf('id="recentRainCard"'));
assert.ok(html.indexOf('id="recentRainCard"')<html.indexOf('id="upstreamForecastCard"'));
assert.equal(html.includes('id="weatherPanel"'),false,'No redundant measured radar image on Forecast page');
// Simulate an old station; it must disappear from the map even if still cached.
model.upstream[0].observedAt=new Date(Date.now()-120*60000).toISOString();
w.renderEarlySignals();
await new Promise(resolve=>setTimeout(resolve,200));
assert.equal(pins.length,5,'Outdated gauge must disappear while the reference pin remains');
assert.equal(pins.filter(p=>/upstream-gauge-trend/.test(p.opts.icon.html)).length,4,'Only current station rates remain');
for(const lang of ['de','en','fr']){
 d.querySelector('[data-lang="'+lang+'"]').click();
 await new Promise(resolve=>setTimeout(resolve,80));
 assert.equal(d.documentElement.lang,lang);
 if(lang==='de'){
  assert.match(d.getElementById('piafForecastTitle').textContent,/Regenprognose bis \d\d:\d\d/);
  assert.match(d.getElementById('stationSearchTitle').textContent,/Station in meiner Nähe finden/);
  assert.match(d.getElementById('stationSearchIntro').textContent,/Heimatstation auswählen/);
  assert.match(d.getElementById('piafLegendTitle').textContent,/Relative Intensität/);
  assert.match(d.getElementById('piafLegendNote').textContent,/keine exakten/);
 }
 assert.equal(d.querySelectorAll('#earlyForecastRows .rain-list-row').length,3);
}
// A saved home station in another French area must move BOTH maps.
w.argensHomeStationCode='H123456789';
d.dispatchEvent(new w.CustomEvent('argens-station-selected',{detail:{code:'H123456789',name:'Paris'}}));
await new Promise(resolve=>setTimeout(resolve,490));
assert.equal(d.getElementById('rainForecastCard').hidden,true,'Argens rain totals must not masquerade as Paris data');
assert.equal(d.getElementById('recentRainCard').hidden,true,'Argens rain estimates must be hidden outside Argens');
assert.equal(d.getElementById('homeOfficialPanel').hidden,true,'Var warning must not appear for a Paris home');
assert.equal(d.getElementById('nationalUpstreamContainer').hidden,false,'Station-specific TOPAGE card is now visible');
assert.equal(d.getElementById('upstreamMap').hidden,true,'Legacy Argens upstream map is hidden');
assert.match(d.getElementById('nationalUpstreamRows').textContent,/Seine upstream/,'Only genuinely connected readings are upstream');
assert.doesNotMatch(d.getElementById('nationalUpstreamRows').textContent,/Nearby unrelated river/,'Nearby unrelated station is not called upstream');
assert.match(d.getElementById('nearbyGaugesRows').textContent,/Nearby unrelated river/,'Up to 40km nearby gauge displayed separately');
assert.match(d.getElementById('nearbyGaugesSubtitle').textContent,/connexion|not verified|keine bestätigten/);
assert.match(d.getElementById('forecastPageTitle').textContent,/Paris/);
assert.equal(piafOverlays[piafOverlays.length-1].bounds[0][0],48.22,'Forecast now covers Paris latitude, not Argens');
assert.equal(piafOverlays[piafOverlays.length-1].bounds[0][1],1.34,'Forecast now covers Paris longitude, not Argens');
d.querySelector('[data-tab="Alertes"]').click();
assert.equal(d.querySelector('#pushSettings').classList.contains('hidden'),false,'Alerts still clickable');
assert.deepEqual(errors,[],'No runtime errors after map/list or language changes');
console.log('PASS: PIAF 6-colour canvas mapping, preloaded animation, three languages, no unverified mm/h thresholds, upstream stations');
process.exit(0);
