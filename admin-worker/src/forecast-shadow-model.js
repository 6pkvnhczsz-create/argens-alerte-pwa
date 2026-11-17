// Offline-derived decision-tree surrogate for Rivière Alerte's 2015–2023 hydro+rain HGB model.
// NOT the full Python HGB; distillation target was the frozen 2023 model's 6h maximum predictions.
// Honest 2024–2026 holdout: 9,679 hourly samples; all-hours MAE 0.070 m;
// early 5.40m crossing: 10/13 positive time windows, 8 false-positive time windows.
// Data are clustered into a few flood events. 2026-10-21 shows an important overprediction.
// No automatic warning or public forecast should depend on this surrogate.
export const MODEL_INFO={
  version:'shadow-tree-2026-11-17-v1',
  trained_through:'2023-12-31',
  test_period:'2024-01-01 – 2026-10-30',
  test_hours:9679,mae_all_m:0.070,
  early_5_40_true_hours:13,early_5_40_detected_hours:10,early_5_40_false_positive_hours:8,
  model_type:'aus Python-Prototyp destillierter Entscheidungsbaum, 24 Blätter',
  operational:false
};
const F=[
'h','age_min','growth_1h','growth_3h','growth_6h','growth_12h',
'r_all_1h','r_all_3h','r_all_6h','r_all_12h','r_all_24h','r_all_72h','r_all_240h',
'month_sin','month_cos',
'r_Aille_6h','r_Aille_24h','r_Aille_72h','r_Aille_240h',
'r_Bresque_6h','r_Bresque_24h','r_Bresque_72h','r_Bresque_240h',
'r_Argens_middle_6h','r_Argens_middle_24h','r_Argens_middle_72h','r_Argens_middle_240h',
'r_Upstream_6h','r_Upstream_24h','r_Upstream_72h','r_Upstream_240h',
'r_Nartuby_6h','r_Nartuby_24h','r_Nartuby_72h','r_Nartuby_240h',
'r_East_6h','r_East_24h','r_East_72h','r_East_240h'
];
// Internal node: [feature index, <= threshold, left, right, NaN routes to left?].
// Leaf: [predicted peak in metres]. Sklearn tree_ values rounded to 6 decimal places.
const TREE=[[0,2.265,1,2,1],[15,18.1000004,7,8,1],[0,4.8499999,3,4,1],[8,12.9581819,5,6,1],[28,72.1500015,11,12,1],[0,3.6850001,9,10,1],[34,108.5999985,15,16,0],[0,1.365,13,14,1],[0,1.455,19,20,0],[0,3.0749999,25,26,1],[0,3.9350001,29,30,0],[0,5.635,23,24,1],[6.885165],[0,1.145,31,32,1],[0,1.8049999,21,22,1],[21,55.1499996,27,28,1],[24,37.75,17,18,0],[4.341918],[18,188.3499985,37,38,1],[1.795985],[7,16.0894446,39,40,1],[1.566642],[38,110.2000008,33,34,1],[15,22.0749998,35,36,1],[0,6.1499999,43,44,1],[2.949371],[3.446483],[3.867408],[4.606945],[3.934403],[31,4.3,45,46,1],[1.027407],[1.276196],[2.122779],[3.227837],[5.342099],[5.747933],[5.212618],[5.728357],[0,1.795,41,42,1],[3.71392],[2.285725],[3.389433],[5.956996],[6.335085],[4.330986],[4.693423]];
const GROUPS={
  Aille:['83075001','83031001'],
  Bresque:['83051001','83007004'],
  Argens_middle:['83083001','83004004','83148002'],
  Upstream:['83116022','83145001'],
  Nartuby:['83050007'],
  East:['83124002']
};
const HOUR=3600000;
const hourIso=(ms)=>new Date(Math.floor(ms/HOUR)*HOUR).toISOString();
export function shadowTreePredict(f){
  let i=0;
  for(let steps=0;steps<60;steps++){
    const n=TREE[i];
    if(n.length===1)return n[0];
    const x=f[F[n[0]]];
    const left= !Number.isFinite(x)?!!n[4]:x<=n[1];
    i=n[left?2:3];
    if(i<0||i>=TREE.length)throw Error('Ungültiger Modellknoten');
  }
  throw Error('Ungültiger Modellzyklus');
}
function rollingSeries(hourly,endHour,k){
  const end=Date.parse(endHour);
  const minPeriods=Math.max(1,Math.floor(k*.8)); // exact training feature requirement
  let count=0,sum=0;
  for(let offset=0;offset<k;offset++){
    const item=hourly.get(hourIso(end-offset*HOUR));
    if(Number.isFinite(item)){count++;sum+=item;}
  }
  return count>=minPeriods?sum:NaN;
}
function asofLevel(observations,utcMs){
  for(const p of observations){
    const stamp=Date.parse(p.at);
    if(!Number.isFinite(stamp))continue;
    const age=utcMs-stamp;
    if(age>=0&&age<=HOUR&&Number.isFinite(p.metres))return {value:p.metres,age:age/60000};
    if(age>HOUR)break;
  }
  return null;
}
export function buildShadowFeatureVector(rainRows,gaugeSeries,referenceHour){
  const now=Date.parse(referenceHour);
  const stations=new Map();
  for(const row of rainRows){
    if(row.rain_mm===null||row.rain_mm===undefined)continue;
    const mm=Number(row.rain_mm),at=Date.parse(row.hour_utc);
    if(!Number.isFinite(mm)||mm<0||mm>400||!Number.isFinite(at)||at>now||at<now-239*HOUR||at%HOUR)continue;
    const code=String(row.station_id);
    if(!stations.has(code))stations.set(code,new Map());
    stations.get(code).set(hourIso(at),mm);
  }
  const all=new Map(), groups=Object.fromEntries(Object.keys(GROUPS).map(x=>[x,new Map()]));
  let lastN=0;
  for(let offset=239;offset>=0;offset--){
    const stamp=hourIso(now-offset*HOUR);
    const vals=[...stations.values()].map(x=>x.get(stamp)).filter(Number.isFinite);
    if(vals.length>=7)all.set(stamp,vals.reduce((a,b)=>a+b,0)/vals.length);
    if(offset===0)lastN=vals.length;
    for(const [name,ids] of Object.entries(GROUPS)){
      const found=ids.map(id=>stations.get(id)?.get(stamp)).filter(Number.isFinite);
      if(found.length)groups[name].set(stamp,found.reduce((a,b)=>a+b,0)/found.length);
    }
  }
  const q=asofLevel(gaugeSeries,now);
  if(!q)return {ok:false,reason:'Kein gültiger Pegel innerhalb der Stunde vor dem Prognose-Bezugszeitpunkt'};
  const f={h:q.value,age_min:q.age};
  for(const k of [1,3,6,12]){
    const past=asofLevel(gaugeSeries,now-k*HOUR);
    f['growth_'+k+'h']=past?q.value-past.value:NaN;
  }
  for(const k of [1,3,6,12,24,72,240])f['r_all_'+k+'h']=rollingSeries(all,referenceHour,k);
  for(const [name,m] of Object.entries(groups)){
    for(const k of [6,24,72,240])f['r_'+name+'_'+k+'h']=rollingSeries(m,referenceHour,k);
  }
  const month=new Date(now).getUTCMonth()+1;
  f.month_sin=Math.sin(2*Math.PI*month/12);
  f.month_cos=Math.cos(2*Math.PI*month/12);
  if(lastN<7||!Number.isFinite(f.r_all_24h)||!Number.isFinite(f.r_all_72h))
    return {ok:false,reason:'Zu wenige gemessene Regenwerte am Bezugszeitpunkt oder in den letzten 24/72 Stunden',rain_station_count:lastN};
  return {ok:true,features:f,reference_hour_utc:referenceHour,rain_station_count:lastN};
}
export function computeShadowForecast(rainRows,gauge,nowMs,coverageReady){
  const reason=(msg)=>({status:'unavailable',reason:msg,peak_m:null,model:MODEL_INFO});
  // Measured gauge freshness is NOT relaxed anywhere else. Only the separate
  // experimental admin shadow may display a clearly labelled delayed estimate
  // from a 60–90-minute-old observation (never an alarm or an all-clear).
  const observedAt=Date.parse(gauge?.observed_at_utc||'');
  const gaugeAge=nowMs-observedAt;
  const delayed=!gauge?.ok&&Number.isFinite(observedAt)&&gaugeAge>60*60000&&gaugeAge<=90*60000
    &&Array.isArray(gauge?.series)&&Number.isFinite(gauge?.level_m)&&gauge?.source==='Hub’Eau';
  if(!gauge?.ok&&!delayed)return reason('Keine ausreichend aktuelle Pegelmessung (maximal 90 Minuten für die verzögerte interne Testrechnung)');
  if(!coverageReady)return reason('Mindestens sieben Stationen mit hinreichender 10-Tage-Historie erforderlich');
  const gaugeSeries=gauge.series;
  if(!Array.isArray(gaugeSeries)||!gaugeSeries.length)return reason('Pegel-Zeitreihe für Modellmerkmale fehlt');
  const end=Math.floor(nowMs/HOUR)*HOUR;
  const lookup=new Map();
  for(const row of rainRows||[]){
    if(row.rain_mm===null||row.rain_mm===undefined)continue;
    const ms=Date.parse(row.hour_utc),v=Number(row.rain_mm);
    if(!Number.isFinite(ms)||!Number.isFinite(v)||v<0||v>400)continue;
    lookup.set(String(row.station_id)+'|'+hourIso(ms),v);
  }
  for(let lag=0;lag<=2;lag++){
    const reference=hourIso(end-lag*HOUR);
    const n=[...new Set((rainRows||[]).map(x=>String(x.station_id)))].filter(id=>lookup.has(id+'|'+reference)).length;
    if(n<7)continue;
    const built=buildShadowFeatureVector(rainRows,gaugeSeries,reference);
    if(!built.ok)continue;
    const raw=shadowTreePredict(built.features);
    const peak=Math.max(raw,built.features.h,gauge.level_m);
    if(!Number.isFinite(peak)||peak<0||peak>20)return reason('Modell liefert keinen plausiblen Wert');
    if(Date.parse(reference)+6*HOUR<=nowMs)return reason('Das sechs-Stunden-Prognosefenster ist bereits abgelaufen');
    return {
      status:delayed?'experimental_delayed':'experimental',peak_m:Math.round(peak*100)/100,
      gauge_age_minutes:Math.round(gaugeAge/60000),
      reference_hour_utc:reference,valid_until_utc:hourIso(Date.parse(reference)+6*HOUR),
      rain_station_count:n,reference_level_m:built.features.h,
      source:'hydro_rain_shadow_tree',model:MODEL_INFO,
      warning:delayed?'Verzögerte experimentelle Pegelschätzung auf Grundlage eines älteren Messwerts. Keine aktuelle Warnung oder Entwarnung.':'Nur experimentelle, nicht ausreichend validierte 6-h-Pegelschätzung. Keine amtliche Prognose oder Entwarnung.'
    };
  }
  return reason('Kein hinreichend aktueller gemeinsamer Regen-/Pegel-Bezugszeitpunkt gefunden');
}
