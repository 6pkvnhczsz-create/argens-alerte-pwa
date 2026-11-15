// Standalone nationwide home-station presentation.
// Verified local upstream stations use official directed BD TOPAGE edges;
// the Argens-specific cards stay visible ONLY at the original reference.
(()=>{
 const DEFAULT='Y531201001';
 const ROOT='https://argens-alerte-push.p-hammerschmidt.workers.dev';
 const el=id=>document.getElementById(id);
 const lang=(fr,en,de)=>document.documentElement.lang==='de'?de:document.documentElement.lang==='en'?en:fr;
 const text=(id,value)=>{const node=el(id);if(node)node.textContent=value};
 let code=window.argensHomeStationCode||DEFAULT,name=window.argensHomeStationName||'Roquebrune-sur-Argens';
 let map=null,layer=null,seq=0,lastRun=0,lastCode='',loaded=null;
 const nearPanel=el('nearbyGaugesBlock');
 let nearbyRequest=0,nearbyCode='',nearbyAt=0,nearbyItems=null;
 const isVisible=()=>!el('forecastPage').classList.contains('hidden');
 function scope(){
  const argens=code===DEFAULT;
  for(const key of ['rainForecastCard','recentRainCard','earlyUpstreamStatus','upstreamMap','upstreamMapMessage','earlyUpstreamRows']){
   const node=el(key);if(node)node.hidden=!argens;
  }
  const national=el('nationalUpstreamContainer');national.hidden=argens;
  el('earlyUpstreamStatus').hidden=!argens; // Argens-only status must not describe another home gauge.
  text('nearbyGaugesToggle',lang('Autres stations dans un rayon de 40 km','Other nearby gauges within 40 km','Weitere Pegel im Umkreis von 40 km'));
  text('nearbyGaugesSubtitle',lang(
   'Stations géographiquement proches, sans liaison en amont confirmée. Distance à vol d’oiseau ; elles ne servent pas aux alertes.',
   'Geographically nearby gauges without a verified upstream link. Straight-line distance; not used for alerts.',
   'Geografisch nahe Stationen ohne bestätigte Flussverbindung flussaufwärts. Luftlinie; nicht für Warnungen verwendet.'));
  if(nearPanel.open&&nearbyItems)drawNearby(nearbyItems);
  const updated=el('earlySignalsChecked')?.closest('.forecast-updated');
  if(updated)updated.hidden=!argens;
  text('forecastPageTitle',argens?
   lang('Prévisions · bassin de l’Argens','Forecasts · Argens catchment','Vorhersagen · Argens-Einzugsgebiet'):
   lang('Prévisions · ','Forecasts · ','Vorhersagen · ')+(name||code));
  text('earlyUpstreamTitle',argens?
   lang('Stations en amont','Upstream gauges','Oberlieger-Pegel'):
   lang('Stations en amont · réseau vérifié','Upstream gauges · verified river network','Oberlieger · geprüftes Flussnetz'));
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
   for(let i=0;i<Math.min(5,data.stations.length);i++){
    const st=data.stations[i],sign=st.trendCmH>0?'↑ +':st.trendCmH<0?'↓ ':'→ ';
    putLabel(list,(i+1)+'. '+st.name,
     format(st.levelM)+' m · '+sign+format(st.trendCmH)+' cm/h');
   }
   text('nationalUpstreamStatus',lang('Stations reliées avec mesures récentes : ','Verified upstream gauges with recent measurements: ','Verifizierte Oberlieger mit aktuellen Messwerten: ')+Math.min(5,data.stations.length));
  }else if(data?.ok){
   text('nationalUpstreamStatus',lang('Aucune station en amont avec connexion et mesures récentes vérifiées dans ce secteur.',
    'No verified upstream station with fresh measurements in this local area.',
    'Keine verifizierte Oberliegerstation mit aktuellen Messwerten in diesem lokalen Kartenausschnitt.'));
  }else{
   text('nationalUpstreamStatus',lang('Vérification des connexions fluviales temporairement indisponible.',
    'Upstream river connectivity currently cannot be verified.',
    'Flussaufwärts-Verbindungen derzeit nicht verlässlich prüfbar.'));
  }
  note.textContent=lang(
   'Jusqu’à cinq stations réellement situées en amont, avec mesures récentes, classées selon la proximité dans le réseau fluvial vérifié. La couverture BD TOPAGE peut être incomplète. Aucune durée de propagation calculée ; alertes inchangées.',
   'Up to five verified upstream gauges with recent readings, ordered by proximity in the verified river network. BD TOPAGE coverage can be incomplete. No flood travel times inferred; alerts unchanged.',
   'Bis zu fünf verifizierte Oberlieger mit aktuellen Messwerten, geordnet nach Nähe im geprüften Flussnetz. Die BD-TOPAGE-Abdeckung kann unvollständig sein. Keine Hochwasser-Laufzeiten berechnet; Warnungen unverändert.');

 }
 // These optional neighbours are not verified upstream stations. Load only after
 // the visitor expands the details, so normal forecast viewing stays lightweight.
 function drawNearby(stations){
  const list=el('nearbyGaugesRows');list.replaceChildren();
  const locale=document.documentElement.lang==='de'?'de-DE':document.documentElement.lang==='en'?'en-GB':'fr-FR';
  const format=n=>Number(n).toLocaleString(locale,{maximumFractionDigits:1});
  if(!stations?.length){
   putLabel(list,lang('Aucune autre station disponible','No additional gauges available','Keine weiteren Stationen verfügbar'),'');
   return;
  }
  for(const st of stations){
   const distance=Number(st.distanceKm);
   const d=Number.isFinite(distance)?' · '+format(distance)+' km':'';
   const ok=st.status==='current'&&Number.isFinite(st.levelM)&&Number.isFinite(st.trendCmH);
   const sign=st.trendCmH>0?'↑ +':st.trendCmH<0?'↓ ':'→ ';
   putLabel(list,String(st.name||st.code)+d,ok?
    format(st.levelM)+' m · '+sign+format(st.trendCmH)+' cm/h':
    lang('Mesure récente indisponible','No recent reading','Kein aktueller Messwert'));
  }
 }
 async function loadNearby(){
  if(!nearPanel.open||!isVisible())return;
  const current=code,request=++nearbyRequest;
  if(nearbyItems&&nearbyCode===current&&Date.now()-nearbyAt<120000){
   drawNearby(nearbyItems);return;
  }
  const list=el('nearbyGaugesRows');list.replaceChildren();
  putLabel(list,lang('Chargement des stations…','Loading nearby gauges…','Lade weitere Pegel…'),'');
  try{
   const res=await fetch(ROOT+'/api/upstream/stations?station='+encodeURIComponent(current)+'&nearby=1',
    {cache:'no-store',signal:AbortSignal.timeout(45000)});
   if(!res.ok)throw Error('Nearby stations unavailable');
   const data=await res.json();
   if(request!==nearbyRequest||current!==code||!nearPanel.open)return;
   if(!data.ok||data.home?.code!==current||!Array.isArray(data.nearby)||
      data.hydrologicalConnectivity!=='directed_verified_local_only')throw Error('Invalid nearby data');
   const upstreamCodes=new Set((data.stations||[]).map(x=>x.code));
   nearbyItems=data.nearby.filter(x=>x.classification==='nearby_not_verified'&&
    !upstreamCodes.has(x.code)).slice(0,8);
   nearbyCode=current;nearbyAt=Date.now();drawNearby(nearbyItems);
  }catch(err){
   if(request!==nearbyRequest||current!==code||!nearPanel.open)return;
   list.replaceChildren();
   putLabel(list,lang('Stations indisponibles pour le moment','Nearby gauges temporarily unavailable',
    'Weitere Pegel derzeit nicht verfügbar'),'');
  }
 }
 nearPanel.addEventListener('toggle',()=>{
  if(nearPanel.open)loadNearby();
  else nearbyRequest++;
 });
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
   for(const [i,st] of (data.stations||[]).slice(0,5).entries()){
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
   map.fitBounds(all,{padding:[32,32],maxZoom:10,animate:false});
   requestAnimationFrame(()=>map?.invalidateSize());
  }catch(error){
   if(request===seq)el('nationalUpstreamMap').hidden=true;
  }
 }
 async function load(){
  if(!isVisible()||code===DEFAULT)return; // Roquebrune uses its curated five live Argens gauges.
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
  if(next!==code){
   seq++;lastRun=0;loaded=null;code=next;nearbyRequest++;nearbyCode='';nearbyItems=null;
   nearPanel.open=false;el('nearbyGaugesRows').replaceChildren();
  }
  name=event.detail?.name||next;scope();
  if(isVisible())load();
  if(code===DEFAULT&&isVisible()&&typeof window.renderEarlySignals==='function')window.renderEarlySignals();
 }
 document.addEventListener('argens-station-selected',selected);
 document.addEventListener('argens-home-station-restored',selected);
 document.addEventListener('argens-language-changed',scope);
 document.addEventListener('argens-language-changed',()=>{if(nearPanel.open&&!nearbyItems)loadNearby()});
 window.loadNationwideUpstream=load;
 scope();
})();
