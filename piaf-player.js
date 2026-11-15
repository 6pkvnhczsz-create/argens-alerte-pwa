// Rivière Alerte – Météo-France PIAF forecast visualization.
// 5-minute forecast images are read-only and never affect flood alerts.
// Buffered frames avoid tearing when network requests are slower than playback.
(()=>{
 const root=document.getElementById('piafForecastPanel');if(!root)return;
 const API='https://argens-alerte-push.p-hammerschmidt.workers.dev/api/piaf';
 const BOUNDS=[[43.18,5.85],[43.85,6.91]];
 const id=x=>document.getElementById(x);
 const lang=(fr,en,de)=>document.documentElement.lang==='de'?de:document.documentElement.lang==='en'?en:fr;
 const time=x=>new Date(x).toLocaleTimeString(
  document.documentElement.lang==='de'?'de-DE':document.documentElement.lang==='en'?'en-GB':'fr-FR',
  {hour:'2-digit',minute:'2-digit',timeZone:'Europe/Paris'});
 const slider=id('piafSlider'),play=id('piafPlay'),mapNode=id('piafForecastMap'),controls=id('piafForecastControls');
 const legend=id('piafLegendImage'),legendFallback=id('piafLegendFallback');
 let map=null,overlay=null,model=null,frameIndex=0,loading=false,lastCheck=0,requestSerial=0;
 let playback=false,playTimer=null,drawSerial=0,preloadRun=0;
 const cache=new Map(),queued=[],pending=new Map();
 let working=0,sliderTimer=null;
 const imageURL=i=>API+'/frame?time='+encodeURIComponent(model.frames[i])+'&run='+encodeURIComponent(model.referenceTime);
 const text=(el,s)=>{const e=id(el);if(e)e.textContent=s};
 const mapVisible=()=>!id('forecastPage').classList.contains('hidden');
 const canPreload=()=>model&&mapVisible()&&!document.hidden;
 function status(s){text('piafBufferStatus',s)}
 function pause(){
  playback=false;
  if(playTimer!==null){clearTimeout(playTimer);playTimer=null}
  play.textContent='▶';
 }
 function labels(){
  text('piafForecastTitle',lang('Animation des pluies prévues · jusqu’à 3 h','Forecast rain animation · up to 3 h','Regenprognose als Animation · bis 3 Std.'));
  text('piafForecastDisclaimer',lang(
   'Prévision Météo-France PIAF, par pas de 5 min. Ni radar mesuré, ni prévision de crue. Sans effet sur les alertes.',
   'Météo-France PIAF forecast in 5-minute steps. Not measured radar or a flood forecast. Does not affect alerts.',
   'Météo-France PIAF-Prognose in 5-Minuten-Schritten. Kein gemessener Regen und keine Hochwasserprognose. Warnungen unverändert.'));
  text('piafLegendTitle',lang('Intensité de pluie prévue · mm/h','Forecast rain intensity · mm/h','Vorhergesagte Regenintensität · mm/h'));
  slider.setAttribute('aria-label',lang('Heure prévue','Forecast time','Vorhersagezeit'));
  play.setAttribute('aria-label',lang('Lancer ou arrêter l’animation','Play or pause animation','Animation starten oder pausieren'));
  mapNode.setAttribute('aria-label',lang('Carte de pluie prévue','Forecast rain map','Regenprognose-Karte'));
  legend.alt=lang('Légende officielle des couleurs Météo-France PIAF',
   'Official Météo-France PIAF colour legend','Offizielle Météo-France-PIAF-Farbskala');
  if(model){
   text('piafFrameTime',time(model.frames[frameIndex]));
   text('piafRunTime',lang('Modèle actualisé : ','Model run: ','Modelllauf: ')+time(model.referenceTime)+' · Météo-France');
   text('piafForecastStatus',lang('Pluie prévue à ','Forecast rain at ','Regenvorhersage für ')+time(model.frames[frameIndex])+' · PIAF');
  }
 }
 // Only a genuine legend from the same WMS style may claim exact mm/h values.
 legend.onload=()=>{
  legend.hidden=false;legendFallback.hidden=true;
 };
 legend.onerror=()=>{
  legend.hidden=true;legendFallback.hidden=false;
  legendFallback.textContent=lang(
   'Échelle chiffrée officielle indisponible. Les zones bleu-vert signalent généralement moins de pluie que les zones jaune-orange-rouge ; aucune valeur précise n’est attribuée sans légende du modèle.',
   'Exact official scale unavailable. Blue/green generally means less rain than yellow/orange/red; no numerical values are asserted without the model legend.',
   'Exakte Modell-Farbskala derzeit nicht verfügbar. Blau/Grün deutet meist auf schwächeren, Gelb/Orange/Rot auf stärkeren Regen hin. Ohne offizielle Legende werden keine mm/h-Grenzen behauptet.');
 };
 legend.src=API+'/legend';
 // Preload a limited window: 3 parallel requests max, ~8 images ahead.
 // No huge up-front downloads or network requests while page is hidden.
 function cancelPrefetch(){
  ++preloadRun;queued.length=0;pending.clear();cache.clear();
 }
 function pump(){
  while(working<3&&queued.length){
   const job=queued.shift();
   if(job.generation!==preloadRun||!model){job.resolve(false);continue}
   working++;
   const img=new Image();img.decoding='async';
   let done=false;
   const complete=async(ok)=>{
    if(done)return;done=true;
    if(ok&&typeof img.decode==='function'){try{await img.decode()}catch{}}
    if(job.generation===preloadRun&&ok)cache.set(job.index,img);
    if(pending.get(job.index)===job.promise)pending.delete(job.index);
    working=Math.max(0,working-1);job.resolve(ok&&job.generation===preloadRun);pump();
   };
   img.onload=()=>complete(true);img.onerror=()=>complete(false);
   img.src=job.url;
  }
 }
 function preload(index){
  if(!model||index<0||index>=model.frames.length)return Promise.resolve(false);
  if(cache.has(index))return Promise.resolve(true);
  if(pending.has(index))return pending.get(index);
  const generation=preloadRun,url=imageURL(index);
  let resolve;const promise=new Promise(r=>resolve=r);
  pending.set(index,promise);
  queued.push({generation,index,url,promise,resolve});
  pump();return promise;
 }
 function prefetchAhead(index){
  if(!canPreload())return;
  const ahead=navigator.connection?.saveData?3:8;
  for(let i=index+1;i<Math.min(model.frames.length,index+ahead+1);i++)preload(i);
 }
 function showFrame(index){
  if(!model||!map)return Promise.resolve(false);
  const desired=Math.max(0,Math.min(model.frames.length-1,Math.trunc(index)||0));
  const seq=++drawSerial,generation=preloadRun;
  text('piafFrameTime',time(model.frames[desired]));
  slider.value=String(desired);
  return preload(desired).then(ok=>{
   if(!ok||seq!==drawSerial||generation!==preloadRun||!mapVisible()){
    if(!ok&&seq===drawSerial){
     pause();status(lang('Image indisponible','Frame unavailable','Regenbild nicht verfügbar'));
    }
    return false;
   }
   const layer=window.L.imageOverlay(imageURL(desired),BOUNDS,{opacity:0,interactive:false});
   return new Promise(resolve=>{
    let finished=false;
    const finish=ok=>{
     if(finished)return;finished=true;
     if(!ok||seq!==drawSerial||generation!==preloadRun){
      if(map)map.removeLayer(layer);
      if(!ok&&seq===drawSerial){
       pause();status(lang('Image indisponible','Frame unavailable','Regenbild nicht verfügbar'));
      }
      resolve(false);return;
     }
     const previous=overlay;overlay=layer;frameIndex=desired;
     // Reveal the buffered image only once Leaflet confirms it has loaded.
     layer.setOpacity(0.82);
     if(previous)map.removeLayer(previous);
     text('piafForecastStatus',lang('Pluie prévue à ','Forecast rain at ','Regenvorhersage für ')+time(model.frames[frameIndex])+' · Météo-France PIAF');
     status('');
     prefetchAhead(frameIndex);resolve(true);
    };
    layer.once('load',()=>finish(true)).once('error',()=>finish(false)).addTo(map);
   });
  });
 }
 function scheduleNext(){
  if(!playback)return;
  playTimer=setTimeout(async()=>{
   playTimer=null;if(!playback)return;
   if(document.hidden||!mapVisible()){pause();return}
   const next=frameIndex>=model.frames.length-1?0:frameIndex+1;
   const ok=await showFrame(next);
   if(!ok){pause();return}
   scheduleNext();
  },340);
 }
 async function togglePlay(){
  if(playback){pause();return}
  if(!model||model.frames.length<2)return;
  playback=true;play.textContent='❚❚';
  status(lang('Préchargement des prochaines images…','Buffering upcoming frames…','Nächste Regenbilder werden vorgeladen…'));
  // Buffer a few frames before playback starts; no jumping over missing images.
  const start=frameIndex>=model.frames.length-1?0:frameIndex+1;
  const targets=Array.from({length:Math.min(4,model.frames.length-start)},(_,i)=>start+i);
  const ready=await Promise.all(targets.map(preload));
  if(!playback)return;
  if(ready.some(x=>!x)){pause();status(lang('Chargement interrompu','Buffering interrupted','Vorausladen fehlgeschlagen'));return}
  status('');scheduleNext();
 }
 play.addEventListener('click',togglePlay);
 slider.addEventListener('input',()=>{
  pause();const target=Number(slider.value);
  text('piafFrameTime',time(model.frames[target]));
  if(sliderTimer!==null)clearTimeout(sliderTimer);
  sliderTimer=setTimeout(()=>{sliderTimer=null;showFrame(target)},110);
 });
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
 document.addEventListener('argens-language-changed',()=>{
  mapLabels();labels();
  if(legend.hidden&&legendFallback.textContent)legend.onerror();
 });
 document.addEventListener('visibilitychange',()=>{if(document.hidden)pause()});
 async function load(){
  if(!mapVisible()||loading)return;
  if(model&&Date.now()-lastCheck<110000){map?.invalidateSize();return}
  loading=true;pause();const request=++requestSerial;
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
   if(!mapVisible()||request!==requestSerial)return;
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
   cancelPrefetch();model=d;frameIndex=0;lastCheck=Date.now();
   slider.max=String(frames.length-1);slider.value='0';slider.disabled=frames.length<2;
   play.disabled=frames.length<2;labels();
   status(lang('Chargement des images…','Loading frames…','Lade Regenbilder…'));
   await showFrame(0);
  }catch(error){
   if(request!==requestSerial)return;
   model=null;pause();cancelPrefetch();slider.disabled=true;play.disabled=true;
   controls.hidden=true;mapNode.hidden=true;
   text('piafForecastStatus',lang('Prévision PIAF momentanément indisponible.',
    'PIAF forecast temporarily unavailable.','PIAF-Regenprognose derzeit nicht verfügbar.'));
   status('');
  }finally{loading=false}
 }
 window.loadPiafForecastMap=load;
 setInterval(()=>{if(!document.hidden&&mapVisible())load()},120000);
})();
