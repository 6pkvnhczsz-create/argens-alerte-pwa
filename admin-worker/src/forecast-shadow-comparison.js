// Hourly, admin-only scorecard. Never sends push notifications or changes public alerts.
// A forecast is immutable: one recorded prediction per issue hour, as issued, before outcomes.
// Verify only genuinely observed Hub'Eau values strictly AFTER issuance up to the model's
// original six-hour reference window end. Do not confuse training holdout with live validation.
import {getForecastShadowStatus, getForecastGaugeSeries} from './forecast-shadow.js';

const HOUR=3600000;
const MINUTE=60000;
export const THRESHOLDS=[5.40,5.90,6.22];
export const VERIFICATION_DELAY_MS=30*MINUTE;
export const MAX_RETRY_MS=36*HOUR;
const hourIso=ms=>new Date(Math.floor(ms/HOUR)*HOUR).toISOString();
const safeReason=e=>String(e?.message||e||'Fehler').slice(0,180);

async function ensureComparisonTables(db){
  await db.prepare(`CREATE TABLE IF NOT EXISTS forecast_shadow_comparison (
    issue_hour_utc TEXT PRIMARY KEY,
    issued_at_utc TEXT NOT NULL,
    reference_hour_utc TEXT NOT NULL,
    valid_until_utc TEXT NOT NULL,
    model_version TEXT NOT NULL,
    forecast_peak_m REAL NOT NULL,
    reference_level_m REAL,
    input_status TEXT NOT NULL,
    actual_peak_m REAL,
    actual_peak_at_utc TEXT,
    observed_points INTEGER,
    mean_abs_error_m REAL,
    evaluated_at_utc TEXT,
    eval_status TEXT NOT NULL DEFAULT 'pending',
    eval_note TEXT
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS forecast_shadow_comparison_eval_idx ON forecast_shadow_comparison(eval_status,valid_until_utc)').run();
}

export function verifyForecastAgainstObserved(snapshot,observations,nowMs){
  const issued=Date.parse(snapshot?.issued_at_utc),end=Date.parse(snapshot?.valid_until_utc);
  if(!Number.isFinite(issued)||!Number.isFinite(end)||end<=issued||end-issued>6*HOUR+5*MINUTE)
    return {status:'invalid',reason:'Ungültiges ursprüngliches Vorhersagefenster'};
  if(nowMs<end+VERIFICATION_DELAY_MS)return {status:'pending',reason:'Prognosefenster oder Wartezeit noch nicht abgeschlossen'};
  const observed=(observations||[])
    .map(p=>({time:Date.parse(p.at),metres:p.metres}))
    .filter(p=>Number.isFinite(p.time)&&p.time>=issued&&p.time<=end&&Number.isFinite(p.metres)&&p.metres>=0&&p.metres<20&&p.time<=nowMs+5*MINUTE)
    .sort((a,b)=>a.time-b.time);
  const unique=observed.filter((p,i)=>i===0||p.time!==observed[i-1].time);
  const incomplete=msg=>({status:'insufficient',reason:msg,observed_points:unique.length});
  if(unique.length<8)return incomplete('Weniger als acht echte Pegelmessungen im Auswertungsfenster');
  if(unique[0].time-issued>30*MINUTE)return incomplete('Keine Messung innerhalb von 30 Minuten nach Prognoseausgabe');
  if(end-unique.at(-1).time>30*MINUTE)return incomplete('Keine Messung innerhalb von 30 Minuten vor Prognoseende');
  for(let i=1;i<unique.length;i++){
    if(unique[i].time-unique[i-1].time>45*MINUTE)return incomplete('Zu große Messlücke im Prognosefenster');
  }
  const max=unique.reduce((a,b)=>b.metres>a.metres?b:a);
  return {status:'evaluated',
    actual_peak_m:Math.round(max.metres*1000)/1000,
    actual_peak_at_utc:new Date(max.time).toISOString(),
    observed_points:unique.length,
    absolute_error_m:Math.round(Math.abs(Number(snapshot.forecast_peak_m)-max.metres)*1000)/1000};
}

export async function storeHourlyForecast(env,nowMs=Date.now(),statusFn=getForecastShadowStatus){
  if(!env.DB)return {status:'no_database'};
  await ensureComparisonTables(env.DB);
  const status=await statusFn(env,nowMs);
  const pred=status?.prediction;
  const issued=Date.parse(status?.issued_at_utc);
  const ref=Date.parse(pred?.reference_hour_utc);
  const end=Date.parse(pred?.valid_until_utc);
  const peak=Number(pred?.forecast_peak_m);
  if(!['experimental','experimental_delayed'].includes(pred?.status)||pred?.forecast_peak_m==null
    ||!Number.isFinite(peak)||peak<0||peak>20||!Number.isFinite(issued)||!Number.isFinite(ref)
    ||!Number.isFinite(end)||end<=issued+30*MINUTE||end-ref!==6*HOUR)
    return {status:'no_valid_forecast',reason:pred?.reason||'Keine nutzbare Testmodell-Prognose'};
  const issueHour=hourIso(nowMs);
  const result=await env.DB.prepare(`INSERT INTO forecast_shadow_comparison
    (issue_hour_utc,issued_at_utc,reference_hour_utc,valid_until_utc,model_version,forecast_peak_m,
     reference_level_m,input_status,eval_status)
    VALUES (?,?,?,?,?,?,?,?, 'pending')
    ON CONFLICT(issue_hour_utc) DO NOTHING`)
    .bind(issueHour,new Date(issued).toISOString(),new Date(ref).toISOString(),new Date(end).toISOString(),
      String(pred.model?.version||'unknown').slice(0,80),peak,
      Number.isFinite(Number(status.hydro?.level_m))?Number(status.hydro.level_m):null,pred.status).run();
  return {status:(result?.meta?.changes===0?'already_recorded':'recorded'),issue_hour_utc:issueHour,
    forecast_peak_m:peak,valid_until_utc:pred.valid_until_utc};
}

export async function evaluateDueForecasts(env,nowMs=Date.now(),gaugeFn=getForecastGaugeSeries){
  if(!env.DB)return {status:'no_database'};
  await ensureComparisonTables(env.DB);
  const due=await env.DB.prepare(`SELECT issue_hour_utc,issued_at_utc,valid_until_utc,forecast_peak_m
    FROM forecast_shadow_comparison WHERE eval_status='pending' AND valid_until_utc <= ?
    ORDER BY valid_until_utc ASC LIMIT 24`).bind(new Date(nowMs-VERIFICATION_DELAY_MS).toISOString()).all();
  const rows=due.results||[];
  if(!rows.length)return {status:'no_due_forecasts',evaluated:0,pending:0,insufficient:0};
  let series=[],fetchError=null;
  try {
    const hydro=await gaugeFn(fetch,nowMs);
    series=Array.isArray(hydro?.series)?hydro.series:[];
    if(!series.length)fetchError=hydro?.reason||'Hub’Eau liefert keine Pegelreihe';
  }catch(error){fetchError=safeReason(error);}
  let evaluated=0,pending=0,insufficient=0;
  for(const row of rows){
    const verification=verifyForecastAgainstObserved(row,series,nowMs);
    if(verification.status==='evaluated'){
      await env.DB.prepare(`UPDATE forecast_shadow_comparison SET eval_status='evaluated',
        actual_peak_m=?,actual_peak_at_utc=?,observed_points=?,mean_abs_error_m=?,evaluated_at_utc=?,eval_note=NULL
        WHERE issue_hour_utc=? AND eval_status='pending'`)
        .bind(verification.actual_peak_m,verification.actual_peak_at_utc,verification.observed_points,
          verification.absolute_error_m,new Date(nowMs).toISOString(),row.issue_hour_utc).run();
      evaluated++;
    }else{
      const obsolete=nowMs-Date.parse(row.valid_until_utc)>MAX_RETRY_MS||verification.status==='invalid';
      if(obsolete){
        await env.DB.prepare(`UPDATE forecast_shadow_comparison SET eval_status='insufficient',
          observed_points=?,eval_note=?,evaluated_at_utc=? WHERE issue_hour_utc=? AND eval_status='pending'`)
          .bind(verification.observed_points||0,fetchError||verification.reason||'Ungültige Messdaten',
            new Date(nowMs).toISOString(),row.issue_hour_utc).run();
        insufficient++;
      }else pending++;
    }
  }
  return {status:'ok',evaluated,pending,insufficient,source_error:fetchError};
}

const statThreshold=(rows,threshold)=>{
  let hit=0,miss=0,falseAlarm=0,correctBelow=0;
  for(const r of rows){
    const predicted=Number(r.forecast_peak_m)>=threshold;
    const actual=Number(r.actual_peak_m)>=threshold;
    if(predicted&&actual)hit++;
    else if(!predicted&&actual)miss++;
    else if(predicted&&!actual)falseAlarm++;
    else correctBelow++;
  }
  return {threshold_m:threshold,hit,miss,false_alarm:falseAlarm,correct_below:correctBelow};
};

export function summarizeComparisonRows(rows,allStatuses=[]){
  const scored=rows.filter(r=>r.eval_status==='evaluated'&&r.actual_peak_m!==null&&Number.isFinite(Number(r.actual_peak_m))
    &&r.forecast_peak_m!==null&&Number.isFinite(Number(r.forecast_peak_m)));
  const mean=scored.length?scored.reduce((sum,r)=>sum+Math.abs(Number(r.forecast_peak_m)-Number(r.actual_peak_m)),0)/scored.length:null;
  const statuses=allStatuses.length?allStatuses:rows;
  return {
    evaluated_windows:scored.length,
    pending_windows:statuses.filter(x=>x.eval_status==='pending').length,
    insufficient_windows:statuses.filter(x=>x.eval_status==='insufficient').length,
    mean_absolute_error_m:mean===null?null:Math.round(mean*1000)/1000,
    thresholds:THRESHOLDS.map(v=>statThreshold(scored,v))
  };
}

export async function getShadowComparisons(env,nowMs=Date.now()){
  if(!env.DB)return {status:'no_database',summary:summarizeComparisonRows([]),recent:[]};
  await ensureComparisonTables(env.DB);
  const cutoff=new Date(nowMs-30*24*HOUR).toISOString();
  const all=await env.DB.prepare(`SELECT issue_hour_utc,issued_at_utc,reference_hour_utc,valid_until_utc,
    forecast_peak_m,actual_peak_m,observed_points,eval_status,eval_note,model_version,input_status
    FROM forecast_shadow_comparison WHERE issued_at_utc >= ? ORDER BY issued_at_utc DESC LIMIT 750`).bind(cutoff).all();
  const rows=all.results||[];
  return {status:'ok',period_days:30,summary:summarizeComparisonRows(rows),recent:rows.slice(0,12),
    note:'Nur unabhängige Originalmessungen nach Vorhersageausgabe; Stundenfenster überlappen sich und sind keine unabhängigen Hochwasserereignisse.',
    next_step:'Mehrere getrennte Hochwasserereignisse abwarten; Modell nicht für Push oder Entwarnung verwenden.'};
}

export async function runShadowComparisonCycle(env,nowMs=Date.now(),ops={}){
  const recorded=await (ops.store||storeHourlyForecast)(env,nowMs);
  const verified=await (ops.evaluate||evaluateDueForecasts)(env,nowMs);
  try{await runHybridCycle(env,nowMs)}catch(e){console.error('Hybrid shadow cycle failed',safeReason(e))}

  return {recorded,verified};
}

 // Independent experimental model; original issued forecasts remain immutable.
 export async function runHybridCycle(env,nowMs=Date.now()){
 const db=env.DB;if(!db)return;
 await db.prepare("CREATE TABLE IF NOT EXISTS forecast_hybrid_v1 (issue_hour_utc TEXT PRIMARY KEY, issued_at_utc TEXT NOT NULL, valid_until_utc TEXT NOT NULL, forecast_peak_m REAL NOT NULL, shadow_peak_m REAL NOT NULL, rate_cm_h REAL NOT NULL, local_rain_today_mm REAL, actual_peak_m REAL, eval_status TEXT DEFAULT 'pending')").run();
 const original=await db.prepare("SELECT * FROM forecast_shadow_comparison WHERE issue_hour_utc=?").bind(hourIso(nowMs)).first();
 if(original&&Math.abs(nowMs-Date.parse(original.issued_at_utc))<120000){
 const hydro=await getForecastGaugeSeries(fetch,nowMs);
 const issued=Date.parse(original.issued_at_utc);
 const series=(hydro.series||[]).map(p=>({t:Date.parse(p.at),m:p.metres})).filter(p=>Number.isFinite(p.t)&&Number.isFinite(p.m)&&p.t<=issued).sort((a,b)=>b.t-a.t);
 const last=series[0],near=t=>series.reduce((best,p)=>!best||Math.abs(p.t-t)<Math.abs(best.t-t)?p:best,null);
 if(last&&issued-last.t<=1800000){
 const prev=near(last.t-HOUR),older=near(last.t-2*HOUR);
 if(prev&&older&&Math.abs(prev.t-(last.t-HOUR))<=600000&&Math.abs(older.t-(last.t-2*HOUR))<=600000){
 const v=(last.m-prev.m)/((last.t-prev.t)/HOUR),w=(prev.m-older.m)/((prev.t-older.t)/HOUR);
 const remaining=Math.max(0,(Date.parse(original.valid_until_utc)-issued)/HOUR);
 // Conservative persistence floor, with bounded acceleration contribution.
 const floor=last.m+Math.max(0,v)*remaining+Math.min(.15,Math.max(0,v-w))*Math.min(remaining,2);
 const peak=Math.max(original.forecast_peak_m,last.m,floor);
 let rain=null;try{const r=await db.prepare("SELECT today_mm FROM local_rain_archive WHERE status='ok' AND checked_at<=? AND checked_at>=? ORDER BY checked_at DESC LIMIT 1").bind(issued,issued-900000).first();rain=r?.today_mm??null}catch{}
 if(Number.isFinite(peak)&&peak<=20)await db.prepare("INSERT OR IGNORE INTO forecast_hybrid_v1(issue_hour_utc,issued_at_utc,valid_until_utc,forecast_peak_m,shadow_peak_m,rate_cm_h,local_rain_today_mm) VALUES(?,?,?,?,?,?,?)").bind(original.issue_hour_utc,original.issued_at_utc,original.valid_until_utc,peak,original.forecast_peak_m,v*100,rain).run();
 }}
 }
 await db.prepare("UPDATE forecast_hybrid_v1 SET actual_peak_m=(SELECT actual_peak_m FROM forecast_shadow_comparison s WHERE s.issue_hour_utc=forecast_hybrid_v1.issue_hour_utc),eval_status='evaluated' WHERE eval_status='pending' AND EXISTS(SELECT 1 FROM forecast_shadow_comparison s WHERE s.issue_hour_utc=forecast_hybrid_v1.issue_hour_utc AND s.eval_status='evaluated')").run();
 }
