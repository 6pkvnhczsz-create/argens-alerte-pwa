// Rivière Alerte – Météo-France PIAF forecast visualization.
// 5-minute forecast images are read-only and never affect flood alerts.
// Buffered frames avoid tearing when network requests are slower than playback.
(()=>{
 const root=document.getElementById('piafForecastPanel');if(!root)return;
 const API='https://argens-alerte-push.p-hammerschmidt.workers.dev/api/piaf';
 const DEFAULT_CODE='Y531201001';
 const id=x=>document.getElementById(x);
 const lang=(fr,en,de)=>document.documentElement.lang==='de'?de:document.documentElement.lang==='en'?en:fr;
 const time=x=>new Date(x).toLocaleTimeString(
  document.documentElement.lang==='de'?'de-DE':document.documentElement.lang==='en'?'en-GB':'fr-FR',
  {hour:'2-digit',minute:'2-digit',timeZone:'Europe/Paris'});
 const slider=id('piafSlider'),play=id('piafPlay'),mapNode=id('piafForecastMap'),controls=id('piafForecastControls');
 const palette=window.PiafPalette;
 let map=null,overlay=null,model=null,frameIndex=0,loading=false,lastCheck=0,requestSerial=0;
 let selectedCode=DEFAULT_CODE,stationPin=null;
 function mapBounds(){return [[model.bounds[1],model.bounds[0]],[model.bounds[3],model.bounds[2]]]}
 function setStation(code){
  if(typeof code!=='string'||!/^[A-Z][A-Z0-9]{7,13}$/.test(code)||code===selectedCode)return;
  selectedCode=code;requestSerial++;lastCheck=0;pause();cancelPrefetch();drawSerial++;
  if(overlay&&map)map.removeLayer(overlay);
  overlay=null;model=null;frameIndex=0;loading=false;
  mapNode.hidden=true;controls.hidden=true;slider.disabled=true;play.disabled=true;
  labels();if(mapVisible())load();
 }
 document.addEventListener('argens-station-selected',e=>setStation(e.detail?.code));
 document.addEventListener('argens-home-station-restored',e=>setStation(e.detail?.code));
 let playback=false,playTimer=null,drawSerial=0,preloadRun=0;
 const cache=new Map(),queued=[],pending=new Map();
 let working=0,sliderTimer=null;
 const imageURL=i=>API+'/frame?time='+encodeURIComponent(model.frames[i])+'&run='+
  encodeURIComponent(model.referenceTime)+'&station='+encodeURIComponent(model.station.code);
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
  const until=model&&model.frames.length?time(model.frames[model.frames.length-1]):null;
  text('piafForecastTitle',until?lang('Prévision de pluie jusqu’à ','Rain forecast until ','Regenprognose bis ')+until:
    lang('Prévision de pluie','Rain forecast','Regenprognose'));
  text('piafForecastDisclaimer',lang(
   'Prévision Météo-France PIAF, par pas de 5 min. Ni radar mesuré, ni prévision de crue. Sans effet sur les alertes.',
   'Météo-France PIAF forecast in 5-minute steps. Not measured radar or a flood forecast. Does not affect alerts.',
   'Météo-France PIAF-Prognose in 5-Minuten-Schritten. Kein gemessener Regen und keine Hochwasserprognose. Warnungen unverändert.'));
  text('piafLegendTitle',lang('Intensité relative de la pluie prévue','Relative forecast rain intensity','Relative Intensität des vorhergesagten Regens'));
  const names=[
   lang('Très faible','Very light','Sehr leicht'),
   lang('Faible','Light','Leicht'),
   lang('Modérée','Moderate','Mittel'),
   lang('Soutenue','Steady','Kräftig'),
   lang('Forte','Heavy','Stark'),
   lang('Très forte','Very heavy','Sehr stark')
  ];
  for(let i=0;i<names.length;i++)text('piafBand'+i,names[i]);
  text('piafLegendNote',lang(
   'Couleurs choisies pour cette carte : échelle relative, sans seuils précis en mm/h. Les alertes restent indépendantes.',
   'Custom map colours: relative intensity only, not precise mm/h thresholds. Flood alerts remain independent.',
   'Eigene Kartenfarben: relative Regenstärke, keine exakten mm/h-Grenzen. Die Hochwasserwarnungen bleiben unabhängig.'));
  slider.setAttribute('aria-label',lang('Heure prévue','Forecast time','Vorhersagezeit'));
  play.setAttribute('aria-label',lang('Lancer ou arrêter l’animation','Play or pause animation','Animation starten oder pausieren'));
  mapNode.setAttribute('aria-label',lang('Carte de pluie prévue','Forecast rain map','Regenprognose-Karte'));

  if(model){
   text('piafFrameTime',time(model.frames[frameIndex]));
   text('piafRunTime',lang('Modèle actualisé : ','Model run: ','Modelllauf: ')+time(model.referenceTime)+' · Météo-France');
   text('piafForecastStatus','');id('piafForecastStatus').hidden=true;
  }
 }
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
   // CORS is needed for an untainted canvas; our Cloudflare Worker grants
   // the app's approved origins. If decoding fails, do not show raw purple PNG.
   img.crossOrigin='anonymous';
   let done=false;
   const complete=async(ok)=>{
    if(done)return;done=true;
    if(ok&&typeof img.decode==='function'){try{await img.decode()}catch{ok=false}}
    if(job.generation===preloadRun&&ok){
     try{
      if(!palette)throw Error('PIAF palette unavailable');
      const coloured=palette.recolorImage(img);
      if(!coloured.startsWith('data:image/png;base64,'))throw Error('Invalid recoloured image');
      cache.set(job.index,coloured);
      // Bound data URL memory for long-running iPhone sessions.
      if(cache.size>14){
       for(const old of [...cache.keys()])if(old<frameIndex-2)cache.delete(old);
       while(cache.size>14)cache.delete(cache.keys().next().value);
      }
     }catch(error){console.warn('PIAF color rendering unavailable',String(error?.message||''));ok=false}
    }
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
   const layer=window.L.imageOverlay(cache.get(desired),mapBounds(),{opacity:0,interactive:false});
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
     // The selected time is already next to the slider. No duplicate subtitle.
     text('piafForecastStatus','');id('piafForecastStatus').hidden=true;
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

 });
 document.addEventListener('visibilitychange',()=>{if(document.hidden)pause()});
 async function load(){
  if(!mapVisible()||loading)return;
  if(!palette){
   id('piafForecastStatus').hidden=false;
   text('piafForecastStatus',lang('La palette des couleurs ne peut pas être chargée.',
    'The custom colour palette could not be loaded.',
    'Die eigene Farbskala konnte nicht geladen werden.'));
   return;
  }
  if(model&&model.station?.code===selectedCode&&Date.now()-lastCheck<110000){map?.invalidateSize();return}
  loading=true;pause();const request=++requestSerial,requestedCode=selectedCode;
  id('piafForecastStatus').hidden=false;
  text('piafForecastStatus',lang('Chargement de la prévision PIAF…','Loading PIAF forecast…','PIAF-Regenprognose wird geladen…'));
  try{
   const response=await fetch(API+'/metadata?station='+encodeURIComponent(requestedCode),
    {cache:'no-store',signal:AbortSignal.timeout(18000)});
   if(!response.ok)throw Error('No official PIAF forecast');
   const d=await response.json(),frames=d.frames;
   if(d.available!==true||d.source!=='Météo-France PIAF'||d.kind!=='forecast_5min'||
      !Array.isArray(frames)||frames.length<1||frames.length>37||
      !d.station||d.station.code!==requestedCode||
      !Number.isFinite(d.station.lat)||!Number.isFinite(d.station.lon)||
      !Array.isArray(d.bounds)||d.bounds.length!==4||d.bounds.some(v=>!Number.isFinite(v))||
      d.bounds[0]< -5.9||d.bounds[2]>10.2||d.bounds[1]<41||d.bounds[3]>51.7||
      d.bounds[2]-d.bounds[0]>.001+2.0||d.bounds[3]-d.bounds[1]>.001+1.28||
      d.station.lat<41.2||d.station.lat>51.4||d.station.lon< -5.3||d.station.lon>9.8||
      !Number.isFinite(Date.parse(d.referenceTime))||Date.now()-Date.parse(d.referenceTime)>75*60000||
      !frames.every((t,i)=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(t)&&
       Number.isFinite(Date.parse(t))&&Date.parse(t)>Date.now()-4*60000&&
       Date.parse(t)<Date.now()+181*60000&&(i===0||Date.parse(t)>Date.parse(frames[i-1]))))
    throw Error('Incomplete or outdated PIAF metadata');
   const L=await window.loadMapLibrary();
   if(!mapVisible()||request!==requestSerial||requestedCode!==selectedCode)return;
   mapNode.hidden=false;controls.hidden=false;
   if(!map){
    map=L.map(mapNode,{scrollWheelZoom:false,zoomControl:true});
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
     maxZoom:14,attribution:'© OpenStreetMap contributors'}).addTo(map);
   }
   if(stationPin)map.removeLayer(stationPin);
   stationPin=L.circleMarker([d.station.lat,d.station.lon],{
    radius:5,color:'#143c5d',weight:2,fillColor:'#fff',fillOpacity:1
   }).bindTooltip(d.station.name||d.station.code).addTo(map);
   map.fitBounds([[d.bounds[1],d.bounds[0]],[d.bounds[3],d.bounds[2]]],{padding:[6,6],animate:false});
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
   labels();id('piafForecastStatus').hidden=false;
   text('piafForecastStatus',lang('Prévision PIAF momentanément indisponible.',
    'PIAF forecast temporarily unavailable.','PIAF-Regenprognose derzeit nicht verfügbar.'));
   status('');
  }finally{loading=false}
 }
 window.loadPiafForecastMap=load;
 setInterval(()=>{if(!document.hidden&&mapVisible())load()},120000);
})();
