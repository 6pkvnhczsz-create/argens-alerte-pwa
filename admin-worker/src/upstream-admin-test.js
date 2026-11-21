// Cloudflare Access protected admin-only upstream observation summary.
export function summarizeAdminUpstream(payload,now=Date.now()){
 const stations=(Array.isArray(payload?.upstream)?payload.upstream:[]).filter(s=>{
  const time=Date.parse(s?.observedAt);
  return s?.status==='current'&&Number.isFinite(s.trendCmH)&&Number.isFinite(s.levelM)&&Number.isFinite(time)&&time<=now+15*60000&&now-time<=90*60000;
 });
 const rising=stations.filter(s=>s.trendCmH>0).sort((a,b)=>b.trendCmH-a.trendCmH);
 return {status:stations.length?'observed':'unavailable',checkedAt:payload?.checkedAt||null,stations,
  rising:rising.length,falling:stations.filter(s=>s.trendCmH<0).length,
  stable:stations.filter(s=>s.trendCmH===0).length,
  fastest:rising[0]||null,informationalOnly:true,predictsArrivalTime:false};
}
export const UPSTREAM_ADMIN_PAGE=`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flussaufwärts · Admin-Test</title><style>body{font:16px system-ui;margin:24px auto;padding:0 20px;max-width:900px;color:#173648;background:#f3f8fa}main{background:white;padding:25px;border-radius:16px}table{border-collapse:collapse;width:100%}th,td{padding:12px;text-align:left;border-bottom:1px solid #dce7ed}a{color:#087f91}small{color:#536b78}button{padding:10px;cursor:pointer}</style><main><a href="/">← Admin-Übersicht</a><h1>Flussaufwärts · Testauswertung</h1><p>Nur im geschützten Adminbereich. Beobachtete Trends, keine Hochwasserprognose oder zusätzliche Push-Warnung.</p><p id="status">Lade aktuelle Messdaten …</p><div id="summary"></div><table><thead><tr><th>Station</th><th>Trend</th><th>Messzeit</th></tr></thead><tbody id="rows"></tbody></table><p><button id="reload">Aktualisieren</button></p><small>Fehlende oder veraltete Messungen werden nicht als stabil gewertet. Ankunftszeiten werden nicht berechnet.</small></main><script>
const status=document.getElementById('status'),summary=document.getElementById('summary'),rows=document.getElementById('rows');
async function load(){
 try{
  const response=await fetch('/api/upstream-test',{cache:'no-store'});
  if(!response.ok)throw Error('HTTP '+response.status);
  const data=await response.json();
  status.textContent=data.status==='observed'?'Letzte Auswertung: '+new Date(data.checkedAt).toLocaleString('de-DE'):'Keine ausreichend aktuellen Pegeldaten verfügbar.';
  summary.textContent='Steigend: '+data.rising+' · Fallend: '+data.falling+' · Stabil: '+data.stable+(data.fastest?' · Stärkster Anstieg: '+data.fastest.name+' ('+data.fastest.trendCmH.toFixed(1)+' cm/h)':'');
  rows.replaceChildren();
  for(const station of data.stations){
   const tr=document.createElement('tr');
   for(const value of [station.name,station.trendCmH.toFixed(1)+' cm/h',new Date(station.observedAt).toLocaleString('de-DE')]){
    const td=document.createElement('td');td.textContent=value;tr.append(td);
   }
   rows.append(tr);
  }
 }catch(error){status.textContent='Testdaten derzeit nicht verfügbar.';summary.textContent='';rows.replaceChildren();}
}
document.getElementById('reload').addEventListener('click',load);load();
</script></html>`;
