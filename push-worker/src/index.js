// Argens Alerte — independent Cloudflare Worker backend
// Requires DB D1 binding, VAPID_PRIVATE_KEY secret, VAPID_PUBLIC_KEY and VAPID_SUBJECT vars.

// Private Worker-to-Worker RPC; not exposed as a public HTTP route.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { getHydroObservations, readVigicruesObservations, validHydroStation } from './water-sources.mjs';
import { verifyGitHubActionToken, ingestSnapshot, storedVigicruesObservations, activeBackupStationCodes, markVigicruesUnavailable, SNAPSHOT_MAX_BODY } from './vigicrues-snapshot.mjs';
import { translateFeedbackRecord } from './feedback-translation.mjs';
import { refreshEarlySignals, loadEarlySignals } from './early-signals.mjs';
import { verifyRadarWorkflowToken, fetchOfficialRadarH5, readRadarFrame, storeRadarFrame } from './radar-map.mjs';
import { fetchPiafMetadata, fetchPiafFrame } from './piaf-map.mjs';
export class AdminPushService extends WorkerEntrypoint {
 async healthAdmin(){return {ok:true,pushConfigured:Boolean(this.env.VAPID_PRIVATE_KEY&&this.env.VAPID_PUBLIC_KEY&&this.env.VAPID_SUBJECT)}}
 async vigicruesHealthAdmin(){
  try{
   const result=await bestVigicruesBackup(this.env,STATION,10);
   return {status:'good',observedAt:new Date(result.points[0].time).toISOString(),transport:result.transport||'direct'};
  }catch(e){return {status:'bad',error:String(e.message||e).slice(0,480)}}
 }
 async vigicruesCoverageAdmin(){
  const db=this.env.DB,now=Date.now();
  const {stations,deferred}=await activeBackupStationCodes(db,{now});
  const active=[...new Set([...stations,...deferred])].sort();
  const skipped=new Set(deferred);
  const rows=(await db.prepare('SELECT station_code,latest_ms,received_ms FROM vigicrues_backup_snapshots').all()).results||[];
  const byCode=new Map(rows.map(x=>[x.station_code,x]));
  const names=(await db.prepare("SELECT p.station_code,MAX(p.station_name) AS station_name FROM user_station_settings p JOIN app_users u ON u.id=p.user_id WHERE u.status='active' GROUP BY p.station_code").all()).results||[];
  const labels=new Map(names.map(x=>[x.station_code,x.station_name]));
  const coverage=active.map(code=>{
   const row=byCode.get(code),received=Number(row?.received_ms),last=Number(row?.latest_ms);
   const current=row&&Number.isSafeInteger(received)&&Number.isSafeInteger(last)&&
     received<=now+15*60000&&now-received<=75*60000&&
     last<=now+15*60000&&now-last<=3*3600000;
   const status=current?'good':skipped.has(code)?'unavailable':row?'stale':'pending';
   return {station:code,name:code===STATION?'Roquebrune-sur-Argens':labels.get(code)||code,
     status,observedAt:Number.isSafeInteger(last)?new Date(last).toISOString():null};
  });
  return {stations:coverage,activeCount:active.length,coveredCount:coverage.filter(x=>x.status==='good').length};
 }
 async translateFeedbackAdmin(id){return translateFeedbackRecord(this.env,id)}
 async broadcastAdmin(data){
  if(!['test','maintenance','incident','custom'].includes(data?.kind)||typeof data.title!=='string'||typeof data.body!=='string'||!data.title.trim()||!data.body.trim()||data.title.length>90||data.body.length>400)throw Error('Invalid admin message');
  const db=this.env.DB;
  await db.prepare('CREATE TABLE IF NOT EXISTS admin_send_log (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, accepted INTEGER, failed INTEGER, expired INTEGER, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)').run();
  const last=await db.prepare('SELECT updated_at FROM admin_send_log ORDER BY id DESC LIMIT 1').first();
  if(last&&Date.now()-Date.parse(last.updated_at.replace(' ','T')+'Z')<60000)throw Error('Wait at least 60 seconds between broadcasts');
  // Record the attempt BEFORE sending to avoid overlapping broadcasts.
  const record=await db.prepare('INSERT INTO admin_send_log(kind,accepted,failed,expired) VALUES(?,0,0,0)').bind(data.kind).run();
  const rows=await db.prepare('SELECT endpoint,subscription_json FROM push_subscriptions').all();
  let accepted=0,failed=0,expired=0;
  const payload={title:data.title.trim(),body:data.body.trim(),tag:'argens-admin-'+data.kind};
  for(const row of rows.results||[]){try{const result=await deliver(JSON.parse(row.subscription_json),payload,this.env);if(result.ok)accepted++;else if(result.status===404||result.status===410){expired++;await db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(row.endpoint).run()}else{failed++;const detail=(await result.text().catch(()=>'' )).slice(0,500);console.error('Admin push rejected',result.status,'provider:',new URL(row.endpoint).host,'details:',detail)}}catch(e){failed++;console.error('Admin push error',String(e))}}
  await db.prepare('UPDATE admin_send_log SET accepted=?,failed=?,expired=? WHERE id=?').bind(accepted,failed,expired,record.meta.last_row_id).run();
  return {accepted,failed,expired};
 }
 async simulateFloodOnDevice(data){
  if(!['orange','red','green'].includes(data?.level)||typeof data.endpoint!=='string'||data.endpoint.length>2048)throw Error('Invalid flood simulation request');
  const db=this.env.DB;
  const row=await db.prepare('SELECT subscription_json FROM push_subscriptions WHERE endpoint=?').bind(data.endpoint).first();
  if(!row)throw Error('Device not registered');
  await db.prepare('CREATE TABLE IF NOT EXISTS admin_flood_test_cooldown (endpoint TEXT PRIMARY KEY,last_sent INTEGER NOT NULL)').run();
  const last=await db.prepare('SELECT last_sent FROM admin_flood_test_cooldown WHERE endpoint=?').bind(data.endpoint).first();
  if(last&&Date.now()-Number(last.last_sent)<30000)throw Error('Wait 30 seconds before another flood test');
  const sub=JSON.parse(row.subscription_json),en=sub.language==='en';
  const names=en?{orange:'Orange',red:'Red',green:'Back to green'}:{orange:'Orange',red:'Rouge',green:'Retour au vert'};
  const rules=en?{orange:'Water level 3.00 m or rise ≥ 30 cm/h',red:'Water level 4.50 m or rise ≥ 50 cm/h',green:'Water level below alert threshold'}:{orange:'Niveau 3,00 m ou hausse ≥ 30 cm/h',red:'Niveau 4,50 m ou hausse ≥ 50 cm/h',green:'Niveau sous le seuil d’alerte'};

  if(sub.language==='de'){
   names.orange='Orange';names.red='Rot';names.green='Zurück zu Grün';
   rules.orange='Wasserstand 3,00 m oder Anstieg ≥ 30 cm/Std.';rules.red='Wasserstand 4,50 m oder Anstieg ≥ 50 cm/Std.';rules.green='Wasserstand unter dem Warnschwellenwert';
  }
  const payload={title:({orange:'🟠 🌊',red:'🔴 🌊',green:'🟢 🌊'}[data.level])+' Argens Alerte · SIMULATION',body:names[data.level]+' · '+rules[data.level]+(sub.language==='de'?'. NUR TEST — keine echte Hochwasserwarnung.':en?'. TEST ONLY — no real flood warning.':'. TEST UNIQUEMENT — aucune alerte réelle.'),tag:'argens-admin-flood-test-'+data.level};
  const result=await deliver(sub,payload,this.env);
  if(!result.ok){
   if(result.status===404||result.status===410)await db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(data.endpoint).run();
   throw Error('Push provider rejected simulation (HTTP '+result.status+')');
  }
  await db.prepare('INSERT INTO admin_flood_test_cooldown(endpoint,last_sent) VALUES(?,?) ON CONFLICT(endpoint) DO UPDATE SET last_sent=excluded.last_sent').bind(data.endpoint,Date.now()).run();
  console.log('Admin flood simulation accepted',data.level,'for one device');
  return {ok:true,level:data.level,accepted:1};
 }
 async simulateRainOnDevice(data){
  if(!['orange','red','purple'].includes(data?.level)||typeof data.endpoint!=='string'||data.endpoint.length>2048)throw Error('Invalid simulation request');
  const db=this.env.DB;
  const row=await db.prepare('SELECT subscription_json FROM push_subscriptions WHERE endpoint=?').bind(data.endpoint).first();
  if(!row)throw Error('Device not registered');
  await db.prepare('CREATE TABLE IF NOT EXISTS admin_rain_test_cooldown (endpoint TEXT PRIMARY KEY,last_sent INTEGER NOT NULL)').run();
  const last=await db.prepare('SELECT last_sent FROM admin_rain_test_cooldown WHERE endpoint=?').bind(data.endpoint).first();
  if(last&&Date.now()-Number(last.last_sent)<30000)throw Error('Wait 30 seconds before testing this device again');
  const sub=JSON.parse(row.subscription_json),en=sub.language==='en',mm={orange:50,red:90,purple:120}[data.level];
  const color=en?{orange:'Orange',red:'Red',purple:'Purple'}[data.level]:{orange:'orange',red:'rouge',purple:'violette'}[data.level];
  const rainLabel=en?{orange:'Heavy rain',red:'Dangerous heavy rain',purple:'Extreme rain'}[data.level]:{orange:'Fortes pluies',red:'Fortes pluies dangereuses',purple:'Pluies extrêmes'}[data.level];
  const safety=en?'Keep an eye on the app. If in danger, move to a safe place.':'Surveillez l’application. En cas de danger, mettez-vous en sécurité.';
  const payload={title:({orange:'🟠 🌧️',red:'🔴 🌧️🌧️',purple:'🟣 ⛈️'}[data.level])+' Argens Alerte · SIMULATION',body:rainLabel+' · '+mm+' mm / 24 h. '+safety+' '+(en?'TEST ONLY — not a real warning.':'TEST UNIQUEMENT — pas une alerte réelle.'),tag:'argens-admin-rain-test-'+data.level};
  if(sub.language==='de'){const levelName={orange:'Starkregen',red:'Gefährlicher Starkregen',purple:'Extremregen'}[data.level];payload.body=levelName+' · '+mm+' mm / 24 Std. Beobachten Sie die Lage. Bringen Sie sich bei Gefahr in Sicherheit. NUR TEST — keine echte Warnung.';}
  const result=await deliver(sub,payload,this.env);
  if(!result.ok){
   if(result.status===404||result.status===410)await db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(data.endpoint).run();
   throw Error('Push provider rejected simulation (HTTP '+result.status+')');
  }
  await db.prepare('INSERT INTO admin_rain_test_cooldown(endpoint,last_sent) VALUES(?,?) ON CONFLICT(endpoint) DO UPDATE SET last_sent=excluded.last_sent').bind(data.endpoint,Date.now()).run();
  console.log('Admin rainfall simulation accepted',data.level,'for one device');
  return {ok:true,level:data.level,accepted:1};
 }

}
const STATION='Y531201001';
const ALLOWED_ORIGINS=new Set(['https://6pkvnhczsz-create.github.io','https://riviere-alerte.fr','https://www.riviere-alerte.fr']);
const API='https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr';
const encoder=new TextEncoder();
const b64url=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(s.length/4)*4,'=')),c=>c.charCodeAt(0));
const concat=(...arrays)=>{const out=new Uint8Array(arrays.reduce((n,a)=>n+a.length,0));let i=0;for(const a of arrays){out.set(a,i);i+=a.length}return out};
const random=n=>crypto.getRandomValues(new Uint8Array(n));
async function hkdfExtract(salt,ikm){const key=await crypto.subtle.importKey('raw',salt,{name:'HMAC',hash:'SHA-256'},false,['sign']);return new Uint8Array(await crypto.subtle.sign('HMAC',key,ikm))}
async function hkdfExpand(prk,info,len){const key=await crypto.subtle.importKey('raw',prk,{name:'HMAC',hash:'SHA-256'},false,['sign']);return new Uint8Array(await crypto.subtle.sign('HMAC',key,concat(info,new Uint8Array([1])))).slice(0,len)}
async function encryptPayload(subscription,payload){
 const clientPub=unb64(subscription.keys.p256dh),auth=unb64(subscription.keys.auth);
 if(clientPub.length!==65||clientPub[0]!==4||auth.length<16)throw Error('Invalid subscription keys');
 const ephemeral=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
 const serverPub=new Uint8Array(await crypto.subtle.exportKey('raw',ephemeral.publicKey));
 const peer=await crypto.subtle.importKey('raw',clientPub,{name:'ECDH',namedCurve:'P-256'},false,[]);
 const shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:peer},ephemeral.privateKey,256));
 const keyPrk=await hkdfExtract(auth,shared);
 const ikm=await hkdfExpand(keyPrk,concat(encoder.encode('WebPush: info'),new Uint8Array([0]),clientPub,serverPub),32);
 const salt=random(16),prk=await hkdfExtract(salt,ikm);
 const cek=await hkdfExpand(prk,encoder.encode('Content-Encoding: aes128gcm\0'),16);
 const nonce=await hkdfExpand(prk,encoder.encode('Content-Encoding: nonce\0'),12);
 const key=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['encrypt']);
 const clear=concat(encoder.encode(JSON.stringify(payload)),new Uint8Array([2]));
 const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},key,clear));
 const header=concat(salt,new Uint8Array([0,0,16,0,serverPub.length]),serverPub);
 return concat(header,encrypted);
}
async function vapidHeader(endpoint,env){
 const pub=unb64(env.VAPID_PUBLIC_KEY),priv=unb64(env.VAPID_PRIVATE_KEY);
 if(pub.length!==65||priv.length!==32||!env.VAPID_SUBJECT)throw Error('VAPID config missing');
 const jwk={kty:'EC',crv:'P-256',x:b64url(pub.slice(1,33)),y:b64url(pub.slice(33,65)),d:b64url(priv),ext:false};
 const key=await crypto.subtle.importKey('jwk',jwk,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
 const aud=new URL(endpoint).origin;
 const now=Math.floor(Date.now()/1000);
 const head=b64url(encoder.encode(JSON.stringify({typ:'JWT',alg:'ES256'})));
 const body=b64url(encoder.encode(JSON.stringify({aud,exp:now+3600,sub:env.VAPID_SUBJECT})));
 const signed=head+'.'+body;
 const sig=new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,encoder.encode(signed)));
 // WebCrypto ECDSA signatures are IEEE P1363 (r||s), matching ES256 JWT.
 return 'vapid t='+signed+'.'+b64url(sig)+', k='+env.VAPID_PUBLIC_KEY;
}
async function deliver(sub,payload,env){
 const endpoint=new URL(sub.endpoint);
 if(endpoint.protocol!=='https:')throw Error('Invalid endpoint');
 const bytes=await encryptPayload(sub,payload);
 const authorization=await vapidHeader(sub.endpoint,env);
 return fetch(sub.endpoint,{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Encoding':'aes128gcm','TTL':'3600','Authorization':authorization},body:bytes});
}
function cors(request){const origin=request.headers.get('Origin');return {'Access-Control-Allow-Origin':ALLOWED_ORIGINS.has(origin)?origin:'null','Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Vary':'Origin'}}
function json(request,value,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8',...cors(request),'Cache-Control':'no-store'}})}
function levelFor(metres,rate){return metres>=4.5?'red':metres>=3||(rate!==null&&rate>=30)?'orange':'green'}

async function bestVigicruesBackup(env,code,limit=100){
 try{
  return await storedVigicruesObservations(env.DB,code,{limit});
 }catch(snapshotError){
  console.warn('Stored Vigicrues backup not available',code,String(snapshotError?.message||snapshotError));
  // Preserve the existing direct API as an emergency tertiary path.
  // It currently returns HTTP 403 from Cloudflare, but may become reachable later.
  return readVigicruesObservations(code,{limit});
 }
}
async function currentObservation(env){
 const {points,source}=await getHydroObservations(STATION,{limit:100,backupReader:(code,limit)=>bestVigicruesBackup(env,code,limit)});
 const last=points[0];
 const ref=points.find(x=>(last.time-x.time)>=30*60000&&(last.time-x.time)<=180*60000);
 const rate=ref?(last.mm-ref.mm)/10/((last.time-ref.time)/3600000):null;
 return {metres:last.mm/1000,rate,level:levelFor(last.mm/1000,rate),observedAt:new Date(last.time).toISOString(),source};
}
const labels={green:'Vert',orange:'Orange',red:'Rouge'};
function notification(obs,previous,lang='fr'){
 if(lang==='de'){
  const label=previous==='unknown'?'Wasserstandsbericht':obs.level==='green'?'Zurück zu Grün':obs.level==='red'?'Rote Warnung':obs.level==='orange'?'Orange Warnung':'Aktualisierung';
  const deTrend=obs.rate===null?'':' · '+(obs.rate>=0?'+':'')+obs.rate.toFixed(1).replace('.',',')+' cm/Std.';
  return {title:({green:'🟢 🌊',orange:'🟠 🌊',red:'🔴 🌊'}[obs.level])+' Argens Alerte · '+label,body:'Roquebrune-sur-Argens · '+obs.metres.toFixed(2).replace('.',',')+' m'+deTrend+'. Inoffizieller Richtwert.',tag:'argens-'+obs.level};
 }
 const change=previous==='unknown'?'Niveau observé':obs.level==='green'?'Retour au vert':obs.level==='red'?'Alerte rouge':obs.level==='orange'?'Alerte orange':'Mise à jour';
 const trend=obs.rate===null?'':' · '+(obs.rate>=0?'+':'')+obs.rate.toFixed(1)+' cm/h';
 if(lang==='en'){
  const label=previous==='unknown'?'Water level update':obs.level==='green'?'Back to green':obs.level==='red'?'Red alert':obs.level==='orange'?'Orange alert':'Update';
  return {title:({green:'🟢 🌊',orange:'🟠 🌊',red:'🔴 🌊'}[obs.level])+' Argens Alerte · '+label,body:'Roquebrune-sur-Argens · '+obs.metres.toFixed(2)+' m'+trend+'. Indicative, unofficial threshold.',tag:'argens-'+obs.level};
 }
 return {title:({green:'🟢 🌊',orange:'🟠 🌊',red:'🔴 🌊'}[obs.level])+' Argens Alerte · '+change,body:'Roquebrune-sur-Argens · '+obs.metres.toFixed(2).replace('.',',')+' m'+trend+'. Seuil indicatif non officiel.',tag:'argens-'+obs.level};
}
async function recordMonitorStatus(env,ok,detail){
 try{
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS monitor_status (station_code TEXT PRIMARY KEY, last_check_at TEXT, last_success_at TEXT, last_error TEXT, last_level TEXT, last_metres REAL, last_observed_at TEXT)').run();
  await env.DB.prepare("INSERT INTO monitor_status(station_code,last_check_at,last_success_at,last_error,last_level,last_metres,last_observed_at) VALUES(?,CURRENT_TIMESTAMP,CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,?,NULL,NULL,NULL) ON CONFLICT(station_code) DO UPDATE SET last_check_at=CURRENT_TIMESTAMP,last_success_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE monitor_status.last_success_at END,last_error=excluded.last_error,last_level=CASE WHEN ? THEN ? ELSE monitor_status.last_level END,last_metres=CASE WHEN ? THEN ? ELSE monitor_status.last_metres END,last_observed_at=CASE WHEN ? THEN ? ELSE monitor_status.last_observed_at END").bind(STATION,ok?1:0,ok?null:String(detail).slice(0,240),ok?1:0,ok?1:0,ok?detail.level:null,ok?1:0,ok?detail.metres:null,ok?1:0,ok?detail.observedAt:null).run();
 }catch(e){console.error('Monitoring status write failed',String(e))}
}

// Independent precipitation forecast alerts. Does not alter river-level alert state.
const RAIN_COORDS={lat:43.44,lon:6.64};
function rainLevel(mm){return mm>=120?'purple':mm>=90?'red':mm>=50?'orange':'green'}
async function checkRainForecast(env){
 const url='https://api.open-meteo.com/v1/forecast?latitude='+RAIN_COORDS.lat+'&longitude='+RAIN_COORDS.lon+'&hourly=precipitation&forecast_days=3&timezone=UTC';
 const response=await fetch(url,{headers:{'Accept':'application/json'}});
 if(!response.ok)throw Error('Rain forecast HTTP '+response.status);
 const data=await response.json(),times=data.hourly?.time,values=data.hourly?.precipitation;
 if(!Array.isArray(times)||!Array.isArray(values)||times.length!==values.length)throw Error('Invalid rain forecast');
 const now=Date.now(),start=Math.ceil(now/3600000)*3600000;
 const points=times.map((t,i)=>({time:Date.parse(t+'Z'),mm:values[i]})).filter(p=>Number.isFinite(p.time)&&p.time>=start&&p.time<start+48*3600000);
 if(points.length<48||points.some(p=>!Number.isFinite(p.mm)||p.mm<0))throw Error('Incomplete rain forecast');
 // Maximum rolling 24-hour precipitation across the next 48 hours, not a calendar-day total.
 let max=0,peakStart=0;
 for(let i=0;i<=24;i++){
  const sum=points.slice(i,i+24).reduce((a,p)=>a+p.mm,0);
  if(sum>max){max=sum;peakStart=points[i].time}
 }
 const current=rainLevel(max);
 await env.DB.prepare('CREATE TABLE IF NOT EXISTS rain_alert_state (location TEXT PRIMARY KEY, level TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)').run();
 const location='roquebrune-argens',saved=await env.DB.prepare('SELECT level FROM rain_alert_state WHERE location=?').bind(location).first();
 if(!saved){await env.DB.prepare('INSERT INTO rain_alert_state(location,level) VALUES(?,?)').bind(location,current).run();console.log('Rain alert initialized',current,max);return}
 if(saved.level===current)return;
 // Lowering/clearing the alert updates state without an extra push; re-escalation can alert again.
 if(current==='green'||(current==='orange'&&saved.level!=='green')||(current==='red'&&saved.level==='purple')){
  await env.DB.prepare('UPDATE rain_alert_state SET level=?,updated_at=CURRENT_TIMESTAMP WHERE location=?').bind(current,location).run();
  return;
 }
 const rows=await env.DB.prepare('SELECT endpoint,subscription_json FROM push_subscriptions WHERE station_code=?').bind(STATION).all();
 let failures=0,sent=0;
 for(const row of rows.results||[]){
  try{
   const sub=JSON.parse(row.subscription_json),en=sub.language==='en';
   const name=en?({orange:'Orange',red:'Red',purple:'Purple'}[current]):({orange:'orange',red:'rouge',purple:'violette'}[current]);
   const amount=max.toLocaleString(en?'en-GB':'fr-FR',{maximumFractionDigits:1});
   const rainLabel=en?{orange:'Heavy rain',red:'Dangerous heavy rain',purple:'Extreme rain'}[current]:{orange:'Fortes pluies',red:'Fortes pluies dangereuses',purple:'Pluies extrêmes'}[current];
   const safety=en?'Keep an eye on the app. If in danger, move to a safe place.':'Surveillez l’application. En cas de danger, mettez-vous en sécurité.';
   const payload={title:({orange:'🟠 🌧️',red:'🔴 🌧️🌧️',purple:'🟣 ⛈️'}[current])+' Argens Alerte · '+rainLabel,body:(en?'Roquebrune-sur-Argens · up to ':'Roquebrune-sur-Argens · jusqu’à ')+amount+(en?' mm / 24 h forecast. ':' mm / 24 h prévus. ')+safety+(en?' Indicative forecast, not an official warning.':' Prévision indicative, pas une alerte officielle.'),tag:'argens-rain-'+current};
   if(sub.language==='de'){
    const levelName={orange:'Starkregen',red:'Gefährlicher Starkregen',purple:'Extremregen'}[current];
    payload.title=({orange:'🟠 🌧️',red:'🔴 🌧️🌧️',purple:'🟣 ⛈️'}[current])+' Argens Alerte · '+levelName;
    payload.body='Roquebrune-sur-Argens · bis zu '+max.toLocaleString('de-DE',{maximumFractionDigits:1})+' mm / 24 Std. vorhergesagt. Beobachten Sie die Lage. Bringen Sie sich bei Gefahr in Sicherheit. Unverbindliche Vorhersage, keine amtliche Warnung.';
   }
   const result=await deliver(sub,payload,env);
   if(result.ok)sent++;
   else if(result.status===404||result.status===410)await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(row.endpoint).run();
   else{failures++;console.error('Rain push rejected',result.status)}
  }catch(e){failures++;console.error('Rain push failed',String(e))}
 }
 if(!failures)await env.DB.prepare('UPDATE rain_alert_state SET level=?,updated_at=CURRENT_TIMESTAMP WHERE location=?').bind(current,location).run();
 console.log('Rain alert',saved.level,'->',current,'max mm',max,'window start',new Date(peakStart).toISOString(),'sent',sent,'failed',failures);
}

async function personalStationObservation(code,env){
 const {points,source}=await getHydroObservations(code,{limit:100,backupReader:(station,limit)=>bestVigicruesBackup(env,station,limit)});
 const last=points[0];
 const reference=points.find(x=>last.time-x.time>=30*60000&&last.time-x.time<=180*60000);
 const rate=reference?(last.mm-reference.mm)/10/((last.time-reference.time)/3600000):null;
 return {metres:last.mm/1000,rate,observedAt:new Date(last.time).toISOString(),source};
}
function personalPushMessage({station,metres,threshold,rate,level,rapid,settingsUpdate,en,de}){
 if(de){
  const fmt=n=>Number(n).toFixed(2).replace('.',',');
  const icon={green:'🟢',orange:'🟠',red:'🔴'}[level];
  const label=rapid?'Schneller Anstieg':level==='green'?'Zurück zu Grün':level==='red'?'Roter Schwellenwert erreicht':'Orangener Schwellenwert erreicht';
  const title=icon+' Rivière Alerte · '+label;
  const detail=rapid?'📈 Anstieg: '+(rate>=0?'+':'')+Number(rate).toFixed(1).replace('.',',')+' cm/Std.':level==='green'?'🟢 Unter Ihrem orangenen Schwellenwert':'🎯 Ihr Schwellenwert: '+fmt(threshold)+' m';
  const body='📍 '+station+'\n🌊 Wasserstand: '+fmt(metres)+' m\n'+detail+(settingsUpdate?'\n⚙️ Schwellenwerte gespeichert':'')+'\nℹ️ Persönliche, inoffizielle Warnung';
  return {title,body};
 }
 const fmt=n=>Number(n).toFixed(2).replace('.',en?'.':',');
 const icon={green:'🟢',orange:'🟠',red:'🔴'}[level];
 const label=rapid?(en?'Rapid rise':'Montée rapide'):level==='green'?(en?'Back to green':'Retour au vert'):level==='red'?(en?'Red threshold reached':'Seuil rouge atteint'):(en?'Orange threshold reached':'Seuil orange atteint');
 const title=icon+' Rivière Alerte · '+label;
 const detail=rapid?'📈 '+(en?'Rise':'Hausse')+' : '+(rate>=0?'+':'')+Number(rate).toFixed(1).replace('.',en?'.':',')+' cm/h':level==='green'?'🟢 '+(en?'Below your orange threshold':'Sous votre seuil orange'):'🎯 '+(en?'Your threshold':'Votre seuil')+' : '+fmt(threshold)+' m';
 const body='📍 '+station+'\n🌊 '+(en?'Water level':'Niveau')+' : '+fmt(metres)+' m\n'+detail+(settingsUpdate?'\n⚙️ '+(en?'Thresholds just saved':'Seuils enregistrés'):'')+'\nℹ️ '+(en?'Personal, unofficial alert':'Alerte personnelle non officielle');
 return {title,body};
}
async function notifyUpdatedStationSettings(env,user,settings,obs){
 const level=obs.metres>=settings.red_m?'red':obs.metres>=settings.orange_m?'orange':'green';
 const rapid=obs.rate!==null&&obs.rate>=50?'red':obs.rate!==null&&obs.rate>=30?'orange':'green';
 const rank={green:0,orange:1,red:2};
 const effective=rank[rapid]>rank[level]?rapid:level;
 // Only notify if a warning is active. Never claim an observed rise caused a settings change.
 const linked=await env.DB.prepare('SELECT s.endpoint,s.subscription_json FROM push_user_devices d JOIN push_subscriptions s ON s.endpoint=d.endpoint WHERE d.user_id=?').bind(user.id).all();
 const devices=linked.results||[];
 let sent=0,failed=0;
 if(effective!=='green')for(const device of devices){
  try{
   const sub=JSON.parse(device.subscription_json),en=sub.language==='en';
   const threshold=effective==='red'?settings.red_m:settings.orange_m;
   const rapidCause=rank[rapid]>=rank[level]&&rapid!=='green';
   const {title,body}=personalPushMessage({station:settings.station_name||settings.station_code,metres:obs.metres,threshold,rate:obs.rate,level:effective,rapid:rapidCause,settingsUpdate:true,en,de:sub.language==='de'});
   const response=await deliver(sub,{title,body,tag:'settings-'+settings.station_code+'-'+effective},env);
   if(response.ok)sent++;
   else if([404,410].includes(response.status))await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(device.endpoint).run();
   else failed++;
  }catch(e){failed++;console.error('Settings push failed',String(e))}
 }
 return {level:effective,rapid_level:rapid,sent,failed,devices:devices.length};
}
async function checkPersonalStations(env){
 await env.DB.prepare('CREATE TABLE IF NOT EXISTS user_station_settings (user_id TEXT PRIMARY KEY,station_code TEXT NOT NULL,station_name TEXT NOT NULL,orange_m REAL NOT NULL,red_m REAL NOT NULL,updated_at INTEGER NOT NULL)').run();
 await env.DB.prepare('CREATE TABLE IF NOT EXISTS user_station_alert_state (user_id TEXT PRIMARY KEY,station_code TEXT NOT NULL,alert_level TEXT NOT NULL,updated_at INTEGER NOT NULL)').run();
 const stateCols=await env.DB.prepare('PRAGMA table_info(user_station_alert_state)').all();if(!(stateCols.results||[]).some(c=>c.name==='rapid_level'))await env.DB.prepare("ALTER TABLE user_station_alert_state ADD COLUMN rapid_level TEXT NOT NULL DEFAULT 'green'").run();
 const rows=await env.DB.prepare("SELECT p.user_id,p.station_code,p.station_name,p.orange_m,p.red_m,p.updated_at FROM user_station_settings p JOIN app_users u ON u.id=p.user_id WHERE u.status='active'").all();
 const users=rows.results||[];const observations=new Map();
 for(const u of users){
  if(!observations.has(u.station_code))observations.set(u.station_code,personalStationObservation(u.station_code,env).catch(e=>{console.error('Personal station read failed',u.station_code,String(e));return null}));
 }
 for(const u of users){
  const obs=await observations.get(u.station_code);if(!obs)continue;
  const heightLevel=obs.metres>=u.red_m?'red':obs.metres>=u.orange_m?'orange':'green';
  const rapidLevel=obs.rate!==null&&obs.rate>=50?'red':obs.rate!==null&&obs.rate>=30?'orange':'green';
  const rank={green:0,orange:1,red:2};
  const level=rank[rapidLevel]>rank[heightLevel]?rapidLevel:heightLevel;
  const rapidCause=rank[rapidLevel]>=rank[heightLevel]&&rapidLevel!=='green';
  const previous=await env.DB.prepare('SELECT station_code,alert_level,rapid_level,updated_at FROM user_station_alert_state WHERE user_id=?').bind(u.user_id).first();
  // Settings PUT sends an immediate warning. If it could not, retry at the next scheduled check.
  if(!previous||previous.station_code!==u.station_code||previous.updated_at<u.updated_at){
   if(level!=='green'){
    const devices=await env.DB.prepare('SELECT s.endpoint,s.subscription_json FROM push_user_devices d JOIN push_subscriptions s ON s.endpoint=d.endpoint WHERE d.user_id=?').bind(u.user_id).all();
    if((devices.results||[]).length){
     const result=await notifyUpdatedStationSettings(env,{id:u.user_id},{station_code:u.station_code,station_name:u.station_name,orange_m:u.orange_m,red_m:u.red_m},obs);
     if(result.sent===0||result.failed>0)continue;
    }else continue;
   }
   await env.DB.prepare('INSERT INTO user_station_alert_state(user_id,station_code,alert_level,rapid_level,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET station_code=excluded.station_code,alert_level=excluded.alert_level,rapid_level=excluded.rapid_level,updated_at=excluded.updated_at').bind(u.user_id,u.station_code,level,rapidLevel,Date.now()).run();
   continue;
  }
  const rapidTriggered=rank[rapidLevel]>rank[previous.rapid_level||'green'];
  if(previous.alert_level===level&&!rapidTriggered){if(previous.rapid_level!==rapidLevel)await env.DB.prepare('UPDATE user_station_alert_state SET rapid_level=? WHERE user_id=?').bind(rapidLevel,u.user_id).run();continue;}
  const linked=await env.DB.prepare('SELECT s.endpoint,s.subscription_json FROM push_user_devices d JOIN push_subscriptions s ON s.endpoint=d.endpoint WHERE d.user_id=?').bind(u.user_id).all();
  const devices=linked.results||[];if(!devices.length)continue;
  let failed=0;
  for(const d of devices){
   try{
    const subscription=JSON.parse(d.subscription_json),en=subscription.language==='en';
    const name=u.station_name||u.station_code;
    const threshold=level==='red'?u.red_m:u.orange_m;
    const {title,body}=personalPushMessage({station:name,metres:obs.metres,threshold,rate:obs.rate,level,rapid:rapidTriggered||rapidCause,settingsUpdate:false,en,de:subscription.language==='de'});
    const response=await deliver(subscription,{title,body,tag:'personal-'+u.station_code+'-'+level},env);
    if(!response.ok&&[404,410].includes(response.status))await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(d.endpoint).run();
    else if(!response.ok)failed++;
   }catch(e){failed++;console.error('Personal push failed',String(e))}
  }
  if(!failed)await env.DB.prepare('UPDATE user_station_alert_state SET alert_level=?,rapid_level=?,updated_at=? WHERE user_id=?').bind(level,rapidLevel,Date.now(),u.user_id).run();
 }
}
async function scheduledCheck(env){
 const obs=await currentObservation(env);
 await recordMonitorStatus(env,true,obs);
 const row=await env.DB.prepare('SELECT alert_level FROM alert_state WHERE station_code = ?').bind(STATION).first();
 const previous=row?.alert_level||'unknown';
 // Initialize without sending a surprise notification to existing subscribers.
 if(previous==='unknown'){await env.DB.prepare('INSERT INTO alert_state(station_code,alert_level,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(station_code) DO UPDATE SET alert_level=excluded.alert_level,updated_at=CURRENT_TIMESTAMP').bind(STATION,obs.level).run();return}
 if(previous===obs.level)return;
 const subs=await env.DB.prepare('SELECT s.endpoint,s.subscription_json FROM push_subscriptions s LEFT JOIN push_user_devices d ON d.endpoint=s.endpoint LEFT JOIN user_station_settings p ON p.user_id=d.user_id WHERE s.station_code=? AND p.user_id IS NULL').bind(STATION).all();
 let sent=0,failed=0;
 for(const row of subs.results||[]){
  try{
   const subscription=JSON.parse(row.subscription_json);
   const response=await deliver(subscription,notification(obs,previous,['fr','en','de'].includes(subscription.language)?subscription.language:'fr'),env);
   if(response.ok)sent++;
   else if(response.status===404||response.status===410){await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(row.endpoint).run()}
   else{failed++;console.error('Push rejected',response.status)}
  }catch(error){failed++;console.error('Push delivery error',String(error))}
 }
 // Retain prior state if transient delivery failures occur, allowing next check to retry.
 if(failed===0){await env.DB.prepare('INSERT INTO alert_state(station_code,alert_level,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(station_code) DO UPDATE SET alert_level=excluded.alert_level,updated_at=CURRENT_TIMESTAMP').bind(STATION,obs.level).run()}
 console.log('Argens alert transition',previous,obs.level,'sent',sent,'failed',failed);
}

/* Account sign-in: one-time email codes, opaque sessions, per-address/IP throttling. */
const authBytes=n=>crypto.getRandomValues(new Uint8Array(n));
const authHex=a=>Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');
const authHash=async v=>authHex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v))));
const authEmail=v=>typeof v==='string'&&v.trim().length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())?v.trim().toLowerCase():null;
async function authTables(db){
 await db.prepare('CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,last_login_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT \'active\')').run();
 const cols=await db.prepare('PRAGMA table_info(app_users)').all();for(const name of ['first_name','last_name'])if(!(cols.results||[]).some(c=>c.name===name))await db.prepare('ALTER TABLE app_users ADD COLUMN '+name+' TEXT').run();
 await db.prepare('CREATE TABLE IF NOT EXISTS auth_codes (email TEXT PRIMARY KEY,code_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,last_sent_at INTEGER NOT NULL)').run();
 await db.prepare('CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL)').run();
 await db.prepare('CREATE TABLE IF NOT EXISTS auth_limits (key TEXT PRIMARY KEY,window_start INTEGER NOT NULL,count INTEGER NOT NULL)').run();
 await db.prepare('CREATE TABLE IF NOT EXISTS user_station_settings (user_id TEXT PRIMARY KEY,station_code TEXT NOT NULL,station_name TEXT NOT NULL,orange_m REAL NOT NULL,red_m REAL NOT NULL,updated_at INTEGER NOT NULL)').run();
 await db.prepare('CREATE TABLE IF NOT EXISTS user_station_alert_state (user_id TEXT PRIMARY KEY,station_code TEXT NOT NULL,alert_level TEXT NOT NULL,updated_at INTEGER NOT NULL)').run();
}
async function authLimit(db,key,max,period){
 const now=Date.now(),row=await db.prepare('SELECT window_start,count FROM auth_limits WHERE key=?').bind(key).first();
 if(row&&now-row.window_start<period&&row.count>=max)return false;
 if(!row||now-row.window_start>=period)await db.prepare('INSERT INTO auth_limits(key,window_start,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,count=1').bind(key,now).run();
 else await db.prepare('UPDATE auth_limits SET count=count+1 WHERE key=?').bind(key).run();
 return true;
}
async function authUser(request,db){
 const token=(request.headers.get('Authorization')||'').match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1];
 if(!token)return null;
 const hash=await authHash(token);
 return db.prepare('SELECT u.id,u.email,u.first_name,u.last_name,u.created_at,u.last_login_at FROM auth_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.status=\'active\'').bind(hash,Date.now()).first();
}
async function accountRoute(request,env,url){
 if(!ALLOWED_ORIGINS.has(request.headers.get('Origin')))return json(request,{error:'Origin not allowed'},403);
 if(!env.DB)return json(request,{error:'Database unavailable'},503);
 const db=env.DB,now=Date.now(),ip=request.headers.get('CF-Connecting-IP')||'unknown';
 await authTables(db);
 if(url.pathname==='/user/station'){
  const user=await authUser(request,db);if(!user)return json(request,{error:'Unauthorized'},401);
  if(request.method==='GET'){
   const settings=await db.prepare('SELECT station_code,station_name,orange_m,red_m,updated_at FROM user_station_settings WHERE user_id=?').bind(user.id).first();
   return json(request,{settings:settings||null});
  }
  if(request.method!=='PUT')return json(request,{error:'Method not allowed'},405);
  const raw=await request.text();if(raw.length>2048)return json(request,{error:'Request too large'},413);
  let body;try{body=JSON.parse(raw)}catch{return json(request,{error:'Invalid JSON'},400)}
  const code=String(body.station_code||'').trim(),name=String(body.station_name||'').trim();
  const orange=Number(body.orange_m),red=Number(body.red_m);
  if(!/^([A-Z][0-9]{8,12})$/.test(code)||!name||name.length>160||!Number.isFinite(orange)||!Number.isFinite(red)||orange<0||red>100||orange>=red)return json(request,{error:'Invalid station or thresholds'},400);
  const verify=await fetch('https://hubeau.eaufrance.fr/api/v2/hydrometrie/referentiel/stations?code_station='+encodeURIComponent(code)+'&size=1&format=json');
  if(!verify.ok)return json(request,{error:'Unable to verify station'},503);
  const stationData=await verify.json();const station=(stationData.data||[]).find(x=>x.code_station===code);
  if(!station)return json(request,{error:'Unknown station'},400);
  const verifiedName=String(station.libelle_station||station.libelle_site||code).slice(0,160);
  const oldSettings=await db.prepare('SELECT station_code,orange_m,red_m FROM user_station_settings WHERE user_id=?').bind(user.id).first();
  const changed=!oldSettings||oldSettings.station_code!==code||oldSettings.orange_m!==orange||oldSettings.red_m!==red;
  const updatedAt=Date.now();
  await db.prepare('INSERT INTO user_station_settings(user_id,station_code,station_name,orange_m,red_m,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET station_code=excluded.station_code,station_name=excluded.station_name,orange_m=excluded.orange_m,red_m=excluded.red_m,updated_at=excluded.updated_at').bind(user.id,code,verifiedName,orange,red,updatedAt).run();
  let notification={status:'unchanged'};
  if(changed){
   try{
    const obs=await personalStationObservation(code,env);
    const result=await notifyUpdatedStationSettings(env,user,{station_code:code,station_name:verifiedName,orange_m:orange,red_m:red},obs);
    // Persist only after successful sends (or green). If push fails, allow the scheduler to retry.
    if(result.level==='green'||(result.devices>0&&result.sent>0&&result.failed===0)){
     await db.prepare('CREATE TABLE IF NOT EXISTS user_station_alert_state (user_id TEXT PRIMARY KEY,station_code TEXT NOT NULL,alert_level TEXT NOT NULL,updated_at INTEGER NOT NULL)').run();
     const cols=await db.prepare('PRAGMA table_info(user_station_alert_state)').all();
     if(!(cols.results||[]).some(c=>c.name==='rapid_level'))await db.prepare("ALTER TABLE user_station_alert_state ADD COLUMN rapid_level TEXT NOT NULL DEFAULT 'green'").run();
     await db.prepare('INSERT INTO user_station_alert_state(user_id,station_code,alert_level,rapid_level,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET station_code=excluded.station_code,alert_level=excluded.alert_level,rapid_level=excluded.rapid_level,updated_at=excluded.updated_at').bind(user.id,code,result.level,result.rapid_level,updatedAt).run();
    }
    notification={status:result.level==='green'?'no_active_warning':result.sent>0?'sent':result.devices===0?'no_linked_device':'delivery_failed',sent:result.sent};
   }catch(e){console.error('Settings warning evaluation failed',String(e));notification={status:'unavailable'}}
  }
  return json(request,{ok:true,settings:{station_code:code,station_name:verifiedName,orange_m:orange,red_m:red},notification});
 }
 if(url.pathname==='/auth/me'&&request.method==='GET'){
  const user=await authUser(request,db);return user?json(request,{user}):json(request,{error:'Unauthorized'},401);
 }
 if(url.pathname==='/auth/delete'&&request.method==='POST'){
  const user=await authUser(request,db);
  if(!user)return json(request,{error:'Unauthorized'},401);
  // Delete all account-linked data in one D1 transaction; never accept a user ID
  // or email from the request body as the deletion target.
  try{
   await db.prepare('CREATE TABLE IF NOT EXISTS push_user_devices (endpoint TEXT PRIMARY KEY,user_id TEXT NOT NULL,linked_at INTEGER NOT NULL)').run();
   const endpoints=await db.prepare('SELECT endpoint FROM push_user_devices WHERE user_id=?').bind(user.id).all();
   const batch=[
    ...((endpoints.results||[]).flatMap(row=>[
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(row.endpoint)
    ])),
    db.prepare('DELETE FROM push_user_devices WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM user_station_alert_state WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM user_station_settings WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM auth_sessions WHERE user_id=?').bind(user.id),
    db.prepare('DELETE FROM auth_codes WHERE email=?').bind(user.email),
    db.prepare('DELETE FROM app_users WHERE id=?').bind(user.id)
   ];
   await db.batch(batch);
   return json(request,{ok:true});
  }catch(e){console.error('Account deletion failed',String(e));return json(request,{error:'Account deletion unavailable'},500)}
 }
 if(url.pathname==='/auth/logout'&&request.method==='POST'){
  const token=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');
  if(token)await db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').bind(await authHash(token)).run();
  return json(request,{ok:true});
 }
 if(request.method!=='POST')return json(request,{error:'Not found'},404);
 if(!env.RESEND_API_KEY||!env.AUTH_EMAIL_FROM)return json(request,{error:'Email sign-in is not configured yet'},503);
 const raw=await request.text();if(raw.length>1024)return json(request,{error:'Request too large'},413);
 let body;try{body=JSON.parse(raw)}catch{return json(request,{error:'Invalid JSON'},400)}
 const email=authEmail(body.email);if(!email)return json(request,{error:'Invalid email'},400);
 const ipKey='ip:'+await authHash(ip),emailKey='email:'+await authHash(email);
 if(url.pathname==='/auth/request'){
  if(!await authLimit(db,ipKey+':request',12,3600000)||!await authLimit(db,emailKey+':request',4,3600000))return json(request,{error:'Too many requests. Try later.'},429);
  const prev=await db.prepare('SELECT last_sent_at FROM auth_codes WHERE email=?').bind(email).first();
  if(prev&&now-prev.last_sent_at<60000)return json(request,{ok:true});
  const code=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,'0');
  const hash=await authHash(email+':'+code+':'+env.AUTH_CODE_PEPPER);
  if(!env.AUTH_CODE_PEPPER)return json(request,{error:'Authentication not configured'},503);
  const safeCode=code.replace(/[^0-9]/g,'');
  let emailHtml=`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:32px 12px;background:#eef3f6;font-family:Arial,Helvetica,sans-serif;color:#173447"><div style="max-width:520px;margin:auto;background:#fff;border-radius:18px;overflow:hidden;border:1px solid #dbe6ec"><div style="padding:26px 32px;background:#10384b;color:#fff"><div style="font-size:23px;font-weight:800;letter-spacing:.2px">🌊 Argens Alerte</div><div style="margin-top:6px;font-size:13px;color:#bcd5df">Rivière Alerte · Accès sécurisé / Secure sign-in</div></div><div style="padding:30px 32px"><h1 style="font-size:23px;line-height:1.3;margin:0 0 12px">Votre code de connexion</h1><p style="font-size:15px;line-height:1.6;color:#496675;margin:0">Saisissez ce code dans l'application pour vous connecter.</p><div style="margin:24px 0;padding:20px 12px;background:#eef7f8;border:1px solid #c9e4e8;border-radius:12px;text-align:center;font-size:36px;letter-spacing:9px;font-weight:800;color:#0d687a">${safeCode}</div><p style="font-size:14px;color:#496675;line-height:1.6">Ce code expire dans <strong>5 minutes</strong>. Si vous n'avez pas demandé ce code, ignorez cet e-mail.</p><div style="border-top:1px solid #e2eaee;margin:24px 0"></div><h2 style="font-size:19px;margin:0 0 10px">Your sign-in code</h2><p style="font-size:14px;line-height:1.6;color:#496675">Enter the code above in the app. It expires in <strong>5 minutes</strong>. If you didn't request it, you can safely ignore this email.</p></div><div style="padding:16px 32px;background:#f5f8fa;font-size:12px;color:#78909e;text-align:center">Argens Alerte · riviere-alerte.fr</div></div></body></html>`;
  let emailText=`ARGENS ALERTE

FRANÇAIS
Votre code de connexion : ${safeCode}
Ce code expire dans 5 minutes.
Si vous n'avez pas demandé ce code, ignorez cet e-mail.

ENGLISH
Your sign-in code: ${safeCode}
This code expires in 5 minutes.
If you didn't request this code, you can ignore this email.

Rivière Alerte · riviere-alerte.fr`;
  if(body.language==='de'){
   emailHtml=`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:32px 12px;background:#eef3f6;font-family:Arial,Helvetica,sans-serif;color:#173447"><div style="max-width:520px;margin:auto;background:#fff;border-radius:18px;overflow:hidden;border:1px solid #dbe6ec"><div style="padding:26px 32px;background:#10384b;color:#fff"><div style="font-size:23px;font-weight:800">🌊 Argens Alerte</div><div style="margin-top:6px;font-size:13px;color:#bcd5df">Rivière Alerte · Sichere Anmeldung</div></div><div style="padding:30px 32px"><h1 style="font-size:23px;line-height:1.3;margin:0 0 12px">Ihr Anmeldecode</h1><p style="font-size:15px;line-height:1.6;color:#496675;margin:0">Geben Sie diesen Code in der App ein, um sich anzumelden.</p><div style="margin:24px 0;padding:20px 12px;background:#eef7f8;border:1px solid #c9e4e8;border-radius:12px;text-align:center;font-size:36px;letter-spacing:9px;font-weight:800;color:#0d687a">${safeCode}</div><p style="font-size:14px;color:#496675;line-height:1.6">Der Code ist <strong>5 Minuten</strong> gültig. Falls Sie keinen Code angefordert haben, können Sie diese E-Mail ignorieren.</p></div><div style="padding:16px 32px;background:#f5f8fa;font-size:12px;color:#78909e;text-align:center">Argens Alerte · riviere-alerte.fr</div></div></body></html>`;
   emailText=`ARGENS ALERTE\n\nIhr Anmeldecode: ${safeCode}\nDer Code ist 5 Minuten gültig.\nFalls Sie keinen Code angefordert haben, ignorieren Sie diese E-Mail.\n\nRivière Alerte · riviere-alerte.fr`;
  }
  const sent=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:env.AUTH_EMAIL_FROM,to:[email],subject:body.language==='de'?'Argens Alerte · Ihr Anmeldecode':'Argens Alerte · Code de connexion / Sign-in code',html:emailHtml,text:emailText})});
  if(!sent.ok){console.error('Email delivery failed',sent.status);return json(request,{error:'Email delivery unavailable'},502)}
  await db.prepare('INSERT INTO auth_codes(email,code_hash,expires_at,attempts,last_sent_at) VALUES(?,?,?,0,?) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,last_sent_at=excluded.last_sent_at').bind(email,hash,now+300000,now).run();
  return json(request,{ok:true});
 }
 if(url.pathname==='/auth/verify'){
  if(!await authLimit(db,ipKey+':verify',30,3600000)||!await authLimit(db,emailKey+':verify',10,3600000))return json(request,{error:'Too many attempts'},429);
  if(typeof body.code!=='string'||!/^\d{6}$/.test(body.code))return json(request,{error:'Invalid code'},400);
  const row=await db.prepare('SELECT * FROM auth_codes WHERE email=?').bind(email).first();
  if(!row||row.expires_at<=now||row.attempts>=5)return json(request,{error:'Code expired or invalid'},401);
  await db.prepare('UPDATE auth_codes SET attempts=attempts+1 WHERE email=?').bind(email).run();
  if(row.code_hash!==await authHash(email+':'+body.code+':'+env.AUTH_CODE_PEPPER))return json(request,{error:'Code expired or invalid'},401);
  const firstName=typeof body.first_name==='string'?body.first_name.trim():'';const lastName=typeof body.last_name==='string'?body.last_name.trim():'';
  const existing=await db.prepare('SELECT id,first_name,last_name FROM app_users WHERE email=?').bind(email).first();
  if((!existing||!existing.first_name||!existing.last_name)&&(!firstName||!lastName||firstName.length>80||lastName.length>80))return json(request,{error:'First name and last name are required'},400);
  await db.prepare('DELETE FROM auth_codes WHERE email=?').bind(email).run();
  const id=crypto.randomUUID();
  await db.prepare('INSERT INTO app_users(id,email,first_name,last_name,created_at,last_login_at) VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET last_login_at=excluded.last_login_at,first_name=COALESCE(NULLIF(app_users.first_name,\'\'),excluded.first_name),last_name=COALESCE(NULLIF(app_users.last_name,\'\'),excluded.last_name)').bind(id,email,firstName||null,lastName||null,now,now).run();
  const user=await db.prepare('SELECT id,email,first_name,last_name,created_at,last_login_at FROM app_users WHERE email=? AND status=\'active\'').bind(email).first();
  if(!user)return json(request,{error:'Account unavailable'},403);
  const token=b64url(authBytes(32));
  await db.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await authHash(token),user.id,now+30*86400000,now).run();
  return json(request,{token,user,expires_at:now+30*86400000});
 }
 return json(request,{error:'Not found'},404);
}

// Cached public metadata does not contain any secret, but avoids repeated API queries.
async function cachedPiafMetadata(env){
 const cache=globalThis.caches?.default;
 const key=new Request('https://riviere-alerte.fr/__piaf_cache/metadata_v1');
 if(cache){
  const hit=await cache.match(key);
  if(hit){
   const data=await hit.json().catch(()=>null);
   if(data&&Date.now()-Date.parse(data.referenceTime)<75*60000&&
      Array.isArray(data.frames)&&data.frames.some(t=>Date.parse(t)>Date.now()-180000))return data;
  }
 }
 const data=await fetchPiafMetadata(env);
 if(cache)await cache.put(key,new Response(JSON.stringify(data),{
  headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=90'}}));
 return data;
}
export default {
 async fetch(request,env,ctx){
  const url=new URL(request.url);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors(request)});
  if(url.pathname.startsWith('/auth/')||url.pathname==='/user/station'){try{return await accountRoute(request,env,url)}catch(e){console.error('Auth error',String(e));return json(request,{error:'Authentication unavailable'},500)}}
  if(url.pathname==='/devices/link'&&request.method==='POST'){
   if(!ALLOWED_ORIGINS.has(request.headers.get('Origin')))return json(request,{error:'Origin not allowed'},403);
   if(!env.DB)return json(request,{error:'Database unavailable'},503);
   const user=await authUser(request,env.DB);
   if(!user)return json(request,{error:'Unauthorized'},401);
   try{
    const raw=await request.text();if(raw.length>2500)return json(request,{error:'Too large'},413);
    const body=JSON.parse(raw);
    if(typeof body.endpoint!=='string'||body.endpoint.length>2048)return json(request,{error:'Invalid endpoint'},400);
    const subscribed=await env.DB.prepare('SELECT endpoint FROM push_subscriptions WHERE endpoint=?').bind(body.endpoint).first();
    if(!subscribed)return json(request,{error:'Subscription not found'},404);
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS push_user_devices (endpoint TEXT PRIMARY KEY,user_id TEXT NOT NULL,linked_at INTEGER NOT NULL)').run();
    await env.DB.prepare('INSERT INTO push_user_devices(endpoint,user_id,linked_at) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,linked_at=excluded.linked_at').bind(body.endpoint,user.id,Date.now()).run();
    return json(request,{ok:true});
   }catch(e){console.error('Device link failed',String(e));return json(request,{error:'Unable to link device'},500)}
  }
  if(url.pathname==='/feedback' && request.method==='POST'){
   if(!ALLOWED_ORIGINS.has(request.headers.get('Origin')))return json(request,{error:'Origin not allowed'},403);
   if(!env.DB)return json(request,{error:'Database unavailable'},503);
   const user=await authUser(request,env.DB);if(!user)return json(request,{error:'Sign in required'},401);
   const raw=await request.text();if(raw.length>2400)return json(request,{error:'Message too long'},413);
   let data;try{data=JSON.parse(raw)}catch{return json(request,{error:'Invalid request'},400)}
   if(!['idea','problem','other'].includes(data.kind)||typeof data.message!=='string'||data.message.trim().length<5||data.message.trim().length>1000)return json(request,{error:'Invalid message'},400);
   try{
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS app_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS feedback_rate_limit (user_id TEXT PRIMARY KEY,last_sent INTEGER NOT NULL)').run();
    const now=Date.now();
    const last=await env.DB.prepare('SELECT last_sent FROM feedback_rate_limit WHERE user_id=?').bind(user.id).first();
    if(last&&now-Number(last.last_sent)<60000)return json(request,{error:'Please wait a minute before sending another message',code:'feedback_cooldown'},429);
    const inserted=await env.DB.prepare("INSERT INTO app_feedback(user_id,kind,message) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM app_feedback WHERE user_id=? AND created_at >= datetime('now','-24 hours')) < 5").bind(user.id,data.kind,data.message.trim(),user.id).run();
    if(!inserted.meta?.changes)return json(request,{error:'Maximum five feedback messages within 24 hours',code:'feedback_daily_limit'},429);
    await env.DB.prepare('INSERT INTO feedback_rate_limit(user_id,last_sent) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET last_sent=excluded.last_sent').bind(user.id,now).run();
    // Translate newly received feedback asynchronously; never delay or reject the user's submission.
    const feedbackId=Number(inserted.meta?.last_row_id);
    if(Number.isSafeInteger(feedbackId)&&feedbackId>0&&ctx?.waitUntil){
     ctx.waitUntil(translateFeedbackRecord(env,feedbackId).catch(error=>console.error('Feedback translation unavailable',feedbackId,String(error?.message||error))));
    }
    return json(request,{ok:true});
   }catch(e){console.error('Feedback submission error',String(e));return json(request,{error:'Unable to save feedback'},503)}
  }
  if(url.pathname==='/unsubscribe' && request.method==='POST'){
   if(!ALLOWED_ORIGINS.has(request.headers.get('Origin')))return json(request,{error:'Origin not allowed'},403);
   const user=await authUser(request,env.DB);
   if(!user)return json(request,{error:'Unauthorized'},401);
   const body=await request.json().catch(()=>({}));
   if(typeof body.endpoint!=='string'||body.endpoint.length>2048)return json(request,{error:'Invalid endpoint'},400);
   const row=await env.DB.prepare('SELECT endpoint FROM push_user_devices WHERE endpoint=? AND user_id=?').bind(body.endpoint,user.id).first();
   if(!row)return json(request,{error:'Not found'},404);
   await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(body.endpoint).run();
   await env.DB.prepare('DELETE FROM push_user_devices WHERE endpoint=? AND user_id=?').bind(body.endpoint,user.id).run();
   return json(request,{ok:true});
  }
  if(url.pathname==='/subscription/status'&&request.method==='POST'){
   if(!ALLOWED_ORIGINS.has(request.headers.get('Origin')))return json(request,{error:'Origin not allowed'},403);
   if(!env.DB)return json(request,{error:'Database unavailable'},503);
   const user=await authUser(request,env.DB);if(!user)return json(request,{active:false},200);
   try{const raw=await request.text();if(raw.length>2500)return json(request,{error:'Too large'},413);const {endpoint}=JSON.parse(raw);if(typeof endpoint!=='string'||endpoint.length>2048)return json(request,{error:'Invalid endpoint'},400);const row=await env.DB.prepare('SELECT s.endpoint FROM push_subscriptions s JOIN push_user_devices d ON d.endpoint=s.endpoint WHERE s.endpoint=? AND d.user_id=?').bind(endpoint,user.id).first();return json(request,{active:!!row})}catch{return json(request,{active:false})}
  }

  // Station discovery is read-only but requires a signed GitHub OIDC identity.
  // Registration and station changes are picked up at the next scheduled run.
  if(url.pathname==='/api/vigicrues-stations'&&request.method==='GET'){
   const auth=request.headers.get('Authorization')||'';
   if(!auth.startsWith('Bearer '))return json(request,{error:'GitHub identity required'},401);
   try{
    await verifyGitHubActionToken(auth.slice(7));
    const listing=await activeBackupStationCodes(env.DB);
    return json(request,{ok:true,stations:listing.stations,deferred:listing.deferred,activeCount:listing.activeCount});
   }catch(error){
    console.error('Signed Vigicrues station discovery failed',String(error?.message||error));
    return json(request,{error:'Station discovery unavailable'},503);
   }
  }
  // A station without current Vigicrues measurements is skipped temporarily.
  // This is never interpreted as valid backup data.
  if(url.pathname==='/api/vigicrues-unavailable'&&request.method==='POST'){
   const auth=request.headers.get('Authorization')||'';
   if(!auth.startsWith('Bearer '))return json(request,{error:'GitHub identity required'},401);
   try{
    await verifyGitHubActionToken(auth.slice(7));
   }catch(error){
    console.error('Signed Vigicrues unavailable report rejected',String(error?.message||error));
    return json(request,{error:'GitHub identity rejected'},401);
   }
   try{
    if(Number(request.headers.get('Content-Length'))>1200)return json(request,{error:'Payload too large'},413);
    const body=await request.text();
    if(body.length>1200)return json(request,{error:'Payload too large'},413);
    const payload=JSON.parse(body);
    const stored=await markVigicruesUnavailable(env.DB,payload.station,payload.reason);
    return json(request,stored);
   }catch(error){
    console.error('Vigicrues unavailability report error',String(error?.message||error));
    return json(request,{error:'Invalid unavailability report'},422);
   }
  }

  // Genuine radar image is optional and informational. Only the exact main
  // GitHub Actions radar workflow can download the large HDF5 product or upload
  // a validated geo-referenced preview; public browsers see only PNG + status.
  if(url.pathname==='/api/radar-map/raw'&&request.method==='GET'){
   const bearer=request.headers.get('Authorization')||'';
   if(!bearer.startsWith('Bearer '))return json(request,{error:'Signed radar workflow required',stage:'auth'},401);
   try{await verifyRadarWorkflowToken(bearer.slice(7))}
   catch(e){
    const reason=String(e?.message||'unknown');
    const code=['Invalid token','Invalid JWT','Signing key rejected','Wrong radar audience','Identity not current','Identity not yet active','Wrong repository identity','Untrusted branch','Untrusted workflow','Untrusted subject','Signing keys unavailable','Unrecognized signing key','Invalid identity signature'].includes(reason)?reason:'auth_unknown';
    console.warn('Radar OIDC failed',code);
    return json(request,{error:'Radar workflow identity rejected',stage:'auth',code},401);
   }
   try{
    const r=await fetchOfficialRadarH5(env);
    return new Response(r.body,{status:200,headers:{'Content-Type':'application/x-hdf','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
   }catch(e){
    const reason=String(e?.message||'unknown');
    const code=/^radar_http_(?:[345]\d{2}|other)$/.test(reason)?reason:
     reason==='Météo-France radar key not configured'?'key_not_configured':
     reason==='Radar file exceeds safety limit'?'radar_too_large':'radar_fetch_error';
    console.warn('Radar raw download unavailable',code);
    return json(request,{error:'Radar product unavailable',stage:'download',code},502);
   }
  }
  // PIAF 3-hour nowcast: public validated metadata and PNG forecast frames.
  // API credentials never enter browser responses or cache keys.
  if(url.pathname==='/api/piaf/metadata'&&request.method==='GET'){
   const origin=request.headers.get('Origin');
   if(origin&&!ALLOWED_ORIGINS.has(origin))return json(request,{error:'Origin not allowed'},403);
   try{return json(request,{ok:true,available:true,...await cachedPiafMetadata(env)})}
   catch(error){
    console.warn('PIAF metadata unavailable',String(error?.message||'upstream'));
    return json(request,{ok:false,available:false,error:'PIAF forecast currently unavailable'},503);
   }
  }
  if(url.pathname==='/api/piaf/frame'&&request.method==='GET'){
   const origin=request.headers.get('Origin');
   if(origin&&!ALLOWED_ORIGINS.has(origin))return json(request,{error:'Origin not allowed'},403);
   const time=url.searchParams.get('time');
   if([...url.searchParams].length!==1||!time||time.length>32)return json(request,{error:'Invalid PIAF time'},400);
   try{
    const info=await cachedPiafMetadata(env);
    if(!info.frames.includes(time))return json(request,{error:'PIAF frame not listed in current model'},404);
    const cache=globalThis.caches?.default;
    const key=new Request('https://riviere-alerte.fr/__piaf_cache/frame_v1?reference='+encodeURIComponent(info.referenceTime)+'&time='+encodeURIComponent(time));
    let imageBytes;
    if(cache){const hit=await cache.match(key);if(hit)imageBytes=await hit.arrayBuffer()}
    if(!imageBytes){
     imageBytes=await fetchPiafFrame(env,info,time);
     if(cache)await cache.put(key,new Response(imageBytes,{headers:{
      'Content-Type':'image/png','Cache-Control':'public, max-age=3600'}}));
    }
    return new Response(imageBytes,{status:200,headers:{...cors(request),'Content-Type':'image/png',
     'Cache-Control':'public, max-age=300','X-Content-Type-Options':'nosniff'}});
   }catch(error){
    console.warn('PIAF map unavailable',String(error?.message||'upstream'));
    return json(request,{error:'PIAF image currently unavailable'},503);
   }
  }
  // Read-only live PIAF subscription probe. Only the already trusted radar
  // GitHub workflow may invoke it; the Météo-France API key never leaves Worker.
  // Returns only HTTP statuses and validated catalogue tags, never raw XML or keys.
  if(url.pathname==='/api/radar-map/piaf-probe'&&request.method==='GET'){
   const bearer=request.headers.get('Authorization')||'';
   if(!bearer.startsWith('Bearer '))return json(request,{ok:false,error:'Workflow authentication required'},401);
   try{await verifyRadarWorkflowToken(bearer.slice(7))}
   catch{return json(request,{ok:false,error:'Workflow identity rejected'},401)}
   const piafApiKey=env.METEO_FRANCE_PIAF_API_KEY||env.METEO_FRANCE_API_KEY;
   if(!piafApiKey)return json(request,{ok:false,error:'PIAF API key not configured'},503);
   // The canonical server URL comes from Météo-France PIAF's Swagger
   // documentation. Keep the API key inside Cloudflare.
   const candidates=[
    'https://api.meteofrance.fr/pro/piaf/1.0/wms/MF-NWP-HIGHRES-PIAF-001-FRANCE-WMS/GetCapabilities?service=WMS&version=1.3.0'
   ];
   const answers=[];
   for(let i=0;i<candidates.length;i++){
    try{
     const result=await fetch(candidates[i],{
      headers:{apikey:piafApiKey,Accept:'application/xml'},
      redirect:'manual',signal:AbortSignal.timeout(14000),cf:{cacheTtl:0}
     });
     const type=String(result.headers.get('content-type')||'').slice(0,100).replace(/[^a-zA-Z0-9/;= .-]/g,'');
     let catalogue=false,layerCount=0,preview=[];
     if(result.ok&&type.includes('xml')){
      const body=await result.text();
      if(body.length<2000000&&/<(?:WMS_Capabilities|WMT_MS_Capabilities|\w+:Capabilities)\b/i.test(body)){
       catalogue=true;
       const names=[...body.matchAll(/<Name>\s*([A-Z_][A-Z0-9_]+)\s*<\/Name>/g)]
        .map(m=>m[1]).filter(x=>/PRECIP|RAIN|WATER/i.test(x));
       layerCount=names.length;preview=names.slice(0,4);
      }
     }
     answers.push({variant:i+1,httpStatus:result.status,contentType:type,catalogue,precipitationLayers:layerCount,layerNames:preview});
     if(catalogue)break;
    }catch{answers.push({variant:i+1,httpStatus:0,error:'request_failed'})}
   }
   return json(request,{ok:true,connected:answers.some(a=>a.catalogue),checkedAt:new Date().toISOString(),model:'PIAF',answers});
  }

  if(url.pathname==='/api/radar-map/ingest'&&request.method==='POST'){
   const bearer=request.headers.get('Authorization')||'';
   if(!bearer.startsWith('Bearer '))return json(request,{error:'Signed radar workflow required'},401);
   let identity;
   try{identity=await verifyRadarWorkflowToken(bearer.slice(7))}
   catch{return json(request,{error:'Radar workflow identity rejected'},401)}
   if(!env.DB)return json(request,{error:'Radar storage unavailable'},503);
   if(Number(request.headers.get('Content-Length'))>850000)return json(request,{error:'Radar payload too large'},413);
   try{
    const raw=await request.text();
    if(raw.length>850000)return json(request,{error:'Radar payload too large'},413);
    return json(request,await storeRadarFrame(env.DB,JSON.parse(raw),{runId:identity.runId}));
   }catch(e){
    console.error('Radar frame rejected',String(e?.message||'Invalid frame').slice(0,85));
    return json(request,{error:'Radar image validation or storage failed'},422);
   }
  }
  if(url.pathname==='/api/radar-map/info'&&request.method==='GET'){
   const origin=request.headers.get('Origin');
   if(origin&&!ALLOWED_ORIGINS.has(origin))return json(request,{error:'Origin not allowed'},403);
   try{
    const frame=await readRadarFrame(env.DB);
    return json(request,{ok:true,available:true,source:'Météo-France',kind:'observed_5min_rain',bounds:frame.bounds,observedAt:frame.observedAt,coveragePct:frame.coveragePct,wetPct:frame.wetPct,notAFloodForecast:true});
   }catch{return json(request,{ok:true,available:false,source:'Météo-France',notAFloodForecast:true})}
  }
  if(url.pathname==='/api/radar-map/image'&&request.method==='GET'){
   const origin=request.headers.get('Origin');
   if(origin&&!ALLOWED_ORIGINS.has(origin))return json(request,{error:'Origin not allowed'},403);
   try{
    const frame=await readRadarFrame(env.DB);
    const bytes=Uint8Array.from(atob(frame.imageB64),x=>x.charCodeAt(0));
    const headers={'Content-Type':'image/png','Cache-Control':'public, max-age=120','X-Content-Type-Options':'nosniff','Vary':'Origin'};
    if(origin)headers['Access-Control-Allow-Origin']=origin;
    return new Response(bytes,{headers});
   }catch{return json(request,{ok:false,error:'Official radar map unavailable'},503)}
  }

  // Read-only information about officially issued weather warnings, model
  // precipitation and upstream measurements. This never changes alert logic.
  if(url.pathname==='/api/early-signals'&&request.method==='GET'){
   const origin=request.headers.get('Origin');
   if(origin&&!ALLOWED_ORIGINS.has(origin))return json(request,{error:'Origin not allowed'},403);
   try{return json(request,await loadEarlySignals(env.DB))}
   catch(error){return json(request,{ok:false,error:'Early indicators are not current'},503)}
  }
  // Only the exact repository main-branch GitHub Actions workflow may write
  // verified measurements. An untrusted HTTP client cannot forge flood readings.
  if(url.pathname==='/api/vigicrues-ingest'&&request.method==='POST'){
   const auth=request.headers.get('Authorization')||'';
   if(!auth.startsWith('Bearer '))return json(request,{error:'GitHub identity required',stage:'auth'},401);
   let identity;
   try{
    identity=await verifyGitHubActionToken(auth.slice(7));
   }catch(error){
    const reason=String(error?.message||error).slice(0,200);
    console.error('Signed Vigicrues authentication failed:',reason);
    return json(request,{error:'GitHub identity rejected',stage:'auth',reason},401);
   }
   let payload;
   try{
    if(Number(request.headers.get('Content-Length'))>SNAPSHOT_MAX_BODY)return json(request,{error:'Payload too large',stage:'payload'},413);
    const body=await request.text();
    if(body.length>SNAPSHOT_MAX_BODY)return json(request,{error:'Payload too large',stage:'payload'},413);
    payload=JSON.parse(body);
   }catch(error){
    return json(request,{error:'Malformed snapshot JSON',stage:'payload'},400);
   }
   try{
    return json(request,await ingestSnapshot(env.DB,payload,{runId:identity.runId}));
   }catch(error){
    const reason=String(error?.message||error).slice(0,230);
    console.error('Signed Vigicrues snapshot storage failed:',reason);
    return json(request,{error:'Snapshot rejected or storage unavailable',stage:'storage',reason},422);
   }
  }
  // PWA uses this only when direct Hub'Eau observations are unavailable.
  if(url.pathname==='/api/vigicrues-backup'&&request.method==='GET'){
   const origin=request.headers.get('Origin');
   if(origin&&!ALLOWED_ORIGINS.has(origin))return json(request,{error:'Origin not allowed'},403);
   const code=url.searchParams.get('station');
   if(!validHydroStation(code))return json(request,{error:'Invalid station'},400);
   try{
    const {points,transport}=await bestVigicruesBackup(env,code,700);
    return json(request,{ok:true,source:'vigicrues',transport:transport||'direct',station:code,
      observed_at:new Date(points[0].time).toISOString(),
      data:points.map(p=>({resultat_obs:p.mm,date_obs:new Date(p.time).toISOString()}))});
   }catch(e){
    console.warn('Public Vigicrues fallback unavailable',code,String(e));
    return json(request,{ok:false,error:'Backup measurements unavailable'},503);
   }
  }
  if(url.pathname==='/health'&&request.method==='GET')return json(request,{ok:true,service:'argens-alerte-push',pushConfigured:Boolean(env.VAPID_PRIVATE_KEY&&env.VAPID_PUBLIC_KEY&&env.VAPID_SUBJECT)});
  if(url.pathname==='/subscribe'&&request.method==='POST'){
   const signedIn=await authUser(request,env.DB);if(!signedIn)return json(request,{error:'Sign in required to enable notifications'},401);
   if(!ALLOWED_ORIGINS.has(request.headers.get('Origin')))return json(request,{error:'Origin not allowed'},403);
   if(!env.DB)return json(request,{error:'Database not configured'},503);
   try{
    const raw=await request.text();if(raw.length>5000)return json(request,{error:'Too large'},413);
    const body=JSON.parse(raw),sub=body.subscription;
    if(body.language!==undefined&&!['fr','en','de'].includes(body.language))return json(request,{error:'Invalid language'},400);
    if(body.station!==STATION||!sub?.endpoint||!sub?.keys?.p256dh||!sub?.keys?.auth)return json(request,{error:'Invalid subscription'},400);
    const endpoint=new URL(sub.endpoint);if(endpoint.protocol!=='https:'||endpoint.href.length>2048)return json(request,{error:'Invalid endpoint'},400);
    if(unb64(sub.keys.p256dh).length!==65||unb64(sub.keys.auth).length<16)return json(request,{error:'Invalid keys'},400);
    await env.DB.prepare('INSERT INTO push_subscriptions(endpoint,subscription_json,station_code) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription_json=excluded.subscription_json,station_code=excluded.station_code').bind(sub.endpoint,JSON.stringify({...sub,language:['fr','en','de'].includes(body.language)?body.language:'fr'}),STATION).run();
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS push_user_devices (endpoint TEXT PRIMARY KEY,user_id TEXT NOT NULL,linked_at INTEGER NOT NULL)').run();
    await env.DB.prepare('INSERT INTO push_user_devices(endpoint,user_id,linked_at) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,linked_at=excluded.linked_at').bind(sub.endpoint,signedIn.id,Date.now()).run();
    return json(request,{ok:true});
   }catch(e){console.error('Subscription rejected',String(e));return json(request,{error:'Invalid subscription'},400)}
  }
  if(url.pathname==='/language'&&request.method==='POST'){
   if(!ALLOWED_ORIGINS.has(request.headers.get('Origin')))return json(request,{error:'Origin not allowed'},403);
   if(!env.DB)return json(request,{error:'Database not configured'},503);
   try{
    const raw=await request.text();if(raw.length>2500)return json(request,{error:'Too large'},413);
    const {endpoint,language}=JSON.parse(raw);
    if(typeof endpoint!=='string'||endpoint.length>2048||!['fr','en','de'].includes(language))return json(request,{error:'Invalid request'},400);
    const row=await env.DB.prepare('SELECT subscription_json FROM push_subscriptions WHERE endpoint=? AND station_code=?').bind(endpoint,STATION).first();
    if(!row)return json(request,{error:'Subscription not found'},404);
    const sub=JSON.parse(row.subscription_json);sub.language=language;
    await env.DB.prepare('UPDATE push_subscriptions SET subscription_json=? WHERE endpoint=? AND station_code=?').bind(JSON.stringify(sub),endpoint,STATION).run();
    return json(request,{ok:true,language});
   }catch(e){console.error('Language update failed',String(e));return json(request,{error:'Unable to save language'},500)}
  }
  if(url.pathname==='/test'&&request.method==='POST'){
   if(!ALLOWED_ORIGINS.has(request.headers.get('Origin')))return json(request,{error:'Origin not allowed'},403);
   if(!env.DB)return json(request,{error:'Database not configured'},503);
   try{
    const raw=await request.text();if(raw.length>5000)return json(request,{error:'Too large'},413);
    const {endpoint}=JSON.parse(raw);
    if(typeof endpoint!=='string'||endpoint.length>2048)return json(request,{error:'Invalid endpoint'},400);
    const row=await env.DB.prepare('SELECT subscription_json FROM push_subscriptions WHERE endpoint=? AND station_code=?').bind(endpoint,STATION).first();
    if(!row)return json(request,{error:'Subscription not found'},404);
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS push_test_cooldown (endpoint TEXT PRIMARY KEY, last_sent INTEGER NOT NULL)').run();
    const last=await env.DB.prepare('SELECT last_sent FROM push_test_cooldown WHERE endpoint=?').bind(endpoint).first();
    if(last&&Date.now()-last.last_sent<15*60000)return json(request,{error:'Please wait 15 minutes before another test'},429);
    const saved=JSON.parse(row.subscription_json);
    const payload=saved.language==='de'?{title:'Argens Alerte · Test',body:'Testbenachrichtigungen funktionieren. Dies ist keine Hochwasserwarnung.',tag:'argens-test'}:saved.language==='en'?{title:'Argens Alerte · Test',body:'Test notifications are working. This is not a flood warning.',tag:'argens-test'}:{title:'Argens Alerte · Test',body:'Les notifications de test fonctionnent. Ceci n’est pas une alerte de crue.',tag:'argens-test'};
    const response=await deliver(saved,payload,env);
    if(!response.ok){if(response.status===404||response.status===410)await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(endpoint).run();return json(request,{error:'Push provider rejected request',status:response.status},502)}
    await env.DB.prepare('INSERT INTO push_test_cooldown(endpoint,last_sent) VALUES(?,?) ON CONFLICT(endpoint) DO UPDATE SET last_sent=excluded.last_sent').bind(endpoint,Date.now()).run();
    return json(request,{ok:true});
   }catch(e){console.error('Push test failed',String(e));return json(request,{error:'Push test failed'},500)}
  }
  return json(request,{error:'Not found'},404);
 },
 async scheduled(event,env,ctx){ctx.waitUntil(scheduledCheck(env).catch(async e=>{console.error('Scheduled check failed',String(e));await recordMonitorStatus(env,false,e)}));ctx.waitUntil(checkRainForecast(env).catch(e=>console.error('Rain forecast check failed',String(e))));ctx.waitUntil(checkPersonalStations(env).catch(e=>console.error('Personal stations check failed',String(e))));ctx.waitUntil(refreshEarlySignals(env).catch(e=>console.error('Early signals refresh failed',String(e))))}
};
