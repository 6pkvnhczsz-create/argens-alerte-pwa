// GitHub Actions -> Cloudflare trusted, read-only hydrometric snapshot.
// GitHub OIDC signature and repository/workflow provenance are mandatory.
// The snapshot is only a fallback to Hub'Eau; stale/unverified data is never used.
import { assertFresh, validHydroStation } from './water-sources.mjs';

const ISSUER='https://token.actions.githubusercontent.com';
const JWKS='https://token.actions.githubusercontent.com/.well-known/jwks';
const AUDIENCE='riviere-alerte-vigicrues-sync';
const REPOSITORY_ID='1457670420';
const OWNER_ID='355805597';
const WORKFLOW_REF='6pkvnhczsz-create/argens-alerte-pwa/.github/workflows/vigicrues-backup-sync.yml@refs/heads/main';
const ALLOWED_EVENTS=new Set(['schedule','workflow_dispatch','push']);
export const HOME_STATION='Y531201001';
const MAX_INGEST_BYTES=50000;
export const MAX_STORE_AGE_MS=75*60*1000; // Old workflow runs are not proof of a live backup.
const FUTURE_TOLERANCE_MS=15*60*1000;
const NOT_AVAILABLE_RECHECK_MS=6*60*60*1000;
const INACTIVE_RETAIN_MS=30*24*60*60*1000;
const MIN_OBSERVATION_MS=4*24*60*60*1000;

function fromBase64Url(text){
 if(typeof text!=='string'||!/^[A-Za-z0-9_-]+$/.test(text)||text.length>25000)throw Error('Malformed token encoding');
 const str=text.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(text.length/4)*4,'=');
 return Uint8Array.from(atob(str),x=>x.charCodeAt(0));
}
function jsonPart(text){
 return JSON.parse(new TextDecoder().decode(fromBase64Url(text)));
}
export async function verifyGitHubActionToken(token,{fetchImpl=fetch,now=Date.now()}={}){
 if(typeof token!=='string'||token.length>16000)throw Error('Missing or oversized identity token');
 const parts=token.split('.');
 if(parts.length!==3)throw Error('Invalid JWT');
 const header=jsonPart(parts[0]),claims=jsonPart(parts[1]);
 if(header.alg!=='RS256'||typeof header.kid!=='string'||header.kid.length>256)throw Error('Unacceptable signing algorithm');
 const nowSec=Math.floor(now/1000);
 if(claims.iss!==ISSUER||claims.aud!==AUDIENCE)throw Error('Unexpected identity token issuer/audience');
 if(typeof claims.exp!=='number'||claims.exp<=nowSec||claims.exp>nowSec+600)throw Error('Expired or excessive token lifetime');
 if(typeof claims.iat!=='number'||claims.iat>nowSec+60||claims.iat<nowSec-900)throw Error('Invalid issue time');
 if(typeof claims.nbf==='number'&&claims.nbf>nowSec+60)throw Error('Token not yet valid');
 if(String(claims.repository_id)!==REPOSITORY_ID||String(claims.repository_owner_id)!==OWNER_ID)throw Error('Repository identity rejected');
 if(claims.repository!=='6pkvnhczsz-create/argens-alerte-pwa'||claims.ref!=='refs/heads/main')throw Error('Wrong repository or branch');
 if(claims.workflow_ref!==WORKFLOW_REF||!ALLOWED_EVENTS.has(claims.event_name))throw Error('Wrong workflow or event');
 if(typeof claims.sub!=='string'||!claims.sub.endsWith(':ref:refs/heads/main'))throw Error('Untrusted OIDC subject');
 const response=await fetchImpl(JWKS,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(9000),cf:{cacheTtl:1800}});
 if(!response.ok)throw Error('GitHub signing keys unavailable');
 const keys=(await response.json())?.keys;
 const jwk=Array.isArray(keys)?keys.find(x=>x.kid===header.kid&&x.kty==='RSA'&&(!x.use||x.use==='sig')):null;
 if(!jwk)throw Error('Unknown GitHub signing key');
 const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
 const verified=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,fromBase64Url(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]));
 if(!verified)throw Error('Invalid GitHub OIDC signature');
 return {repository:claims.repository,workflow:claims.workflow_ref,runId:String(claims.run_id||'')};
}

function isUsableStation(code){
 return validHydroStation(code);
}
async function ensureTables(db){
 await db.prepare('CREATE TABLE IF NOT EXISTS vigicrues_backup_snapshots (station_code TEXT PRIMARY KEY, latest_ms INTEGER NOT NULL, received_ms INTEGER NOT NULL, readings_json TEXT NOT NULL, run_id TEXT)').run();
 await db.prepare('CREATE TABLE IF NOT EXISTS vigicrues_backup_failures (station_code TEXT PRIMARY KEY, checked_ms INTEGER NOT NULL, reason TEXT NOT NULL)').run();
}
async function allActiveStationCodes(db){
 const response=await db.prepare("SELECT DISTINCT p.station_code AS station_code FROM user_station_settings p JOIN app_users u ON u.id=p.user_id WHERE u.status='active' ORDER BY p.station_code").all();
 const candidates=[HOME_STATION,...(response.results||[]).map(x=>x.station_code)];
 return [...new Set(candidates.filter(isUsableStation))].sort();
}
export async function isActiveBackupStation(db,station){
 if(!isUsableStation(station))return false;
 if(station===HOME_STATION)return true; // The primary monitoring station always has a backup.
 const row=await db.prepare("SELECT 1 AS present FROM user_station_settings p JOIN app_users u ON u.id=p.user_id WHERE p.station_code=? AND u.status='active' LIMIT 1").bind(station).first();
 return !!row;
}
export async function activeBackupStationCodes(db,{now=Date.now()}={}){
 await ensureTables(db);
 const codes=await allActiveStationCodes(db);
 // When a user switches stations, keep their old snapshot for at most 30 days.
 // It can never be used without an active subscriber.
 await db.prepare("DELETE FROM vigicrues_backup_snapshots WHERE station_code != ? AND received_ms < ? AND station_code NOT IN (SELECT p.station_code FROM user_station_settings p JOIN app_users u ON u.id=p.user_id WHERE u.status='active')")
  .bind(HOME_STATION,now-INACTIVE_RETAIN_MS).run();
 await db.prepare("DELETE FROM vigicrues_backup_failures WHERE checked_ms < ? AND station_code NOT IN (SELECT p.station_code FROM user_station_settings p JOIN app_users u ON u.id=p.user_id WHERE u.status='active')")
  .bind(now-INACTIVE_RETAIN_MS).run();
 const recent=(await db.prepare('SELECT station_code FROM vigicrues_backup_failures WHERE checked_ms > ?')
  .bind(now-NOT_AVAILABLE_RECHECK_MS).all()).results||[];
 const deferred=new Set(recent.map(r=>r.station_code));
 return {stations:codes.filter(code=>!deferred.has(code)),deferred:codes.filter(code=>deferred.has(code)),activeCount:codes.length};
}
export async function markVigicruesUnavailable(db,station,reason,{now=Date.now()}={}){
 if(!await isActiveBackupStation(db,station))throw Error('Inactive or unknown backup station');
 if(!['no_data','stale','not_found','access_denied','unavailable','invalid_series'].includes(reason))throw Error('Invalid backup unavailable reason');
 await ensureTables(db);
 await db.prepare('INSERT INTO vigicrues_backup_failures (station_code,checked_ms,reason) VALUES (?,?,?) ON CONFLICT(station_code) DO UPDATE SET checked_ms=excluded.checked_ms,reason=excluded.reason')
  .bind(station,now,reason).run();
 return {ok:true,station,deferredForMinutes:Math.floor(NOT_AVAILABLE_RECHECK_MS/60000)};
}
export function parseSnapshotPayload(payload,now=Date.now()){
 const station=payload?.station;
 if(!isUsableStation(station)||!Array.isArray(payload.readings)||payload.readings.length<2||payload.readings.length>700)throw Error('Unexpected station or readings');
 if(!Number.isSafeInteger(payload.collectedAt)||payload.collectedAt>now+FUTURE_TOLERANCE_MS||now-payload.collectedAt>15*60*1000)throw Error('Stale snapshot collection');
 const entries=payload.readings.map(row=>{
  if(!Array.isArray(row)||row.length!==2||!Number.isSafeInteger(row[0])||!Number.isInteger(row[1]))throw Error('Invalid observation point');
  if(row[1]<-5000||row[1]>30000)throw Error('Implausible water level');
  return {time:row[0],mm:row[1]};
 }).sort((a,b)=>b.time-a.time);
 const seen=new Set(),points=entries.filter(row=>{if(seen.has(row.time))return false;seen.add(row.time);return true});
 if(points.length<2)throw Error('Insufficient distinct observations');
 if(points.some(p=>p.time>now+FUTURE_TOLERANCE_MS||p.time<now-MIN_OBSERVATION_MS))throw Error('Out-of-range observation time');
 assertFresh(points,now);
 return points;
}
export async function ingestSnapshot(db,payload,{runId='',now=Date.now()}={}){
 const points=parseSnapshotPayload(payload,now);
 const station=payload.station;
 if(!await isActiveBackupStation(db,station))throw Error('Inactive or unregistered station');
 await ensureTables(db);
 const newest=points[0].time;
 const result=await db.prepare('INSERT INTO vigicrues_backup_snapshots (station_code,latest_ms,received_ms,readings_json,run_id) VALUES (?,?,?,?,?) ON CONFLICT(station_code) DO UPDATE SET latest_ms=excluded.latest_ms,received_ms=excluded.received_ms,readings_json=excluded.readings_json,run_id=excluded.run_id WHERE excluded.latest_ms>=vigicrues_backup_snapshots.latest_ms AND excluded.received_ms>vigicrues_backup_snapshots.received_ms')
  .bind(station,newest,now,JSON.stringify(points),String(runId).slice(0,48)).run();
 // A successful delivery immediately cancels any earlier "no data" backoff.
 if(result.meta?.changes!==0)await db.prepare('DELETE FROM vigicrues_backup_failures WHERE station_code=?').bind(station).run();
 return {ok:true,stored:result.meta?.changes!==0,station,observedAt:new Date(newest).toISOString(),readings:points.length};
}
export async function storedVigicruesObservations(db,code,{limit=100,now=Date.now()}={}){
 if(!isUsableStation(code))throw Error('Invalid backup station');
 if(!db)throw Error('Backup storage unavailable');
 if(!await isActiveBackupStation(db,code))throw Error('Station has no active subscribers');
 const row=await db.prepare('SELECT latest_ms,received_ms,readings_json FROM vigicrues_backup_snapshots WHERE station_code=?').bind(code).first();
 if(!row)throw Error('No GitHub backup snapshot received');
 if(!Number.isSafeInteger(row.received_ms)||row.received_ms>now+FUTURE_TOLERANCE_MS||now-row.received_ms>MAX_STORE_AGE_MS)throw Error('GitHub backup delivery outdated');
 const stored=JSON.parse(row.readings_json);
 // Points at the four-day cutoff naturally age out. Drop them rather than
 // rejecting an otherwise fresh series after a five-minute GitHub delay.
 const recent=stored.filter(p=>Number.isSafeInteger(p?.time)&&p.time>=now-MIN_OBSERVATION_MS&&p.time<=now+FUTURE_TOLERANCE_MS);
 const verified=parseSnapshotPayload({station:code,collectedAt:now,readings:recent.map(x=>[x.time,x.mm])},now);
 return {source:'vigicrues',transport:'github-actions',points:verified.slice(0,Math.min(limit,700)),receivedAt:new Date(row.received_ms).toISOString()};
}
export const SNAPSHOT_MAX_BODY=MAX_INGEST_BYTES;
export const SNAPSHOT_AUDIENCE=AUDIENCE;
