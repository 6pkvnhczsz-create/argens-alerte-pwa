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
let calls=0;
const dom=new JSDOM(page,{
 url:'https://riviere-alerte.fr/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,
 beforeParse(w){
  w.scrollTo=()=>{};
  w.matchMedia=()=>({matches:false,addListener(){},removeListener(){}});
  w.AbortSignal.timeout=()=>new w.AbortController().signal;
  w.fetch=async url=>{
   calls++;
   const str=String(url);
   const obj=str.includes('observations_tr')?hubeau:
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
assert.equal(status.clicked_Carte.mapHidden,false,'Map tab not working');
assert.equal(status.clicked_Alertes.alertHidden,false,'Alerts tab not working');
assert.equal(status.clicked_Prévisions.forecastHidden,false,'Forecast tab not working');
assert.equal(status.clicked_Réglages.settingsHidden,false,'Settings tab not working');
assert.equal(status.clicked_overview.overviewHidden,false,'Home tab not working');
dom.window.close();
