// Standalone nationwide home-station presentation.
// Verified local upstream stations use official directed BD TOPAGE edges;
// the Argens-specific cards stay visible ONLY at the original reference.
(()=>{
 const DEFAULT='Y531201001';
 const ROOT='https://argens-alerte-push.p-hammerschmidt.workers.dev';
 const el=id=>document.getElementById(id);
 const lang=(fr,en,de)=>document.documentElement.lang==='de'?de:document.documentElement.lang==='en'?en:fr;
 const text=(id,value)=>{const node=el(id);if(node)node.textContent=value};
 let code=window.argensHomeStationCode||DEFAULT,name='Roquebrune-sur-Argens';
 let map=null,layer=null,seq=0,lastRun=0,lastCode='',loaded=null;
 const isVisible=()=>!el('forecastPage').classList.contains('hidden');
 function scope(){
  const argens=code===DEFAULT;
  for(const key of ['rainForecastCard','recentRainCard','homeOfficialPanel','earlyUpstreamStatus','upstreamMap','upstreamMapMessage','earlyUpstreamRows']){
   const node=el(key);if(node)node.hidden=!argens;
  }
  const national=el('nationalUpstreamContainer');national.hidden=argens;
  el('nearbyGaugesBlock').hidden=!(loaded?.ok&&Array.isArray(loaded.nearby)&&loaded.nearby.length);
  el('homeNationalOfficialNote').hidden=argens;
  const updated=el('earlySignalsChecked')?.closest('.forecast-updated');
  if(updated)updated.hidden=!argens;
  text('forecastPageTitle',argens?
   lang('Prévisions · bassin de l’Argens','Forecasts · Argens catchment','Vorhersagen · Argens-Einzugsgebiet'):
   lang('Prévisions · ','Forecasts · ','Vorhersagen · ')+(name||code));
  text('earlyUpstreamTitle',argens?
   lang('Stations en amont','Upstream gauges','Oberlieger-Pegel'):
   lang('Stations en amont · réseau vérifié','Upstream gauges · verified river network','Oberlieger · geprüftes Flussnetz'));
  const notice=el('homeNationalOfficialNote');
  if(!argens){
   notice.replaceChildren(document.createTextNode(lang(
    'La vigilance officielle du Var ne concerne pas votre station. Voir la vigilance nationale : ',
    'The current Var official warning does not apply to your station. See national vigilance: ',
    'Die amtliche Var-Warnung gilt nicht für Ihre Station. Nationale Warnungen: ')));
   const link=document.createElement('a');
   link.href='https://vigilance.meteofrance.fr/fr';
   link.target='_blank';link.rel='noopener noreferrer';link.textContent='Météo-France';
   notice.append(link);
  }
  if(loaded)draw(loaded);
 }
 function putLabel(node,label,value){
  const line=document.createElement('div');line.className='upstream-distance-row';
  const heading=document.createElement('strong');heading.textContent=label;
  const data=document.createElement('span');data.textContent=value;
  line.append(heading,data);node.append(line);
 }
 function draw(data){
  const list=el('nationalUpstreamRows'),note=el('nationalUpstreamNote');
  list.replaceChildren();
  const locale=document.documentElement.lang==='de'?'de-DE':document.documentElement.lang==='en'?'en-GB':'fr-FR';
  const format=n=>Number(n).toLocaleString(locale,{maximumFractionDigits:1});
  if(data?.ok&&data.status==='verified'&&Array.isArray(data.stations)){
   for(let i=0;i<data.stations.length;i++){
    const st=data.stations[i],sign=st.trendCmH>0?'↑ +':st.trendCmH<0?'↓ ':'→ ';
    putLabel(list,(i+1)+'. '+st.name,
     format(st.levelM)+' m · '+sign+format(st.trendCmH)+' cm/h');
   }
   text('nationalUpstreamStatus',lang('Stations reliées avec mesures récentes : ','Verified upstream gauges with recent measurements: ','Verifizierte Oberlieger mit aktuellen Messwerten: ')+data.stations.length);
  }else if(data?.ok){
   text('nationalUpstreamStatus',lang('Aucune station en amont avec connexion et mesures récentes vérifiées dans ce secteur.',
    'No verified upstream station with fresh measurements in this local area.',
    'Keine verifizierte Oberliegerstation mit aktuellen Messwerten in diesem lokalen Kartenausschnitt.'));
  }else{
   text('nationalUpstreamStatus',lang('Vérification des connexions fluviales temporairement indisponible.',
    'Upstream river connectivity currently cannot be verified.',
    'Flussaufwärts-Verbindungen derzeit nicht verlässlich prüfbar.'));
  }
  const nearbyBlock=el('nearbyGaugesBlock'),nearbyList=el('nearbyGaugesRows');
  nearbyList.replaceChildren();
  const near=Array.isArray(data?.nearby)?data.nearby:[];
  nearbyBlock.hidden=!data?.ok||!near.length;
  text('nearbyGaugesTitle',lang('Stations voisines dans un rayon de 40 km',
   'Nearby gauges within 40 km','Weitere Pegel im Umkreis von 40 km'));
  text('nearbyGaugesSubtitle',lang(
   'Stations géographiquement proches, sans connexion en amont vérifiée. Les distances sont à vol d’oiseau.',
   'Geographically nearby gauges, not verified upstream. Distances are straight-line.',
   'Geografisch nahe Pegel, keine bestätigten Oberlieger. Entfernungen sind Luftlinie.'));
  for(const station of near){
   const dist=Number(station.distanceKm),suffix=Number.isFinite(dist)?' · '+format(dist)+' km':'';
   const recorded=Number.isFinite(station.levelM)&&Number.isFinite(station.trendCmH);
   const change=station.trendCmH>0?'↑ +':station.trendCmH<0?'↓ ':'→ ';
   putLabel(nearbyList,station.name+suffix,recorded?
    format(station.levelM)+' m · '+change+format(station.trendCmH)+' cm/h':
    lang('Mesure récente indisponible','No recent reading','Kein aktueller Messwert'));
  }
  note.textContent=lang(
   'Recherche des stations jusqu’à 40 km (distance à vol d’oiseau). L’analyse amont vérifie seulement certains corridors du réseau BD TOPAGE 2025 ; elle ne couvre pas tout le bassin. Aucun temps de crue calculé. Alertes inchangées.',
   'Station search within 40 km (straight-line). Upstream verification checks only selected BD TOPAGE 2025 river corridors, not the entire catchment. No flood travel times. Alerts unchanged.',
   'Stationssuche bis 40 km Luftlinie. Nur ausgewählte Flusskorridore werden hydrologisch über BD TOPAGE 2025 geprüft, nicht das gesamte Einzugsgebiet. Keine Fließzeiten berechnet. Warnungen unverändert.');
 }
 async function drawMap(data,request){
  if(!isVisible()||code===DEFAULT)return;
  try{
   const home=data?.home||null;
   if(!home||!Number.isFinite(home.lat)||!Number.isFinite(home.lon))return;
   const L=await window.loadMapLibrary();
   if(request!==seq||!isVisible()||code===DEFAULT)return;
   const node=el('nationalUpstreamMap');node.hidden=false;
   if(!map){
    map=L.map(node,{scrollWheelZoom:false,zoomControl:true});
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
     maxZoom:15,attribution:'© OpenStreetMap contributors'}).addTo(map);
    layer=L.layerGroup().addTo(map);
   }
   layer.clearLayers();
   const marker=L.divIcon({className:'upstream-home-pin-wrap',
    html:'<span class="upstream-home-pin"><span>●</span></span><span class="upstream-home-label">'+
     (String(home.name||'Station').replace(/[&<>"']/g,''))+'</span>',
    iconSize:[24,24],iconAnchor:[10,20]});
   layer.addLayer(L.marker([home.lat,home.lon],{icon:marker,zIndexOffset:1000,title:home.name||home.code})
    .bindPopup(home.name||home.code));
   const all=[[home.lat,home.lon]];
   for(const [i,st] of (data.stations||[]).entries()){
    if(!Number.isFinite(st.lat)||!Number.isFinite(st.lon))continue;
    const icon=L.divIcon({className:'upstream-gauge-marker-wrap',
     html:'<span class="upstream-gauge-marker"><span class="upstream-station-pin">'+String(i+1)+'</span></span>',
     iconSize:[32,32],iconAnchor:[16,16]});
    const locale=document.documentElement.lang==='de'?'de-DE':document.documentElement.lang==='en'?'en-GB':'fr-FR';
    const number=n=>Number(n).toLocaleString(locale,{maximumFractionDigits:1});
    const trend=st.trendCmH>0?'↑ +':st.trendCmH<0?'↓ ':'→ ';
    const popup=document.createElement('div'),heading=document.createElement('strong'),level=document.createElement('p');
    heading.textContent=st.name;level.textContent=number(st.levelM)+' m · '+trend+number(st.trendCmH)+' cm/h';
    popup.append(heading,level);
    layer.addLayer(L.marker([st.lat,st.lon],{icon,title:st.name}).bindPopup(popup));
    all.push([st.lat,st.lon]);
   }
   for(const st of data.nearby||[]){
    if(!Number.isFinite(st.lat)||!Number.isFinite(st.lon))continue;
    const nearbyIcon=L.divIcon({className:'upstream-nearby-marker',
     html:'<span class="upstream-nearby-pin" aria-hidden="true"></span>',
     iconSize:[20,20],iconAnchor:[10,10]});
    const popup=document.createElement('div'),heading=document.createElement('strong'),info=document.createElement('p');
    heading.textContent=st.name||st.code;
    info.textContent=lang('Station voisine · connexion fluviale non vérifiée',
     'Nearby gauge · upstream connection not verified',
     'Pegel im Umkreis · Flussverbindung nicht geprüft');
    popup.append(heading,info);
    layer.addLayer(L.marker([st.lat,st.lon],{icon:nearbyIcon,title:st.name||st.code}).bindPopup(popup));
    all.push([st.lat,st.lon]);
   }
   map.fitBounds(all,{padding:[32,32],maxZoom:10,animate:false});
   requestAnimationFrame(()=>map?.invalidateSize());
  }catch(error){
   if(request===seq)el('nationalUpstreamMap').hidden=true;
  }
 }
 async function load(){
  if(!isVisible())return;
  if(loaded&&lastCode===code&&Date.now()-lastRun<3*60000){
   scope();drawMap(loaded,seq);return;
  }
  const request=++seq,requested=code;
  text('nationalUpstreamStatus',lang('Vérification du réseau hydrographique officiel…',
   'Checking official river network…','Prüfe amtliches Flussnetz…'));
  el('nationalUpstreamMap').hidden=true;el('nationalUpstreamRows').replaceChildren();
  try{
   const response=await fetch(ROOT+'/api/upstream/stations?station='+encodeURIComponent(requested),
    {cache:'no-store',signal:AbortSignal.timeout(28000)});
   if(!response.ok)throw Error('Upstream verification unavailable');
   const data=await response.json();
   if(request!==seq||requested!==code||!data.ok||data.home?.code!==code||
      data.hydrologicalConnectivity!=='directed_verified_local_only'||!Array.isArray(data.stations))throw Error('Invalid upstream dataset');
   loaded=data;lastCode=code;lastRun=Date.now();draw(data);
   if(code!==DEFAULT)await drawMap(data,request);
  }catch(error){
   if(request!==seq)return;
   loaded=null;draw(null);
   // The station itself is still located using the independent PIAF metadata.
   try{
    const res=await fetch(ROOT+'/api/piaf/metadata?station='+encodeURIComponent(requested),
     {cache:'no-store',signal:AbortSignal.timeout(12000)});
    const info=await res.json();
    if(request===seq&&info.station?.code===requested)await drawMap({home:info.station,stations:[]},request);
   }catch{}
  }
 }
 function selected(event){
  const next=event.detail?.code;
  if(typeof next!=='string'||!/^[A-Z][A-Z0-9]{7,13}$/.test(next))return;
  if(next!==code){seq++;lastRun=0;loaded=null;code=next}
  name=event.detail?.name||next;scope();
  if(isVisible())load();
  if(code===DEFAULT&&isVisible()&&typeof window.renderEarlySignals==='function')window.renderEarlySignals();
 }
 document.addEventListener('argens-station-selected',selected);
 document.addEventListener('argens-home-station-restored',selected);
 document.addEventListener('argens-language-changed',scope);
 window.loadNationwideUpstream=load;
 scope();
})();
