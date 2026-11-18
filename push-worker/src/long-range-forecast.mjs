// Informational 10-day outlook for the selected French hydrometric station.
// The short-range 6/24h forecast continues to use Météo-France AROME/ARPEGE.
// Beyond its horizon, a separate Open-Meteo best-match model is used and
// attributed. NEVER use this outlook to create, suppress or modify flood alerts.
export const LONG_RANGE_DAYS=10;
const DAY_MS=24*3600000;
const OPEN_METEO_LONG_RANGE='https://api.open-meteo.com/v1/forecast';
const DAILY_FIELDS=[
 'weather_code','temperature_2m_max','temperature_2m_min',
 'precipitation_sum','precipitation_probability_max'
];
const validCoordinate=(lat,lon)=>Number.isFinite(lat)&&Number.isFinite(lon)
 &&lat>=41&&lat<=52&&lon>=-6&&lon<=11;
const validDate=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\d$/.test(s)
 &&Number.isFinite(Date.parse(s+'T12:00:00Z'))
 &&new Date(Date.parse(s+'T12:00:00Z')).toISOString().startsWith(s);

export function parseLongRangeForecast(payload,now=Date.now()){
 const d=payload?.daily;
 const keys=['time',...DAILY_FIELDS];
 if(!d||keys.some(k=>!Array.isArray(d[k])||d[k].length!==LONG_RANGE_DAYS))
  throw Error('Incomplete 10-day daily forecast');
 if(payload?.timezone&&payload.timezone!=='Europe/Paris')
  throw Error('Forecast is not in the expected local timezone');
 const days=[];
 for(let i=0;i<LONG_RANGE_DAYS;i++){
  const date=d.time[i];
  if(!validDate(date))throw Error('Invalid forecast date');
  const dayNo=Date.parse(date+'T12:00:00Z');
  if(i===0&&Math.abs(dayNo-now)>60*3600000)
   throw Error('Outdated or premature forecast');
  if(i>0&&dayNo-Date.parse(days[i-1].date+'T12:00:00Z')!==DAY_MS)
   throw Error('Nonconsecutive dates in 10-day forecast');
  const max=d.temperature_2m_max[i],min=d.temperature_2m_min[i],mm=d.precipitation_sum[i],
   p=d.precipitation_probability_max[i],code=d.weather_code[i];
  if(!Number.isFinite(max)||!Number.isFinite(min)||max< -65||max>60||min< -75||min>55||min>max
   ||!Number.isFinite(mm)||mm<0||mm>500)
   throw Error('Missing or implausible daily weather values');
  if(p!==null&&(!Number.isFinite(p)||p<0||p>100))
   throw Error('Invalid precipitation probability');
  if(code!==null&&(!Number.isInteger(code)||code<0||code>99))
   throw Error('Invalid weather condition');
  days.push({
   date,
   temp_max_c:Math.round(max*10)/10,temp_min_c:Math.round(min*10)/10,
   precipitation_mm:Math.round(mm*10)/10,
   precipitation_probability_pct:p===null?null:Math.round(p),
   weather_code:code===null?null:code,
   reliability:i>=7?'low':i>=4?'decreasing':'shorter_range'
  });
 }
 return {status:'forecast',model:'open_meteo_best_match',days,
  source:'Open-Meteo best-match long-range forecast, not Météo-France AROME/ARPEGE',
  informationalOnly:true,notForAlerts:true};
}

export async function fetchLongRangeForecast(station,{now=Date.now(),fetchImpl=fetch}={}){
 const lat=Number(station?.lat),lon=Number(station?.lon);
 if(!validCoordinate(lat,lon))throw Error('Invalid French station coordinates');
 const params=new URLSearchParams({
  latitude:String(lat),longitude:String(lon),
  daily:DAILY_FIELDS.join(','),forecast_days:String(LONG_RANGE_DAYS),
  timezone:'Europe/Paris'
 });
 const response=await fetchImpl(OPEN_METEO_LONG_RANGE+'?'+params.toString(),{
  headers:{Accept:'application/json'},
  signal:AbortSignal.timeout(12000),cf:{cacheTtl:1800}
 });
 if(!response.ok)throw Error('Long-range forecast API HTTP '+response.status);
 const parsed=parseLongRangeForecast(await response.json(),now);
 return {ok:true,station:{
  code:String(station.code),name:String(station.name||station.code).slice(0,120)
 },checkedAt:new Date(now).toISOString(),...parsed};
}
