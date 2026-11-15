// Rivière Alerte · PIAF animation (read-only). All data come from Cloudflare,
// never from fabricated frames. Not an input to alert or push logic.
(()=>{
 const root=document.getElementById('piafForecastPanel');
 if(!root)return;
 const API='https://argens-alerte-push.p-hammerschmidt.workers.dev/api/piaf';
 const BOUNDS=[[43.18,5.85],[43.85,6.91]];
 const id=x=>document.getElementById(x);
 const lang=(fr,en,de)=>document.documentElement.lang==='de'?de:document.documentElement.lang==='en'?en:fr;
 const time=x=>new Date(x).toLocaleTimeString(document.documentElement.lang==='de'?'de-DE':document.documentElement.lang==='en'?'en-GB':'fr-FR',
  {hour:'2-digit',minute:'2-digit',timeZone:'Europe/Paris'});
 let map=null,overlay=null,model=null,frameIndex=0,playing=null,loading=false,frameSeq=0,lastCheck=0;
 const slider=id('piafSlider'),play=id('piafPlay'),mapNode=id('piafForecastMap'),controls=id('piafForecastControls');
 function text(el,s){id(el).textContent=s}
 function pause(){if(playing)clearInterval(playing);playing=null;play.textContent='▶'}
 function labels(){
  text('piafForecastTitle',lang('Animation des pluies prévues · jusqu’à 3 h','Forecast rain animation · up to 3 h','Regenprognose als Animation · bis 3 Std.'));
  text('piafForecastDisclaimer',lang(
   'Prévision Météo-France PIAF, par pas de 5 min. Ni radar mesuré, ni prévision de crue. Sans effet sur les alertes.',
   'Météo-France PIAF forecast in 5-minute steps. Not measured radar or a flood forecast. Does not affect alerts.',
   'Météo-France PIAF-Prognose in 5-Minuten-Schritten. Kein gemessener Regen und keine Hochwasserprognose. Warnungen unverändert.'));
  slider.setAttribute('aria-label',lang('Heure prévue','Forecast time','Vorhersagezeit'));
  play.setAttribute('aria-label',lang('Lancer ou arrêter l’animation','Play or pause animation','Animation starten oder pausieren'));
  mapNode.setAttribute('aria-label',lang('Carte de pluie prévue','Forecast rain map','Regenprognose-Karte'));
  if(model){
   text('piafFrameTime',time(model.frames[frameIndex]));
   text('piafRunTime',lang('Modèle actualisé : ','Model run: ','Modelllauf: ')+time(model.referenceTime)+' · Météo-France');
   text('piafForecastStatus',lang('Pluie prévue à ','Forecast rain at ','Regenvorhersage für ')+time(model.frames[frameIndex]));
  }
 }
 function showFrame(i){
  if(!map||!model)return;
  frameIndex=Math.max(0,Math.min(model.frames.length-1,Math.trunc(i)||0));
  const t=model.frames[frameIndex];slider.value=String(frameIndex);text('piafFrameTime',time(t));
  const n=++frameSeq,L=window.L;
  const layer=L.imageOverlay(API+'/frame?time='+encodeURIComponent(t),BOUNDS,{opacity:0.82,interactive:false});
  layer.once('load',()=>{
   if(n!==frameSeq){map.removeLayer(layer);return}
   if(overlay)map.removeLayer(overlay);
   overlay=layer;
   text('piafForecastStatus',lang('Pluie prévue à ','Forecast rain at ','Regenvorhersage für ')+time(t)+' · Météo-France PIAF');
  });
  layer.once('error',()=>{
   map.removeLayer(layer);if(n!==frameSeq)return;
   pause();text('piafForecastStatus',lang('Image de prévision indisponible.','Forecast frame unavailable.','Prognosebild nicht verfügbar.'));
  });
  layer.addTo(map);
 }
 function togglePlay(){
  if(playing){pause();return}
  if(!model||model.frames.length<2)return;
  if(frameIndex>=model.frames.length-1)showFrame(0);
  play.textContent='❚❚';
  playing=setInterval(()=>{
   if(document.hidden||id('forecastPage').classList.contains('hidden')){pause();return}
   showFrame(frameIndex>=model.frames.length-1?0:frameIndex+1);
  },1800);
 }
 play.addEventListener('click',togglePlay);
 slider.addEventListener('input',()=>{pause();showFrame(Number(slider.value))});
 function mapLabels(){
  text('stationSearchTitle',lang('📍 Trouver une station près de chez moi','📍 Find a station near me','📍 Station in meiner Nähe finden'));
  text('stationSearchIntro',lang(
   'Recherchez une commune ou utilisez votre position, puis choisissez une station personnelle. Pour recevoir des alertes, enregistrez-la avec vos seuils dans Réglages.',
   'Search for a town or use your location, then choose your home station. To receive alerts, save it with your thresholds in Settings.',
   'Ort suchen oder Standort verwenden und eine Station als Heimatstation auswählen. Für dauerhafte Warnungen danach die Schwellenwerte in den Einstellungen speichern.'));
  text('stationHomeReminder',lang(
   'Votre choix doit être enregistré dans Réglages pour être conservé.',
   'Save your choice in Settings to keep it.',
   'Die Auswahl wird erst durch Speichern in den Einstellungen dauerhaft übernommen.'));
 }
 mapLabels();labels();
 document.addEventListener('argens-language-changed',()=>{mapLabels();labels()});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)pause()});
 async function load(){
  if(id('forecastPage').classList.contains('hidden')||loading)return;
  if(model&&Date.now()-lastCheck<110000){map?.invalidateSize();return}
  loading=true;pause();
  text('piafForecastStatus',lang('Chargement de la prévision PIAF…','Loading PIAF forecast…','PIAF-Regenprognose wird geladen…'));
  try{
   const response=await fetch(API+'/metadata',{cache:'no-store',signal:AbortSignal.timeout(18000)});
   if(!response.ok)throw Error('No official PIAF forecast');
   const d=await response.json(),frames=d.frames;
   if(d.available!==true||d.source!=='Météo-France PIAF'||d.kind!=='forecast_5min'||
      !Array.isArray(frames)||frames.length<1||frames.length>37||
      !Array.isArray(d.bounds)||d.bounds.join(',')!=='5.85,43.18,6.91,43.85'||
      !Number.isFinite(Date.parse(d.referenceTime))||Date.now()-Date.parse(d.referenceTime)>75*60000||
      !frames.every((t,i)=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(t)&&
       Number.isFinite(Date.parse(t))&&Date.parse(t)>Date.now()-4*60000&&
       Date.parse(t)<Date.now()+181*60000&&(i===0||Date.parse(t)>Date.parse(frames[i-1]))))
    throw Error('Incomplete or outdated PIAF metadata');
   const L=await window.loadMapLibrary();
   if(id('forecastPage').classList.contains('hidden'))return;
   mapNode.hidden=false;controls.hidden=false;
   if(!map){
    map=L.map(mapNode,{scrollWheelZoom:false,zoomControl:true});
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
     maxZoom:14,attribution:'© OpenStreetMap contributors'}).addTo(map);
    L.circleMarker([43.4497,6.6331],{
     radius:5,color:'#143c5d',weight:2,fillColor:'#fff',fillOpacity:1
    }).bindTooltip('Roquebrune-sur-Argens').addTo(map);
   }
   map.fitBounds(BOUNDS,{padding:[6,6],animate:false});
   requestAnimationFrame(()=>map?.invalidateSize());
   model=d;frameIndex=0;lastCheck=Date.now();
   slider.max=String(frames.length-1);slider.value='0';slider.disabled=frames.length<2;
   play.disabled=frames.length<2;labels();showFrame(0);
  }catch(e){
   model=null;pause();slider.disabled=true;play.disabled=true;
   controls.hidden=true;mapNode.hidden=true;
   text('piafForecastStatus',lang(
    'Prévision PIAF indisponible. Le radar mesuré reste accessible ci-dessous.',
    'PIAF forecast unavailable. Measured rain radar remains available below.',
    'PIAF-Prognose nicht verfügbar. Das gemessene Regenradar bleibt unten verfügbar.'));
  }finally{loading=false}
 }
 window.loadPiafForecastMap=load;
 setInterval(()=>{if(!document.hidden&&!id('forecastPage').classList.contains('hidden'))load()},120000);
})();
