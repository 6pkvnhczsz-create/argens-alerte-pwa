/*
 * Rivière Alerte · independent visual palette for forecast WMS PNGs.
 * Original Météo-France PNG values are never reinterpreted as numbers:
 * hues are recoded in the provider's existing visual order only.
 * THIS IS QUALITATIVE; use numerical WCS data before promising mm/h bands.
 */
(function(root){
 'use strict';
 const COLORS=Object.freeze([
  '#bae9ff', // very light: original violet
  '#50b8f0', // light: original blue
  '#1555a5', // moderate: original cyan
  '#f5d547', // heavier: original green
  '#f28b2f', // strong: original yellow
  '#d92f45'  // very strong: original orange / red
 ]);
 const rgb=COLORS.map(hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)));
 function sourceBand(r,g,b,a=255){
  // Transparent/no data and unsaturated greys stay unchanged. In particular,
  // an opaque white pixel cannot safely be called "heavy rainfall".
  if(a<10)return -1;
  const max=Math.max(r,g,b),min=Math.min(r,g,b),diff=max-min;
  if(diff<25||max<35)return -1;
  let h;
  if(max===r)h=((g-b)/diff)%6;
  else if(max===g)h=(b-r)/diff+2;
  else h=(r-g)/diff+4;
  h=((h*60)%360+360)%360;
  // Radar Synergie shading progresses from violet through blue/cyan, green,
  // yellow and orange/red as rain intensifies. These bins retain the *order*
  // of hues, not unverified rainfall-intensity thresholds.
  if(h>=275)return 0;
  if(h>=225)return 1;
  if(h>=175)return 2;
  if(h>=75)return 3;
  if(h>=30)return 4;
  return 5;
 }
 function recolorPixels(data){
  let changed=0,unknown=0;
  for(let i=0;i<data.length;i+=4){
   const a=data[i+3];if(a<10)continue;
   const index=sourceBand(data[i],data[i+1],data[i+2],a);
   if(index<0){unknown++;continue}
   const color=rgb[index];data[i]=color[0];data[i+1]=color[1];data[i+2]=color[2];changed++;
  }
  return {changed,unknown};
 }
 function recolorImage(image,doc=document){
  if(!image)throw Error('Missing PIAF image');
  const width=image.naturalWidth||image.width,height=image.naturalHeight||image.height;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>2048||height>2048)
   throw Error('Invalid PIAF image dimensions');
  const canvas=doc.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  if(!ctx)throw Error('Browser cannot recolor forecast');
  ctx.drawImage(image,0,0,width,height);
  const pixels=ctx.getImageData(0,0,width,height);
  recolorPixels(pixels.data);
  ctx.putImageData(pixels,0,0);
  return canvas.toDataURL('image/png');
 }
 root.PiafPalette=Object.freeze({colors:COLORS,sourceBand,recolorPixels,recolorImage});
})(typeof window!=='undefined'?window:globalThis);
