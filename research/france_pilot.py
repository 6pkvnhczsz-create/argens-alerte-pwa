#!/usr/bin/env python3
"""Read-only nationwide hydrometric pilot. No alerts or thresholds are published.
Usage: python3 research/france_pilot.py --output research/output
Requires Python 3.10+; standard library only. Network access required.
"""
import argparse
import csv
import json
import math
import pathlib
import urllib.parse
import urllib.request
import urllib.error
import time
import http.client
import socket
from datetime import datetime, timezone

API = "https://hubeau.eaufrance.fr/api/v2/hydrometrie/referentiel/stations"
FIELDS = ["station_code", "station_name", "river", "department", "latitude", "longitude",
          "zip_zich_status", "scenario_height_m", "scenario_source_url",
          "documented_local_impact", "review_status", "review_notes"]
# Important: no default orange/red heights are inferred from station readings.
def fetch_page(page, size=100):
    params = urllib.parse.urlencode({"page": page, "size": size, "format": "json"})
    url = API + "?" + params
    errors = []
    for attempt in range(5):
        request = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; RiviereAlerteResearch/0.2)",
            "Accept": "application/json",
            "Connection": "close"
        })
        try:
            with urllib.request.urlopen(request, timeout=35) as response:
                return json.load(response)
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError,
                ConnectionError, OSError, ValueError) as exc:
            errors.append(f"{type(exc).__name__}: {exc}")
            if isinstance(exc, urllib.error.HTTPError) and exc.code not in (429, 500, 502, 503, 504):
                raise RuntimeError(f"Hub'Eau HTTP {exc.code} at {url}") from exc
            if attempt < 4:
                delay = min(2 ** attempt * 2, 20)
                print(f"Page {page}: API connection failed; retry {attempt + 1}/4 in {delay}s ({type(exc).__name__})", flush=True)
                time.sleep(delay)
    raise RuntimeError(f"Hub'Eau API unreachable after 5 attempts on page {page}: {errors[-1]}")


def value(row, *keys):
    for key in keys:
        if row.get(key) not in (None, ""):
            return row[key]
    return ""

def coords(row):
    try:
        lat = float(value(row, "latitude_station"))
        lon = float(value(row, "longitude_station"))
        return lat, lon
    except (TypeError, ValueError):
        return None

def choose_coverage(rows, count):
    # Spatial stratification across metropolitan France, not a quality ranking.
    candidates = []
    for row in rows:
        pos = coords(row)
        if not pos:
            continue
        lat, lon = pos
        if not (41 <= lat <= 52 and -6 <= lon <= 10):
            continue
        code = str(value(row, "code_station"))
        if not code:
            continue
        candidates.append((code, row, lat, lon))
    candidates.sort(key=lambda x: x[0])
    selected = []
    while candidates and len(selected) < count:
        def nearest_distance(item):
            if not selected:
                # Start near geographic center for deterministic coverage.
                return (item[2] - 46.5) ** 2 + ((item[3] - 2) * .7) ** 2
            return min((item[2] - x[2]) ** 2 + ((item[3] - x[3]) * .7) ** 2 for x in selected)
        best = min(candidates, key=nearest_distance) if not selected else max(candidates, key=nearest_distance)
        selected.append(best)
        candidates.remove(best)
    return selected

REFERENCE = {
    "station_code": "Y531201001",
    "station_name": "L'Argens à Roquebrune-sur-Argens",
    "river": "L'Argens",
    "department": "83",
    "latitude": "",
    "longitude": "",
    "zip_zich_status": "not_checked",
    "scenario_height_m": "",
    "scenario_source_url": "",
    "documented_local_impact": "User-reported March 2024 local observations: ~5.40 m river overtops banks in observed area; ~5.90 m water reaches property; 6.22 m water at front door. User estimates approximately 1-2 hours between 5.40 m and 6.22 m, uncertain recollection; implied average rise ~41-82 cm/h, not a verified gauge time series.",
    "review_status": "local_eyewitness_observations_not_officially_validated",
    "review_notes": "HydroPortail historical flood peaks: 2010-06-16 7.71m; 2019-11-23 7.12m (tolerance 0.10m); 2024-03-10 6.22m. These are NOT first-overflow levels. https://www.hydro.eaufrance.fr/sitehydro/Y5312010/seuils"
}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="research/output")
    parser.add_argument("--count", type=int, default=30)
    parser.add_argument("--max-pages", type=int, default=100)
    args = parser.parse_args()
    if not 1 <= args.count <= 100:
        parser.error("--count must be 1..100")
    output = pathlib.Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    rows = []
    for page in range(1, args.max_pages + 1):
        payload = fetch_page(page)
        batch = payload.get("data", [])
        if not isinstance(batch, list):
            raise RuntimeError("Unexpected Hub'Eau API response")
        rows.extend(batch)
        print(f"Fetched page {page}: {len(batch)} stations (total {len(rows)})", flush=True)
        if not payload.get("next") or not batch:
            break
    if not rows:
        raise RuntimeError("No stations returned; no report generated")
    chosen = choose_coverage(rows, args.count)
    if len(chosen) < args.count:
        raise RuntimeError(f"Only {len(chosen)} eligible stations found")
    records = []
    for code, row, lat, lon in chosen:
        records.append({
            "station_code": code,
            "station_name": value(row, "libelle_station"),
            "river": value(row, "libelle_cours_eau", "libelle_site"),
            "department": value(row, "code_departement"),
            "latitude": lat,
            "longitude": lon,
            "zip_zich_status": "not_checked",
            "scenario_height_m": "",
            "scenario_source_url": "",
            "documented_local_impact": "",
            "review_status": "needs_source_review",
            "review_notes": "ZIP/ZICH scenario and local impact must be checked against official sources; no automatic threshold."
        })
    # Keep the geographically selected 30 unchanged; append a fixed, source-auditable reference.
    if not any(r["station_code"] == REFERENCE["station_code"] for r in records):
        matching = next((r for r in rows if r.get("code_station") == REFERENCE["station_code"]), None)
        reference = dict(REFERENCE)
        if matching:
            reference["station_name"] = value(matching, "libelle_station") or reference["station_name"]
            reference["river"] = value(matching, "libelle_cours_eau", "libelle_site") or reference["river"]
            reference["department"] = value(matching, "code_departement") or reference["department"]
            pos = coords(matching)
            if pos:
                reference["latitude"], reference["longitude"] = pos
        records.append(reference)
    with (output / "stations.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(records)
    # Source-review queue: no inferred flood thresholds and no fabricated ZIP/ZICH coverage.
    review_fields = [
        "station_code", "station_name", "department",
        "hydroportail_station_url", "vigicrues_portal_url",
        "zip_zich_source_url", "zip_zich_document_title",
        "scenario_gauge_station_code", "scenario_gauge_datum",
        "scenario_height_m", "scenario_date_or_version",
        "impact_source_url", "impact_description",
        "source_checked_at_utc", "reviewer",
        "evidence_status", "threshold_usable", "review_notes"
    ]
    with (output / "source_review.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=review_fields)
        writer.writeheader()
        for record in records:
            code = record["station_code"]
            site_code = code[:-2] if len(code) > 2 else code
            writer.writerow({
                "station_code": code,
                "station_name": record["station_name"],
                "department": record["department"],
                "hydroportail_station_url": "https://www.hydro.eaufrance.fr/sitehydro/" + urllib.parse.quote(site_code, safe=""),
                "vigicrues_portal_url": "https://www.vigicrues.gouv.fr/",
                "evidence_status": "needs_official_source_check",
                "threshold_usable": "no",
                "review_notes": "Station-specific ZIP/ZICH source, matching gauge/datum, scenario height and local impacts are NOT verified."
            })
    summary = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "source": API,
        "stations_retrieved": len(rows),
        "pilot_stations": args.count,
        "reference_stations": int(any(r["station_code"] == REFERENCE["station_code"] for r in records)),
        "total_exported_stations": len(records),
        "selection": "deterministic geographic coverage, metropolitan coordinates",
        "zip_zich_verified": 0,
        "validated_flood_thresholds": 0,
        "source_review_rows": len(records),
        "warning": "No ZIP/ZICH bulk import or local flooding threshold validation has been performed. Do not use these rows for alerts."
    }
    (output / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    main()
