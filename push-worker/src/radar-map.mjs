// Rivière Alerte: independent read-only, measured Météo-France radar map.
// Rendering is done by a signed GitHub Actions job. No radar amount influences
// alert thresholds, station selections, push, or flood extrapolations.
const ISSUER='https://token.actions.githubusercontent.com';
const JWKS='https://token.actions.githubusercontent.com/.well-known/jwks';
const AUDIENCE='riviere-alerte-radar-map';
const REPO='6pkvnhczsz-create/argens-alerte-pwa';
const WORKFLOW_REF=REPO+'/.github/workflows/radar-map-sync.yml@refs/heads/main';
export const RADAR_BOUNDS=[5.85,43.18,6.91,43.85]; // west,south,east,north (Argens / Nartuby catchment)
export const RADAR_MAX_AGE_MS=45*60*1000;
const MAX_BODY=850000;
const MAX_PNG=480000;

function fromB64Url(s){
 if(typeof s!=='string'||!/^[A-Za-z0-9_-]+$/.test(s)||s.length>25000)throw Error('Invalid token');
 return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(s.length/4)*4,'=')),c=>c.charCodeAt(0));
}
export async function verifyRadarWorkflowToken(token,{now=Date.now(),fetchImpl=fetch}={}){
 if(typeof token!=='string'||token.length>16000)throw Error('Invalid token');
 const pieces=token.split('.');if(pieces.length!==3)throw Error('Invalid JWT');
 const dec=s=>JSON.parse(new TextDecoder().decode(fromB64Url(s)));
 const head=dec(pieces[0]),claims=dec(pieces[1]),n=Math.floor(now/1000);
 if(head.alg!=='RS256'||typeof head.kid!=='string'||head.kid.length>256)throw Error('Signing key rejected');
 if(claims.iss!==ISSUER||claims.aud!==AUDIENCE)throw Error('Wrong radar audience');
 if(typeof claims.exp!=='number'||claims.exp<=n||claims.exp>n+600||typeof claims.iat!=='number'||claims.iat>n+60||claims.iat<n-900)throw Error('Identity not current');
 if(typeof claims.nbf==='number'&&claims.nbf>n+60)throw Error('Identity not yet active');
 if(String(claims.repository_id)!=='1457670420'||String(claims.repository_owner_id)!=='355805597')throw Error('Wrong repository identity');
 if(claims.repository!==REPO||claims.ref!=='refs/heads/main')throw Error('Untrusted branch');
 if(claims.workflow_ref!==WORKFLOW_REF||!['schedule','workflow_dispatch','push'].includes(claims.event_name))throw Error('Untrusted workflow');
 if(typeof claims.sub!=='string'||claims.sub!==('repo:'+REPO+':ref:refs/heads/main'))throw Error('Untrusted subject');
 const keysRes=await fetchImpl(JWKS,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(9000),cf:{cacheTtl:1800}});
 if(!keysRes.ok)throw Error('Signing keys unavailable');
 const jwk=(await keysRes.json())?.keys?.find(k=>k.kid===head.kid&&k.kty==='RSA'&&(!k.use||k.use==='sig'));
 if(!jwk)throw Error('Unrecognized signing key');
 const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
 if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,fromB64Url(pieces[2]),new TextEncoder().encode(pieces[0]+'.'+pieces[1])))throw Error('Invalid identity signature');
 return {runId:String(claims.run_id||'').slice(0,45)};
}
async function ensureTable(db){
 await db.prepare('CREATE TABLE IF NOT EXISTS radar_argens_map (id INTEGER PRIMARY KEY CHECK(id=1), observed_ms INTEGER NOT NULL, received_ms INTEGER NOT NULL, image_b64 TEXT NOT NULL, coverage_pct REAL NOT NULL, wet_pct REAL NOT NULL, run_id TEXT)').run();
}
export function validateRadarFrame(data,now=Date.now()){
 if(!data||typeof data!=='object'||!Array.isArray(data.bounds)||data.bounds.length!==4||data.bounds.some((x,i)=>x!==RADAR_BOUNDS[i]))throw Error('Wrong map extent');
 if(!Number.isSafeInteger(data.observedMs)||data.observedMs>now+10*60000||now-data.observedMs>35*60000)throw Error('Stale map timestamp');
 if(!Number.isSafeInteger(data.generatedMs)||data.generatedMs>now+60000||now-data.generatedMs>15*60000)throw Error('Stale processing time');
 if(typeof data.imageB64!=='string'||!(/^[A-Za-z0-9+/]+={0,2}$/.test(data.imageB64))||data.imageB64.length>Math.ceil(MAX_PNG/3)*4+4)throw Error('PNG is malformed or too large');
 if(typeof data.coveragePct!=='number'||!Number.isFinite(data.coveragePct)||data.coveragePct<0||data.coveragePct>100||data.coveragePct<5)throw Error('Radar coverage insufficient');
 if(typeof data.wetPct!=='number'||!Number.isFinite(data.wetPct)||data.wetPct<0||data.wetPct>100)throw Error('Invalid wet fraction');
 const bytes=Uint8Array.from(atob(data.imageB64),x=>x.charCodeAt(0));
 if(bytes.byteLength<60||bytes.byteLength>MAX_PNG||![137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b))throw Error('Not a PNG');
 const get32=i=>((bytes[i]*16777216)+(bytes[i+1]<<16)+(bytes[i+2]<<8)+bytes[i+3])>>>0;
 if(get32(8)!==13||String.fromCharCode(...bytes.slice(12,16))!=='IHDR')throw Error('PNG missing IHDR');
 const width=get32(16),height=get32(20);
 if(width!==720||height!==500||bytes[25]!==6)throw Error('Wrong PNG dimensions or format'); // RGBA 8-bit image
 return {bytes,observedMs:data.observedMs,coveragePct:data.coveragePct,wetPct:data.wetPct};
}
export async function storeRadarFrame(db,data,{now=Date.now(),runId=''}={}){
 const frame=validateRadarFrame(data,now);
 await ensureTable(db);
 const result=await db.prepare('INSERT INTO radar_argens_map(id,observed_ms,received_ms,image_b64,coverage_pct,wet_pct,run_id) VALUES (1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET observed_ms=excluded.observed_ms,received_ms=excluded.received_ms,image_b64=excluded.image_b64,coverage_pct=excluded.coverage_pct,wet_pct=excluded.wet_pct,run_id=excluded.run_id WHERE excluded.observed_ms>=radar_argens_map.observed_ms AND excluded.received_ms>radar_argens_map.received_ms')
  .bind(frame.observedMs,now,data.imageB64,frame.coveragePct,frame.wetPct,runId).run();
 return {ok:true,stored:result.meta?.changes!==0,observedAt:new Date(frame.observedMs).toISOString(),coveragePct:frame.coveragePct};
}
export async function readRadarFrame(db,{now=Date.now()}={}){
 await ensureTable(db);
 const row=await db.prepare('SELECT observed_ms,received_ms,image_b64,coverage_pct,wet_pct FROM radar_argens_map WHERE id=1').first();
 if(!row||!Number.isSafeInteger(row.observed_ms)||!Number.isSafeInteger(row.received_ms)||row.observed_ms>now+10*60000||now-row.observed_ms>RADAR_MAX_AGE_MS||now-row.received_ms>RADAR_MAX_AGE_MS)throw Error('Official radar image unavailable or stale');
 return {imageB64:row.image_b64,bounds:RADAR_BOUNDS,observedAt:new Date(row.observed_ms).toISOString(),
  coveragePct:Number(row.coverage_pct),wetPct:Number(row.wet_pct)};
}
export async function fetchOfficialRadarH5(env,{fetchImpl=fetch}={}){
 if(!env.METEO_FRANCE_API_KEY)throw Error('Météo-France radar key not configured');
 const api='https://public-api.meteofrance.fr/public/DPRadar/v1/mosaiques/METROPOLE/observations/LAME_D_EAU/produit?maille=500';
 const response=await fetchImpl(api,{headers:{apikey:env.METEO_FRANCE_API_KEY,Accept:'application/x-hdf'},redirect:'manual',signal:AbortSignal.timeout(40000),cf:{cacheTtl:0}});
 if(!response.ok||response.status>=300||response.redirected){
  const status=Number(response.status);
  throw Error(Number.isInteger(status)&&status>=300&&status<=599?'radar_http_'+status:'radar_http_other');
 }
 const len=Number(response.headers.get('content-length'));
 if(Number.isFinite(len)&&len>40000000)throw Error('Radar file exceeds safety limit');
 return response;
}
