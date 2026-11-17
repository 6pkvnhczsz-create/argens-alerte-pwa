// Regression: load the real homepage HTML under a browser-like DOM, not only
// parse its scripts. Prevent another release that leaves navigation unresponsive.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';

const page=readFileSync(new URL('../index.html',import.meta.url),'utf8')
 .replace(/<script src="\.\/i18n-de\.js"><\/script>/,'');
const vc=new VirtualConsole(),errors=[];
vc.on('jsdomError',e=>errors.push(String(e.stack||e)));
vc.on('error',(...msg)=>errors.push(msg.map(String).join(' ')));
const now=new Date(),date=offset=>new Date(now.getTime()-offset*60000).toISOString();
const hubeau={data:[
 {date_obs:date(5),resultat_obs:1350},
 {date_obs:date(35),resultat_obs:1330},
 {date_obs:date(65),resultat_obs:1320},
 {date_obs:date(125),resultat_obs:1300},
 {date_obs:date(185),resultat_obs:1280}
]};
let calls=0,waterCalls=0;
const dom=new JSDOM(page,{
 url:'https://riviere-alerte.fr/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,
 beforeParse(w){
  w.scrollTo=()=>{};
  w.matchMedia=()=>({matches:false,addListener(){},removeListener(){}});
  w.AbortSignal.timeout=()=>new w.AbortController().signal;
  w.fetch=async (url,options={})=>{
   calls++;
   const str=String(url);
   if(str.includes('observations_tr'))waterCalls++;
   const obj=str.includes('/user/station')&&options.method==='PUT'?
    {ok:true,settings:{station_name:'Roquebrune-sur-Argens'}}:
    str.includes('observations_tr')?hubeau:
    str.includes('/api/early-signals')?{ok:false}:
    str.includes('/health')?{ok:true,pushConfigured:true}:
    str.includes('/api/radar-map/info')?{available:false}:
    str.includes('open-meteo')?{current:{temperature_2m:18},hourly:{time:[],precipitation:[]}}:
    {data:[]};
   return {ok:true,status:200,headers:{get:()=>''},json:async()=>obj,text:async()=>JSON.stringify(obj)};
  };
 }
});
await new Promise(resolve=>setTimeout(resolve,600));
const d=dom.window.document;
const status={
 errors:errors.map(x=>x.slice(0,850)),
 river:d.querySelector('#level')?.textContent,
 trend:d.querySelector('#trend')?.textContent,
 forecast:d.querySelector('#forecastStatus')?.textContent,
 calls,
 navButtons:[...d.querySelectorAll('[data-tab]')].map(x=>x.dataset.tab),
 initialOverviewHidden:d.querySelector('#overview')?.classList.contains('hidden')
};
for(const name of ['Carte','Alertes','Prévisions','Réglages','overview']){
 d.querySelector('[data-tab="'+name+'"]')?.click();
 status['clicked_'+name]={
  overviewHidden:d.querySelector('#overview')?.classList.contains('hidden'),
  mapHidden:d.querySelector('#mapPage')?.classList.contains('hidden'),
  alertHidden:d.querySelector('#pushSettings')?.classList.contains('hidden'),
  forecastHidden:d.querySelector('#forecastPage')?.classList.contains('hidden'),
  settingsHidden:d.querySelector('#settingsPage')?.classList.contains('hidden'),
 };
}
console.log(JSON.stringify(status,null,2));
assert.deepEqual(errors.filter(x=>!x.includes('Not implemented:')).map(x=>x.split('\n')[0]),[],'Browser runtime errors on homepage');
assert.match(status.river,/1[,.]35/,'River reading must load');
assert.equal(d.querySelector('#stationRiverPrefix').textContent,'L’Argens à');
assert.equal(d.querySelector('#stationRiverPrefix').hidden,false,'Argens prefix appears on its own line at Roquebrune');
assert.equal(d.querySelector('#stationTitle').textContent,'Roquebrune-sur-Argens');
assert.match(d.querySelector('style').textContent,/\.station-heading\{display:flex;flex-direction:column/,'River name and Roquebrune must be stacked');
assert.equal(status.clicked_Carte.mapHidden,false,'Map tab not working');
assert.equal(status.clicked_Alertes.alertHidden,false,'Alerts tab not working');
assert.equal(status.clicked_Prévisions.forecastHidden,false,'Forecast tab not working');
assert.equal(status.clicked_Réglages.settingsHidden,false,'Settings tab not working');
assert.equal(status.clicked_overview.overviewHidden,false,'Home tab not working');

// All three public languages must remain usable after switching between them.
for(const code of ['en','de','fr']){
 d.querySelector('[data-lang="'+code+'"]').click();
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(d.documentElement.lang,code,'Language switch failed: '+code);
 assert.deepEqual(errors,[],'Language change caused browser errors: '+code);
}
assert.match(d.querySelector('#level').textContent,/1[,.]35/);

// Regression: after a saved threshold change, recolor the WHOLE tile and the
// selected chip in the same render, without a new 60-second water-level poll.
dom.window.localStorage.setItem('argens-account-token-v1','smoke-test-token');
const tile=d.querySelector('#overview .hero');
async function assertSavedThresholdColor(orange,red,band){
 const before=waterCalls;
 d.querySelector('#personalOrange').value=String(orange);
 d.querySelector('#personalRed').value=String(red);
 d.querySelector('#savePersonalStation').click();
 await new Promise(resolve=>setTimeout(resolve,45));
 assert.equal(tile.dataset.alert,band,'The entire Home tile must recolor immediately after saving');
 const current=tile.querySelectorAll('.threshold.is-current');
 assert.equal(current.length,1,'Exactly one threshold chip must be highlighted');
 assert.equal(current[0].dataset.threshold,band,'Highlighted chip must match full-tile background');
 assert.equal(waterCalls,before,'Changing a threshold must not require a new Hub’Eau request');
}
await assertSavedThresholdColor(1.20,1.60,'orange');
await assertSavedThresholdColor(0.80,1.00,'red');
await assertSavedThresholdColor(1.60,1.90,'green');
// Old measurement must not be shown as fresh even with artificially low thresholds.
assert.equal(dom.window.homeAlertState('Y531201001',[
 {value:1350,date:new Date(Date.now()-4*3600000)},
 {value:1300,date:new Date(Date.now()-5*3600000)}]).band,'unknown');
assert.deepEqual(errors.filter(x=>!x.includes('Not implemented:')).map(x=>x.split('\\n')[0]),[],
 'Threshold updates must not cause browser runtime errors');

// Simulate responsive element geometry and assert there is a single correct
// orthogonal SVG path to each actually active tile, with its exact color.
const hero=d.querySelector('#overview .hero');
const connector=hero.querySelector('.level-connector');
const glass=hero.querySelector('.level-glass');
const thresholds=[...hero.querySelectorAll('.threshold')];
const path=connector.querySelector('path');
const rect=(left,width,height=42)=>({left,width,height,top:0,right:left+width,bottom:height});
connector.getBoundingClientRect=()=>rect(0,340);
glass.getBoundingClientRect=()=>rect(130,80);
thresholds[0].getBoundingClientRect=()=>rect(10,70);
thresholds[1].getBoundingClientRect=()=>rect(135,70);
thresholds[2].getBoundingClientRect=()=>rect(275,70);
const cases=[
 ['green', 'M 170 0 V 23 H 45 V 42', '#50edb0'],
 ['orange','M 170 0 V 42','#ff9000'],
 ['red','M 170 0 V 23 H 310 V 42','#ff4558']
];
for(const [band,expected,color] of cases){
 hero.dataset.alert=band;
 for(const tile of thresholds)tile.classList.toggle('is-current',tile.dataset.threshold===band);
 dom.window.updateLevelConnector();
 assert.equal(path.getAttribute('d'),expected,'Connector path mismatch for '+band);
 assert.equal(path.style.stroke,color,'Connector color mismatch for '+band);
}
assert.equal(scriptsWithConnector(),1,'Multiple connector renderers would overwrite each other');
function scriptsWithConnector(){
 return [...page.matchAll(/function updateLevelConnector\(\)/g)].length;
}

// The app intentionally keeps timers and pending fetches alive. Exit after all
// assertions to avoid a jsdom teardown race with its unfinished navigation.
process.exit(0);
