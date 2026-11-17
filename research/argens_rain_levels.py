#!/usr/bin/env python3
"""Exploratory HISTORICAL rainfall vs maximum daily Argens gauge height.

Sources (public, open licence):
 - Météo-France via data.gouv.fr: hourly station precipitation (RR1, mm)
 - Hub'Eau: daily maximum instantaneous gauge height HIXnJ (mm)
Read-only. Never feeds alerts. Daily maxima alone cannot establish flood travel
time or within-day rise rates. Explicitly distinguish missing observations from 0.
"""
from __future__ import annotations

import csv
import datetime as dt
import gzip
import io
import json
import math
import statistics
import sys
import urllib.parse
import urllib.request
from collections import defaultdict

METEO = "https://www.data.gouv.fr/api/1/datasets/donnees-climatologiques-de-base-horaires/"
HUB = "https://hubeau.eaufrance.fr/api/v2/hydrometrie/obs_elab"
GAUGE = "Y531201001"
LOCATION = (43.44, 6.63)  # approximate, for weather gauge ranking only
YEARS = [(2010, 2019), (2020, 2029)]
NEAR_NAMES = ("ROQUEBRUNE", "FREJUS", "FREJ", "LE MUY", "LES ARCS",
              "DRAGUIGNAN", "VIDAUBAN", "CARCES", "ENTRECASTEAUX",
              "LE LUC", "MAYONS", "TANNERON")

def fetch(url, timeout=90):
    req = urllib.request.Request(url, headers={
        "User-Agent": "RiviereAlerteHistoricalResearch/0.1 (https://riviere-alerte.fr)",
        "Accept": "application/json, text/csv, */*",
    })
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()

def date_hour(value):
    """UTC weather hour; data from the French mainland archive is in UTC."""
    s = str(value or "").strip().replace("-", "").replace(":", "").replace(" ", "")
    if len(s) >= 10 and s[:10].isdigit():
        try: return dt.date(int(s[:4]), int(s[4:6]), int(s[6:8]))
        except ValueError: pass
    if len(s) == 8 and s.isdigit():
        try: return dt.date(int(s[:4]), int(s[4:6]), int(s[6:8]))
        except ValueError: pass
    return None

def numeric(value):
    try:
        s = str(value or "").strip().replace(",", ".")
        return float(s) if s and s not in ("mq", "NaN", "nan") else None
    except ValueError:
        return None

def load_heights():
    query = urllib.parse.urlencode({
        "code_entite": GAUGE, "grandeur_hydro_elab": "HIXnJ",
        "date_debut_obs_elab": "2010-01-01",
        "date_fin_obs_elab": "2026-11-16", "size": "20000"})
    data = json.loads(fetch(HUB + "?" + query))
    rows = data.get("data") or []
    if not rows:
        print("No historic HIXnJ data in response:", list(data), flush=True)
    print("HYDRO data count", len(rows), "total", data.get("count"),
          "next page", bool(data.get("next")), flush=True)
    out = {}
    for row in rows:
        if row.get("code_station") not in (None, "", GAUGE):
            continue
        day = str(row.get("date_obs_elab", ""))[:10]
        mm = numeric(row.get("resultat_obs_elab"))
        if mm is None or mm < -5000 or mm > 30000: continue
        try: out[dt.date.fromisoformat(day)] = mm / 1000
        except ValueError: continue
    return out

def meteo_resources():
    metadata = json.loads(fetch(METEO))
    resources = metadata.get("resources") or []
    selected = {}
    for start, end in YEARS:
        prefix = "HOR_departement_83_periode_%s-" % start
        matches = [item for item in resources
                   if str(item.get("title", "")).lower().startswith(prefix.lower())]
        if matches:
            selected[start] = sorted(matches, key=lambda x: x.get("last_modified") or "", reverse=True)[0]
        else:
            print("Missing official weather resource with prefix", prefix, flush=True)
            print("Available VAR archives:",
                  [item.get("title") for item in resources
                   if "departement_83" in str(item.get("title", "")).lower()][-18:],
                  flush=True)
    print("METEO records", len(resources), "selected",
          [(y, item.get("title"), item.get("filesize"), item.get("url")) for y, item in selected.items()],
          flush=True)
    return selected

def load_rain(resources):
    # Station -> daily precipitation + count of observed hours.
    stations = {}
    totals = defaultdict(lambda: defaultdict(lambda: [0.0, 0]))
    for year, resource in resources.items():
        url = resource.get("url")
        if not url: continue
        blob = fetch(url, timeout=180)
        if blob[:2] == b"\x1f\x8b": blob = gzip.decompress(blob)
        stream = io.StringIO(blob.decode("utf-8-sig", errors="replace"))
        header = stream.readline()
        separator = ";" if header.count(";") >= header.count(",") else ","
        stream.seek(0)
        reader = csv.DictReader(stream, delimiter=separator)
        names = reader.fieldnames or []
        print("Weather", year, "file bytes", len(blob), "columns", names[:18], flush=True)
        rfield = next((k for k in ("RR1", "RR", "PRECIPITATION") if k in names), None)
        dfield = next((k for k in ("AAAAMMJJHH", "DATE", "AAAAMMJJHHMM") if k in names), None)
        if not rfield or not dfield:
            print("UNRECOGNIZED weather columns: no rain or timestamp; skipping!", flush=True)
            continue
        count = 0
        for row in reader:
            station = (row.get("NUM_POSTE") or "").strip()
            if not station: continue
            day = date_hour(row.get(dfield))
            rr = numeric(row.get(rfield))
            if day is None or rr is None or rr < 0 or rr > 350: continue
            if not (2010 <= day.year <= 2026): continue
            count += 1
            lat, lon = numeric(row.get("LAT")), numeric(row.get("LON"))
            if station not in stations:
                stations[station] = {
                    "name": row.get("NOM_USUEL", "").strip(),
                    "lat": lat, "lon": lon}
            entry = totals[station][day]
            entry[0] += rr
            entry[1] += 1
        print("Weather", year, "valid observed hours", count, "stations",len(stations),flush=True)
    return stations, totals

def station_rank(stations, totals):
    weighted = []
    for code, meta in stations.items():
        name = meta["name"].upper()
        lat, lon = meta["lat"], meta["lon"]
        dist = (math.hypot((lat-LOCATION[0])*111, (lon-LOCATION[1])*80)
                if lat is not None and lon is not None else 999)
        if not any(x in name for x in NEAR_NAMES) and dist > 35:
            continue
        valid_days = sum(n>=18 for _, n in totals[code].values())
        if valid_days < 300: continue
        weighted.append((not any(x in name for x in NEAR_NAMES), dist, -valid_days, code))
    return [code for *_unused,code in sorted(weighted)[:14]]

def rolling_rain(totals, station, date, days):
    rows = [totals[station].get(date-dt.timedelta(days=k))
            for k in range(days)]
    if any(row is None or row[1]<18 for row in rows): return None
    return round(sum(row[0] for row in rows), 1)

def antecedent_rain(totals, station, event_date, days, decay=None):
    """Only COMPLETE days strictly before the reference event date.

    None means missing coverage, never assumed 0. When decay is provided,
    day D-1 has weight 1 and previous days decrease exponentially.
    """
    records = [totals[station].get(event_date-dt.timedelta(days=k))
               for k in range(1,days+1)]
    if any(row is None or row[1]<18 for row in records): return None
    if decay is None:
        return round(sum(row[0] for row in records),1)
    return round(sum(row[0]*decay**k for k,row in enumerate(records)),1)

def auc_rank(pairs):
    """Area under rank curve for historical discrimination, not calibration."""
    positives=sorted(score for score,hit in pairs if hit)
    negatives=sorted(score for score,hit in pairs if not hit)
    if not positives or not negatives: return None
    # Day-level observations are serially dependent; never treat as
    # independent experiments or provide statistical confidence intervals.
    from bisect import bisect_left,bisect_right
    concordant=0.0
    for score in positives:
        below=bisect_left(negatives,score)
        equal=bisect_right(negatives,score)-below
        concordant+=below+0.5*equal
    return round(concordant/(len(positives)*len(negatives)),4)

def compare_antecedent_windows(heights,totals):
    """Retrospective ranking for NEXT calendar-day crest >= 5.40 m.

    Only fully observed past days are inputs (no peak-day leakage).
    The 2019-2024 test period is withheld from choice of cutoffs/model.
    """
    codes=("83051001","83004004","83050007","83148002","83075001")
    rows=[]
    for day,level in sorted(heights.items()):
        if day.year<2010 or day.year>2024: continue
        result={"date":str(day),"level_m":level,"hit":level>=5.4}
        for width in (2,5,10,14,30):
            values=[antecedent_rain(totals,code,day,width)
                    for code in codes]
            values=[x for x in values if x is not None]
            result[str(width)+"d"]=max(values) if len(values)>=3 else None
        rows.append(result)
    # Compare indicators solely on MATCHED calendar days to eliminate
    # spurious differences from coverage.
    paired=[row for row in rows if row["2d"] is not None and row["10d"] is not None]
    for name,subset in (("train_2010_2018",[x for x in paired if int(x["date"][:4])<=2018]),
                        ("heldout_2019_2024",[x for x in paired if int(x["date"][:4])>=2019])):
        print("HOLDOUT",json.dumps({"period":name,"n_days":len(subset),
          "n_days_at_least_5_4m":sum(x["hit"] for x in subset),
          "rank_auc_2d":auc_rank([(x["2d"],x["hit"]) for x in subset]),
          "rank_auc_10d":auc_rank([(x["10d"],x["hit"]) for x in subset]),
          "interpretation":"Discrimination on complete PRIOR calendar days; not a 6h forecast, no fitted probabilities, serially dependent events, not operational."}),flush=True)

def main():
    heights = load_heights()
    print("HEIGHT sample",len(heights),"range",
          str(min(heights)) if heights else "n/a",
          str(max(heights)) if heights else "n/a",
          "highest", [(str(d),round(h,2)) for d,h in sorted(
              heights.items(),key=lambda x:x[1],reverse=True)[:15]],flush=True)
    resources = meteo_resources()
    stations, totals = load_rain(resources)
    selected = station_rank(stations, totals)
    print("RAIN selected stations",[(x,stations[x]) for x in selected],flush=True)
    # Show only measured, complete-day windows. Does not assume a single station
    # represents all 2508 km2 of the Argens basin.
    peaks = sorted((d,h) for d,h in heights.items() if h>=4.5)
    peaks = sorted(peaks, key=lambda x:x[1],reverse=True)[:24]
    for date,level in peaks:
        measured = []
        for station in selected:
            prev = rolling_rain(totals, station, date-dt.timedelta(days=1),1)
            today = rolling_rain(totals, station,date,1)
            two = rolling_rain(totals,station,date,2)
            if today is not None and prev is not None:
                measured.append({"station":station,
                    "name":stations[station]["name"],
                    "today_mm":today,"previous_day_mm":prev,"48h_mm":two})
        measured.sort(key=lambda x:x["48h_mm"] or 0,reverse=True)
        previous = heights.get(date-dt.timedelta(days=1))
        # Test multiple prior-wetness windows (independent of rainfall on
        # flood day). This is exploratory input for future cross-validation.
        antecedents={}
        for days in (3,5,7,10,14,30):
            readings={code:antecedent_rain(totals,code,date,days)
                      for code in selected}
            valid=[(code,value) for code,value in readings.items() if value is not None]
            antecedents[str(days)+"d"]={
                "stations_reporting":len(valid),
                "highest_mm":max((v for _,v in valid),default=None),
                "median_mm":round(statistics.median(v for _,v in valid),1) if valid else None}
        api10={code:antecedent_rain(totals,code,date,10,decay=0.85)
               for code in selected}
        valid_api10=[v for v in api10.values() if v is not None]
        print("EVENT",json.dumps({"date_utc":str(date),"daily_peak_m":round(level,3),
              "previous_day_peak_m":round(previous,3) if previous is not None else None,
              "change_between_daily_maxima_m":round(level-previous,3) if previous is not None else None,
              "rain_sites_reporting":len(measured),
              "top_rain_sites":measured[:5],
              "antecedent_rain_before_flood_day":antecedents,
              "weighted_api10_decay_0_85_max_mm":max(valid_api10,default=None),
              "antecedent_note":"No rainfall from peak day included; site maxima are not catchment averages"},ensure_ascii=False),flush=True)
    # Exploratory conditional frequencies: rain in TWO COMPLETE DAYS preceding
    # the target daily max, avoiding look-ahead bias from rain later that day.
    # A single reporting gauge is never assumed to represent the whole basin.
    basin_codes = ["83051001","83004004","83050007","83148002","83075001"]
    thresholds = (5.4,5.9,6.22)
    rain_bins = ((0,25),(25,50),(50,100),(100,150),(150,250),(250,float("inf")))
    counters = defaultdict(lambda: [0,0,0,0])
    for date,level in heights.items():
        individual = [rolling_rain(totals,c,date-dt.timedelta(days=1),2)
                      for c in basin_codes if c in totals]
        known = [v for v in individual if v is not None]
        if len(known)<3: continue
        rain_max = max(known)
        for lo,hi in rain_bins:
            if lo<=rain_max<hi:
                item=counters[(lo,hi)]
                item[0]+=1
                for i,t in enumerate(thresholds):
                    item[1+i]+=level>=t
                break
    for lo,hi in rain_bins:
        counts=counters[(lo,hi)]
        print("CONDITIONAL",json.dumps({
            "max_48h_rain_mm_prior_to_day":str(lo)+"-"+(str(hi) if math.isfinite(hi) else "plus"),
            "complete_days":counts[0],
            "frequency_daily_peak_at_least_5_4m":round(counts[1]/counts[0],4) if counts[0] else None,
            "frequency_daily_peak_at_least_5_9m":round(counts[2]/counts[0],4) if counts[0] else None,
            "frequency_daily_peak_at_least_6_22m":round(counts[3]/counts[0],4) if counts[0] else None,
            "counts":counts,
            "definition":"RETROSPECTIVE ONLY: maximum of five selected rainfall gauges, complete previous two days; not a forecast"
        },ensure_ascii=False),flush=True)
    compare_antecedent_windows(heights,totals)
    # Explicit gaps and time resolution prevent unvalidated model output.
    result={"station":GAUGE,"height_days":len(heights),
            "weather_stations_considered":len(selected),
            "events_at_least_4_5m":len(peaks),
            "conclusion":"DESCRIPTIVE ONLY: No predictive coefficients calibrated.",
            "limitations":["Daily maxima cannot measure hourly crest delay or hourly rise.",
                           "Nearby weather gauges are not watershed-average rainfall.",
                           "Only complete rain-observation days are included.",
                           "No alert thresholds or production forecasts are modified."]}
    print("SUMMARY",json.dumps(result,ensure_ascii=False),flush=True)
    if not heights or not selected:
        sys.exit("Insufficient verified datasets; report withheld to avoid misleading conclusions")

if __name__ == "__main__":
    main()
