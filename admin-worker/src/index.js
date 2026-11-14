// Separate Cloudflare Access-protected admin Worker for Argens Alerte.
// Requires D1 binding DB and VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
// IMPORTANT: Enable Cloudflare Access for ALL traffic before deployment.
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
 return 'vapid t='+signed+'.'+b64url(sig)+', k='+env.VAPID_PUBLIC_KEY;
}
async function deliver(sub,payload,env){
 const endpoint=new URL(sub.endpoint);
 if(endpoint.protocol!=='https:')throw Error('Invalid endpoint');
 const bytes=await encryptPayload(sub,payload);
 const authorization=await vapidHeader(sub.endpoint,env);
 return fetch(sub.endpoint,{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Encoding':'aes128gcm','TTL':'3600','Authorization':authorization},body:bytes});
}

const PAGE="<!doctype html><html lang=\"fr\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Argens Alerte · Administration</title><style>body{font:16px system-ui;background:#edf3f6;color:#163447;margin:0}main{max-width:650px;margin:32px auto;padding:24px;background:white;border-radius:20px;box-shadow:0 6px 30px #123f5710}h1{font-size:24px}label{display:block;margin:15px 0 5px;font-weight:650}input,textarea,select{width:100%;box-sizing:border-box;padding:12px;border:1px solid #b7cad4;border-radius:10px;font:inherit}textarea{min-height:100px}button{padding:13px 18px;border:0;border-radius:10px;background:#087f91;color:white;font:inherit;font-weight:700;cursor:pointer}button:disabled{opacity:.5}p{line-height:1.5}.muted{color:#607785}.warn{background:#fff5dc;padding:12px;border-radius:10px}#status{white-space:pre-wrap}</style><main><h1>🌊 Argens Alerte · Administration</h1><p class=\"muted\">Messages administratifs. Aucune modification des seuils ni des mesures hydrologiques.</p><p id=\"count\">Chargement des abonnements…</p><label for=\"kind\">Type de message</label><select id=\"kind\"><option value=\"test\">Test technique</option><option value=\"maintenance\">Maintenance</option><option value=\"incident\">Incident technique</option><option value=\"custom\">Information générale</option></select><label for=\"title\">Titre</label><input id=\"title\" maxlength=\"90\"><label for=\"body\">Message</label><textarea id=\"body\" maxlength=\"400\"></textarea><p class=\"warn\">Les messages sont envoyés à tous les appareils enregistrés. Ne pas utiliser pour simuler une alerte de crue.</p><button id=\"send\">Envoyer à tous les abonnés</button><p id=\"status\" role=\"status\"></p></main><script>const presets={test:['Argens Alerte · Test','Ceci est un test technique. Aucune alerte de crue.'],maintenance:['Argens Alerte · Maintenance','Une maintenance est en cours. Les notifications peuvent être temporairement indisponibles.'],incident:['Argens Alerte · Incident technique','Un incident technique affecte le service. Nous travaillons à sa résolution.'],custom:['Argens Alerte · Information','']};const kind=document.querySelector('#kind'),title=document.querySelector('#title'),body=document.querySelector('#body'),status=document.querySelector('#status'),send=document.querySelector('#send');function preset(){[title.value,body.value]=presets[kind.value]}kind.addEventListener('change',preset);preset();fetch('/api/stats',{cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('HTTP '+r.status);return r.json()}).then(d=>document.querySelector('#count').textContent='Appareils enregistrés : '+d.subscribers).catch(()=>document.querySelector('#count').textContent='Statistiques indisponibles');send.addEventListener('click',async()=>{if(!title.value.trim()||!body.value.trim()){status.textContent='Veuillez saisir un titre et un message.';return}if(!confirm('Envoyer ce message à TOUS les abonnés ?'))return;send.disabled=true;status.textContent='Envoi en cours…';try{const r=await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:kind.value,title:title.value,body:body.value})});const data=await r.json();if(!r.ok)throw Error(data.error||'HTTP '+r.status);status.textContent='Terminé : '+data.accepted+' accepté(s), '+data.failed+' échec(s), '+data.expired+' abonnement(s) expiré(s).'}catch(e){status.textContent='Échec : '+e.message}finally{send.disabled=false}})</script></html>";
const response=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export default {async fetch(request,env){
 if(!request.headers.get('Cf-Access-Jwt-Assertion'))return response({error:'Cloudflare Access authentication required'},403);
 if(!env.DB||!env.VAPID_PUBLIC_KEY||!env.VAPID_PRIVATE_KEY||!env.VAPID_SUBJECT)return response({error:'Admin bindings not configured'},503);
 const url=new URL(request.url);
 if(request.method==='GET'&&url.pathname==='/')return new Response(PAGE,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff'}});
 if(request.method==='GET'&&url.pathname==='/api/stats'){const row=await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first();return response({subscribers:row?.n||0})}
 if(request.method==='POST'&&url.pathname==='/api/send'){
  if(request.headers.get('Origin')!==url.origin)return response({error:'Origin mismatch'},403);
  const raw=await request.text();if(raw.length>1500)return response({error:'Too large'},413);
  let data;try{data=JSON.parse(raw)}catch{return response({error:'Invalid JSON'},400)}
  if(!['test','maintenance','incident','custom'].includes(data.kind)||typeof data.title!=='string'||typeof data.body!=='string'||!data.title.trim()||!data.body.trim()||data.title.length>90||data.body.length>400)return response({error:'Invalid message'},400);
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS admin_send_log (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, accepted INTEGER, failed INTEGER, expired INTEGER, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)').run();
  const last=await env.DB.prepare('SELECT updated_at FROM admin_send_log ORDER BY id DESC LIMIT 1').first();
  if(last&&Date.now()-Date.parse(last.updated_at.replace(' ','T')+'Z')<60000)return response({error:'Wait at least 60 seconds between broadcasts'},429);
  const rows=await env.DB.prepare('SELECT endpoint,subscription_json FROM push_subscriptions').all();let accepted=0,failed=0,expired=0;
  const payload={title:data.title.trim(),body:data.body.trim(),tag:'argens-admin-'+data.kind};
  for(const row of rows.results||[]){try{const r=await deliver(JSON.parse(row.subscription_json),payload,env);if(r.ok)accepted++;else if(r.status===404||r.status===410){expired++;await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(row.endpoint).run()}else{failed++;console.error('Admin push rejected',r.status)}}catch(e){failed++;console.error('Admin push error',String(e))}}
  await env.DB.prepare('INSERT INTO admin_send_log(kind,accepted,failed,expired) VALUES(?,?,?,?)').bind(data.kind,accepted,failed,expired).run();return response({accepted,failed,expired});
 }
 return response({error:'Not found'},404)
}};