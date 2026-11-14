// Argens Alerte — independent Cloudflare Worker backend
// Requires DB D1 binding, VAPID_PRIVATE_KEY secret, VAPID_PUBLIC_KEY and VAPID_SUBJECT vars.

// Private Worker-to-Worker RPC; not exposed as a public HTTP route.
import { WorkerEntrypoint } from 'cloudflare:workers';
export class AdminPushService extends WorkerEntrypoint {
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
  const payload={title:({orange:'🟠 🌊',red:'🔴 🌊',green:'🟢 🌊'}[data.level])+' Argens Alerte · SIMULATION',body:names[data.level]+' · '+rules[data.level]+(en?'. TEST ONLY — no real flood warning.':'. TEST UNIQUEMENT — aucune alerte réelle.'),tag:'argens-admin-flood-test-'+data.level};
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
const ORIGIN='https://6pkvnhczsz-create.github.io';
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
function cors(request){return {'Access-Control-Allow-Origin':request.headers.get('Origin')===ORIGIN?ORIGIN:'null','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Vary':'Origin'}}
function json(request,value,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8',...cors(request),'Cache-Control':'no-store'}})}
function levelFor(metres,rate){return metres>=4.5?'red':metres>=3||(rate!==null&&rate>=30)?'orange':'green'}
async function currentObservation(){
 const url=API+'?code_entite='+STATION+'&grandeur_hydro=H&size=100&sort=desc&format=json';
 const response=await fetch(url,{headers:{Accept:'application/json'},cf:{cacheTtl:0}});
 if(!response.ok)throw Error('Hub Eau HTTP '+response.status);
 const data=await response.json();
 const points=(data.data||[]).map(x=>({mm:Number(x.resultat_obs),time:new Date(x.date_obs).getTime()})).filter(x=>Number.isFinite(x.mm)&&Number.isFinite(x.time)).sort((a,b)=>b.time-a.time);
 if(!points.length)throw Error('No measurements');
 const last=points[0],age=Date.now()-last.time;
 if(age>3*3600000||age< -15*60000)throw Error('Stale measurements');
 const ref=points.find(x=>(last.time-x.time)>=30*60000&&(last.time-x.time)<=180*60000);
 const rate=ref?(last.mm-ref.mm)/10/((last.time-ref.time)/3600000):null;
 return {metres:last.mm/1000,rate,level:levelFor(last.mm/1000,rate),observedAt:new Date(last.time).toISOString()};
}
const labels={green:'Vert',orange:'Orange',red:'Rouge'};
function notification(obs,previous,lang='fr'){
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
   const result=await deliver(sub,payload,env);
   if(result.ok)sent++;
   else if(result.status===404||result.status===410)await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(row.endpoint).run();
   else{failures++;console.error('Rain push rejected',result.status)}
  }catch(e){failures++;console.error('Rain push failed',String(e))}
 }
 if(!failures)await env.DB.prepare('UPDATE rain_alert_state SET level=?,updated_at=CURRENT_TIMESTAMP WHERE location=?').bind(current,location).run();
 console.log('Rain alert',saved.level,'->',current,'max mm',max,'window start',new Date(peakStart).toISOString(),'sent',sent,'failed',failures);
}

async function scheduledCheck(env){
 const obs=await currentObservation();
 await recordMonitorStatus(env,true,obs);
 const row=await env.DB.prepare('SELECT alert_level FROM alert_state WHERE station_code = ?').bind(STATION).first();
 const previous=row?.alert_level||'unknown';
 // Initialize without sending a surprise notification to existing subscribers.
 if(previous==='unknown'){await env.DB.prepare('INSERT INTO alert_state(station_code,alert_level,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(station_code) DO UPDATE SET alert_level=excluded.alert_level,updated_at=CURRENT_TIMESTAMP').bind(STATION,obs.level).run();return}
 if(previous===obs.level)return;
 const subs=await env.DB.prepare('SELECT endpoint, subscription_json FROM push_subscriptions WHERE station_code=?').bind(STATION).all();
 let sent=0,failed=0;
 for(const row of subs.results||[]){
  try{
   const subscription=JSON.parse(row.subscription_json);
   const response=await deliver(subscription,notification(obs,previous,subscription.language==='en'?'en':'fr'),env);
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
const authEmail=v=>typeof v==='string'&&v.trim().length<=254&&/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v.trim())?v.trim().toLowerCase():null;
async function authTables(db){
 await db.prepare('CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,last_login_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT \'active\')').run();
 await db.prepare('CREATE TABLE IF NOT EXISTS auth_codes (email TEXT PRIMARY KEY,code_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,last_sent_at INTEGER NOT NULL)').run();
 await db.prepare('CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL)').run();
 await db.prepare('CREATE TABLE IF NOT EXISTS auth_limits (key TEXT PRIMARY KEY,window_start INTEGER NOT NULL,count INTEGER NOT NULL)').run();
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
 return db.prepare('SELECT u.id,u.email,u.created_at,u.last_login_at FROM auth_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.status=\'active\'').bind(hash,Date.now()).first();
}
async function accountRoute(request,env,url){
 if(request.headers.get('Origin')!==ORIGIN)return json(request,{error:'Origin not allowed'},403);
 if(!env.DB)return json(request,{error:'Database unavailable'},503);
 if(!env.RESEND_API_KEY||!env.AUTH_EMAIL_FROM)return json(request,{error:'Email sign-in is not configured yet'},503);
 const db=env.DB,now=Date.now(),ip=request.headers.get('CF-Connecting-IP')||'unknown';
 await authTables(db);
 if(url.pathname==='/auth/me'&&request.method==='GET'){
  const user=await authUser(request,db);return user?json(request,{user}):json(request,{error:'Unauthorized'},401);
 }
 if(url.pathname==='/auth/logout'&&request.method==='POST'){
  const token=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');
  if(token)await db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').bind(await authHash(token)).run();
  return json(request,{ok:true});
 }
 if(request.method!=='POST')return json(request,{error:'Not found'},404);
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
  const sent=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:env.AUTH_EMAIL_FROM,to:[email],subject:'Argens Alerte · Code de connexion',text:'Votre code Argens Alerte : '+code+'\\nValable 5 minutes. / Your sign-in code (valid for 5 minutes). Si vous n’avez pas demandé ce code, ignorez cet e-mail.'})});
  if(!sent.ok){console.error('Email delivery failed',sent.status);return json(request,{error:'Email delivery unavailable'},502)}
  await db.prepare('INSERT INTO auth_codes(email,code_hash,expires_at,attempts,last_sent_at) VALUES(?,?,?,0,?) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,last_sent_at=excluded.last_sent_at').bind(email,hash,now+300000,now).run();
  return json(request,{ok:true});
 }
 if(url.pathname==='/auth/verify'){
  if(!await authLimit(db,ipKey+':verify',30,3600000)||!await authLimit(db,emailKey+':verify',10,3600000))return json(request,{error:'Too many attempts'},429);
  if(typeof body.code!=='string'||!/^\\d{6}$/.test(body.code))return json(request,{error:'Invalid code'},400);
  const row=await db.prepare('SELECT * FROM auth_codes WHERE email=?').bind(email).first();
  if(!row||row.expires_at<=now||row.attempts>=5)return json(request,{error:'Code expired or invalid'},401);
  await db.prepare('UPDATE auth_codes SET attempts=attempts+1 WHERE email=?').bind(email).run();
  if(row.code_hash!==await authHash(email+':'+body.code+':'+env.AUTH_CODE_PEPPER))return json(request,{error:'Code expired or invalid'},401);
  await db.prepare('DELETE FROM auth_codes WHERE email=?').bind(email).run();
  const id=crypto.randomUUID();
  await db.prepare('INSERT INTO app_users(id,email,created_at,last_login_at) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET last_login_at=excluded.last_login_at').bind(id,email,now,now).run();
  const user=await db.prepare('SELECT id,email,created_at,last_login_at FROM app_users WHERE email=? AND status=\'active\'').bind(email).first();
  if(!user)return json(request,{error:'Account unavailable'},403);
  const token=b64url(authBytes(32));
  await db.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await authHash(token),user.id,now+30*86400000,now).run();
  return json(request,{token,user,expires_at:now+30*86400000});
 }
 return json(request,{error:'Not found'},404);
}

export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors(request)});
  if(url.pathname.startsWith('/auth/')){try{return await accountRoute(request,env,url)}catch(e){console.error('Auth error',String(e));return json(request,{error:'Authentication unavailable'},500)}}
  if(url.pathname==='/health'&&request.method==='GET')return json(request,{ok:true,service:'argens-alerte-push',pushConfigured:Boolean(env.VAPID_PRIVATE_KEY&&env.VAPID_PUBLIC_KEY&&env.VAPID_SUBJECT)});
  if(url.pathname==='/subscribe'&&request.method==='POST'){
   if(request.headers.get('Origin')!==ORIGIN)return json(request,{error:'Origin not allowed'},403);
   if(!env.DB)return json(request,{error:'Database not configured'},503);
   try{
    const raw=await request.text();if(raw.length>5000)return json(request,{error:'Too large'},413);
    const body=JSON.parse(raw),sub=body.subscription;
    if(body.language!==undefined&&!['fr','en'].includes(body.language))return json(request,{error:'Invalid language'},400);
    if(body.station!==STATION||!sub?.endpoint||!sub?.keys?.p256dh||!sub?.keys?.auth)return json(request,{error:'Invalid subscription'},400);
    const endpoint=new URL(sub.endpoint);if(endpoint.protocol!=='https:'||endpoint.href.length>2048)return json(request,{error:'Invalid endpoint'},400);
    if(unb64(sub.keys.p256dh).length!==65||unb64(sub.keys.auth).length<16)return json(request,{error:'Invalid keys'},400);
    await env.DB.prepare('INSERT INTO push_subscriptions(endpoint,subscription_json,station_code) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription_json=excluded.subscription_json,station_code=excluded.station_code').bind(sub.endpoint,JSON.stringify({...sub,language:body.language==='en'?'en':'fr'}),STATION).run();
    return json(request,{ok:true});
   }catch(e){console.error('Subscription rejected',String(e));return json(request,{error:'Invalid subscription'},400)}
  }
  if(url.pathname==='/language'&&request.method==='POST'){
   if(request.headers.get('Origin')!==ORIGIN)return json(request,{error:'Origin not allowed'},403);
   if(!env.DB)return json(request,{error:'Database not configured'},503);
   try{
    const raw=await request.text();if(raw.length>2500)return json(request,{error:'Too large'},413);
    const {endpoint,language}=JSON.parse(raw);
    if(typeof endpoint!=='string'||endpoint.length>2048||!['fr','en'].includes(language))return json(request,{error:'Invalid request'},400);
    const row=await env.DB.prepare('SELECT subscription_json FROM push_subscriptions WHERE endpoint=? AND station_code=?').bind(endpoint,STATION).first();
    if(!row)return json(request,{error:'Subscription not found'},404);
    const sub=JSON.parse(row.subscription_json);sub.language=language;
    await env.DB.prepare('UPDATE push_subscriptions SET subscription_json=? WHERE endpoint=? AND station_code=?').bind(JSON.stringify(sub),endpoint,STATION).run();
    return json(request,{ok:true,language});
   }catch(e){console.error('Language update failed',String(e));return json(request,{error:'Unable to save language'},500)}
  }
  if(url.pathname==='/test'&&request.method==='POST'){
   if(request.headers.get('Origin')!==ORIGIN)return json(request,{error:'Origin not allowed'},403);
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
    const payload=saved.language==='en'?{title:'Argens Alerte · Test',body:'Test notifications are working. This is not a flood warning.',tag:'argens-test'}:{title:'Argens Alerte · Test',body:'Les notifications de test fonctionnent. Ceci n’est pas une alerte de crue.',tag:'argens-test'};
    const response=await deliver(saved,payload,env);
    if(!response.ok){if(response.status===404||response.status===410)await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(endpoint).run();return json(request,{error:'Push provider rejected request',status:response.status},502)}
    await env.DB.prepare('INSERT INTO push_test_cooldown(endpoint,last_sent) VALUES(?,?) ON CONFLICT(endpoint) DO UPDATE SET last_sent=excluded.last_sent').bind(endpoint,Date.now()).run();
    return json(request,{ok:true});
   }catch(e){console.error('Push test failed',String(e));return json(request,{error:'Push test failed'},500)}
  }
  return json(request,{error:'Not found'},404);
 },
 async scheduled(event,env,ctx){ctx.waitUntil(scheduledCheck(env).catch(async e=>{console.error('Scheduled check failed',String(e));await recordMonitorStatus(env,false,e)}));ctx.waitUntil(checkRainForecast(env).catch(e=>console.error('Rain forecast check failed',String(e))))}
};
