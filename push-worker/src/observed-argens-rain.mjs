// Informational observations only. Météo-France's 11 already-ingested Argens RR1
// stations share D1 with the admin forecast shadow. Never change actual warnings.
const HOUR=3600000;
export const ARGENS_OBS_IDS=[
 '83004004','83007004','83031001','83050007','83051001',
 '83075001','83083001','83116022','83124002','83145001','83148002'
];
const hour=ms=>new Date(Math.floor(ms/HOUR)*HOUR).toISOString();
export function summarizeArgensObservedRain(rows,now=Date.now()){
 const accepted=new Set(ARGENS_OBS_IDS),byStation=new Map();
 const mostRecent=Math.floor(now/HOUR)*HOUR;
 for(const r of rows||[]){
  if(!accepted.has(String(r.station_id)))continue;
  const at=Date.parse(r.hour_utc),mm=r.rain_mm;
  if(mm===null||mm===undefined||mm==='')continue;
  const n=Number(mm);
  if(!Number.isFinite(at)||at%HOUR!==0||at>now+15*60000||at<now-28*HOUR
    ||!Number.isFinite(n)||n<0||n>400)continue;
  let values=byStation.get(String(r.station_id));
  if(!values){values=new Map();byStation.set(String(r.station_id),values)}
  values.set(at,n);
 }
 // Météo-France publishes completed hourly observations with a delay.
 // Latest result may be for the preceding or penultimate UTC hour.
 let end=null,cohort=null;
 for(const delay of [1,2]){
  const candidate=mostRecent-delay*HOUR;
  const stations=[...byStation].filter(([_,values])=>Array.from({length:6},(_,i)=>candidate-i*HOUR).every(h=>values.has(h)));
  if(stations.length>=5){end=candidate;cohort=stations;break}
 }
 if(end===null||now-end>3*HOUR)return null;
 const meanFor=hours=>{
  const totals=cohort.map(([_,values])=>Array.from({length:hours},(_,i)=>values.get(end-i*HOUR)).reduce((sum,n)=>sum+n,0));
  return Math.round(totals.reduce((sum,x)=>sum+x,0)/totals.length*10)/10;
 };
 return {id:'argens_observed',name:'Météo-France · Argens',status:'observed',model:'meteo_france_dpobs',
   last3hMm:meanFor(3),last6hMm:meanFor(6),latestHour:hour(end),
   stationsUsed:cohort.length,coverage:{h3:3,h6:6},
   measurementScope:'average_per_station_not_catchment',
   informationalOnly:true};
}
export async function loadArgensObservedRain(db,now=Date.now()){
 if(!db)return null;
 try{
  const since=hour(now-9*HOUR);
  const results=await db.prepare(`SELECT station_id,hour_utc,rain_mm FROM forecast_shadow_rain
   WHERE hour_utc>=? ORDER BY hour_utc DESC LIMIT 250`).bind(since).all();
  return summarizeArgensObservedRain(results.results||[],now);
 }catch{return null} // Don't disrupt other forecast cards on DB outages.
}
