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
function notification(obs,previous){
 const change=previous==='unknown'?'Niveau observé':obs.level==='green'?'Retour au vert':obs.level==='red'?'Alerte rouge':obs.level==='orange'?'Alerte orange':'Mise à jour';
 const trend=obs.rate===null?'':' · '+(obs.rate>=0?'+':'')+obs.rate.toFixed(1)+' cm/h';
 return {title:'Argens Alerte · '+change,body:'Roquebrune-sur-Argens : '+obs.metres.toFixed(2).replace('.',',')+' m'+trend+'. Seuil indicatif non officiel.',tag:'argens-'+obs.level};
}
async function scheduledCheck(env){
 const obs=await currentObservation();
 const row=await env.DB.prepare('SELECT alert_level FROM alert_state WHERE station_code = ?').bind(STATION).first();
 const previous=row?.alert_level||'unknown';
 // Initialize without sending a surprise notification to existing subscribers.
 if(previous==='unknown'){await env.DB.prepare('INSERT INTO alert_state(station_code,alert_level,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(station_code) DO UPDATE SET alert_level=excluded.alert_level,updated_at=CURRENT_TIMESTAMP').bind(STATION,obs.level).run();return}
 if(previous===obs.level)return;
 const subs=await env.DB.prepare('SELECT endpoint, subscription_json FROM push_subscriptions WHERE station_code=?').bind(STATION).all();
 const payload=notification(obs,previous);
 let sent=0,failed=0;
 for(const row of subs.results||[]){
  try{
   const subscription=JSON.parse(row.subscription_json);
   const response=await deliver(subscription,payload,env);
   if(response.ok)sent++;
   else if(response.status===404||response.status===410){await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(row.endpoint).run()}
   else{failed++;console.error('Push rejected',response.status)}
  }catch(error){failed++;console.error('Push delivery error',String(error))}
 }
 // Retain prior state if transient delivery failures occur, allowing next check to retry.
 if(failed===0){await env.DB.prepare('INSERT INTO alert_state(station_code,alert_level,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(station_code) DO UPDATE SET alert_level=excluded.alert_level,updated_at=CURRENT_TIMESTAMP').bind(STATION,obs.level).run()}
 console.log('Argens alert transition',previous,obs.level,'sent',sent,'failed',failed);
}
export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors(request)});
  if(url.pathname==='/health'&&request.method==='GET')return json(request,{ok:true,service:'argens-alerte-push',pushConfigured:Boolean(env.VAPID_PRIVATE_KEY&&env.VAPID_PUBLIC_KEY&&env.VAPID_SUBJECT)});
  if(url.pathname==='/subscribe'&&request.method==='POST'){
   if(request.headers.get('Origin')!==ORIGIN)return json(request,{error:'Origin not allowed'},403);
   if(!env.DB)return json(request,{error:'Database not configured'},503);
   try{
    const raw=await request.text();if(raw.length>5000)return json(request,{error:'Too large'},413);
    const body=JSON.parse(raw),sub=body.subscription;
    if(body.station!==STATION||!sub?.endpoint||!sub?.keys?.p256dh||!sub?.keys?.auth)return json(request,{error:'Invalid subscription'},400);
    const endpoint=new URL(sub.endpoint);if(endpoint.protocol!=='https:'||endpoint.href.length>2048)return json(request,{error:'Invalid endpoint'},400);
    if(unb64(sub.keys.p256dh).length!==65||unb64(sub.keys.auth).length<16)return json(request,{error:'Invalid keys'},400);
    await env.DB.prepare('INSERT INTO push_subscriptions(endpoint,subscription_json,station_code) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription_json=excluded.subscription_json,station_code=excluded.station_code').bind(sub.endpoint,JSON.stringify(sub),STATION).run();
    return json(request,{ok:true});
   }catch(e){console.error('Subscription rejected',String(e));return json(request,{error:'Invalid subscription'},400)}
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
    const response=await deliver(JSON.parse(row.subscription_json),{title:'Argens Alerte · Test',body:'Les notifications de test fonctionnent. Ceci n’est pas une alerte de crue.',tag:'argens-test'},env);
    if(!response.ok){if(response.status===404||response.status===410)await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(endpoint).run();return json(request,{error:'Push provider rejected request',status:response.status},502)}
    await env.DB.prepare('INSERT INTO push_test_cooldown(endpoint,last_sent) VALUES(?,?) ON CONFLICT(endpoint) DO UPDATE SET last_sent=excluded.last_sent').bind(endpoint,Date.now()).run();
    return json(request,{ok:true});
   }catch(e){console.error('Push test failed',String(e));return json(request,{error:'Push test failed'},500)}
  }
  return json(request,{error:'Not found'},404);
 },
 async scheduled(event,env,ctx){ctx.waitUntil(scheduledCheck(env).catch(e=>console.error('Scheduled check failed',String(e))))}
};
