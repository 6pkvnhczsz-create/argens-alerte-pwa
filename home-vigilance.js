// Official Météo-France vigilance on Home follows the current French home gauge.
// Department comes from the Hub'Eau reference register via the Worker.
// Weather warnings are strictly informational and do not change flood alerts.
(()=>{
 const ROOT='https://argens-alerte-push.p-hammerschmidt.workers.dev';
 const DEFAULT='Y531201001';
 const byId=id=>document.getElementById(id);
 const panel=byId('homeOfficialPanel'),title=byId('earlyOfficialTitle'),
  status=byId('earlyOfficialStatus'),periods=byId('earlyOfficialPeriods'),link=byId('earlyOfficialLink');
 if(!panel||!title||!status||!periods||!link)return;
 const i18n=(fr,en,de)=>document.documentElement.lang==='de'?de:
  document.documentElement.lang==='en'?en:fr;
 const colors={green:i18n, yellow:i18n};
 const symbols={green:'🟢',yellow:'🟡',orange:'🟠',red:'🔴'};
 const validDepartment=c=>typeof c==='string'&&/^(?:0[1-9]|[1-8][0-9]|9[0-5]|2A|2B)$/.test(c);
 const validCode=c=>typeof c==='string'&&/^[A-Z][A-Z0-9]{7,13}$/.test(c);
 const safeLink=url=>{
  try{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='vigilance.meteofrance.fr'&&
   (u.pathname==='/fr'||u.pathname==='/fr/var')?u.toString():'https://vigilance.meteofrance.fr/fr'}
  catch{return 'https://vigilance.meteofrance.fr/fr'}
 };
 const labelColor=c=>({
  green:i18n('Vert','Green','Grün'),yellow:i18n('Jaune','Yellow','Gelb'),
  orange:'Orange',red:i18n('Rouge','Red','Rot')
 })[c]||'—';
 const deNames={'1':'Wind','2':'Starkregen/Überschwemmung','3':'Gewitter','4':'Flusshochwasser',
  '5':'Schnee/Glatteis','6':'Hitze','7':'Kälte','8':'Lawinen','9':'Küstenüberschwemmung'};
 const departmentLabel=value=>String(value||'').toLocaleLowerCase('fr-FR')
  .replace(/(^|[\s\-’'])(\p{L})/gu,(_,prefix,ch)=>prefix+ch.toLocaleUpperCase('fr-FR'));
 let code=validCode(window.argensHomeStationCode)?window.argensHomeStationCode:DEFAULT;
 let stationName='Roquebrune-sur-Argens',data=null,seq=0,lastChecked=0,lastCode='',lastError='';
 function showHeading(){
  const place=validDepartment(data?.department)?
   ((data.departmentName?departmentLabel(data.departmentName)+' ':'')+'('+data.department+')'):
   stationName||code;
  title.textContent=i18n('Vigilance officielle · ','Official weather warnings · ',
   'Amtliche Wetterwarnungen · ')+place;
  link.textContent=i18n('Consulter Météo-France','View Météo-France warnings',
   'Warnungen bei Météo-France ansehen');
  link.href=safeLink(data?.link);
 }
 function unavailable(){
  periods.replaceChildren();
  status.textContent=data?.status==='not_configured'||lastError==='not_configured'?
   i18n('Données officielles indisponibles (API non configurée).',
    'Official warning data unavailable (API not configured).',
    'Amtliche Warnungen derzeit nicht verfügbar (API nicht eingerichtet).'):
   i18n('Vigilance officielle momentanément indisponible. Consultez Météo-France.',
    'Official warnings temporarily unavailable. Check Météo-France.',
    'Amtliche Warnungen derzeit nicht verfügbar. Bitte Météo-France prüfen.');
  if(lastError)status.textContent+=' · '+i18n('Diagnostic : ','Diagnostic: ','Fehlercode: ')+lastError;
 }
 function render(){
  panel.hidden=false;showHeading();periods.replaceChildren();
  const update=Date.parse(data?.updatedAt||'');
  if(!data||data.status!=='official'||!validDepartment(data.department)||
     !Array.isArray(data.periods)||!data.periods.length||
     !Number.isFinite(update)||Math.abs(Date.now()-update)>24*3600000){
   unavailable();return;
  }
  status.textContent=i18n('Vigilance Météo-France par département',
   'Official Météo-France departmental warning',
   'Amtliche Météo-France-Warnungen für das Département');
  for(const p of data.periods){
   if(!['J','J1'].includes(p.period)||!Object.hasOwn(symbols,p.color))continue;
   const tile=document.createElement('div');tile.className='official-period';
   const label=document.createElement('span');
   label.textContent=p.period==='J1'?i18n('Demain','Tomorrow','Morgen'):
    i18n('Aujourd’hui','Today','Heute');
   const severity=document.createElement('strong');severity.className='risk-'+p.color;
   severity.textContent=symbols[p.color]+' '+labelColor(p.color);
   const notable=(Array.isArray(p.phenomena)?p.phenomena:[])
    .filter(x=>x&&x.color!=='green'&&Object.hasOwn(symbols,x.color))
    .map(x=>{
     const text=document.documentElement.lang==='de'?(deNames[x.id]||x.fr||x.en):
      document.documentElement.lang==='en'?x.en:x.fr;
     return String(text||'')+': '+labelColor(x.color);
    });
   const note=document.createElement('div');
   note.textContent=notable.length?notable.join(' · '):
    i18n('Aucun phénomène élevé indiqué','No elevated phenomena listed',
     'Keine erhöhte Gefahrenstufe angegeben');
   tile.append(label,severity,note);periods.append(tile);
  }
  if(!periods.children.length)unavailable();
 }
 async function refresh({force=false}={}){
  if(!force&&data&&lastCode===code&&Date.now()-lastChecked<4*60000){render();return}
  const requested=code,id=++seq;
  data=null;showHeading();periods.replaceChildren();
  status.textContent=i18n('Consultation des avertissements officiels…',
   'Loading official departmental warnings…',
   'Amtliche Warnungen für die Heimatstation werden geladen…');
  lastError='';
  try{
   const response=await fetch(ROOT+'/api/vigilance/station?station='+encodeURIComponent(requested),
    {cache:'no-store',signal:AbortSignal.timeout(20000)});
   const result=await response.json().catch(()=>null);
   if(id!==seq||code!==requested)return;
   if(!response.ok||result?.ok!==true||result.station!==requested||
      !validDepartment(result.department)){
    const diagnostic=String(result?.diagnostic||result?.reason||'http_'+response.status);
    lastError=/^(?:token_(?:http_\d{3}|fetch_failed|invalid_json|html_redirect|html_response|text_response|missing)|bulletin_(?:http_\d{3}|fetch_failed|invalid_json)|invalid_bulletin|outdated_bulletin|missing_department_period|department_unverified|department_or_source_unavailable|http_\d{3}|request_or_format_error|not_configured)$/.test(diagnostic)?diagnostic:'invalid_api_response';
    throw Error('Official departmental warning not verified');
   }
   data=result;lastCode=requested;lastChecked=Date.now();
  }catch(error){
   if(id!==seq||code!==requested)return;
   lastChecked=Date.now();lastCode=requested;
   if(!lastError)lastError=String(error?.name||'')==='TimeoutError'?'request_timeout':'connection_failed';
   // Never reuse the last station's color, dates or department after a failure.
   data=null;
  }
  render();
 }
 function select(event){
  const next=event.detail?.code;
  if(!validCode(next))return;
  const changed=next!==code;
  code=next;stationName=event.detail?.name||next;
  if(changed){lastChecked=0;lastCode='';data=null}
  refresh({force:changed});
 }
 document.addEventListener('argens-station-selected',select);
 document.addEventListener('argens-home-station-restored',select);
 document.addEventListener('argens-language-changed',render);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Date.now()-lastChecked>4*60000)refresh()});
 window.refreshHomeVigilance=()=>refresh({force:true});
 setInterval(()=>{if(!document.hidden&&Date.now()-lastChecked>4*60000)refresh()},5*60000);
 refresh({force:true});
})();
