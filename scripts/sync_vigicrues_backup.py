#!/usr/bin/env python3
"""Fetch official Vigicrues readings, then send signed GitHub Actions OIDC snapshot.
No external credentials or stored secrets; live readings only, one fixed station.
"""
import datetime as dt
import json
import math
import os
import urllib.parse
import urllib.request

STATION = "Y531201001"
SOURCE = "https://www.vigicrues.gouv.fr/services/observations.json?CdStationHydro=" + STATION
TARGET = "https://argens-alerte-push.p-hammerschmidt.workers.dev/api/vigicrues-ingest"
AUDIENCE = "riviere-alerte-vigicrues-sync"
NOW = dt.datetime.now(dt.timezone.utc)

def get_json(url, headers, timeout=25):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError("Unexpected HTTP status " + str(response.status))
        return json.load(response)

print("Retrieving Vigicrues observations for", STATION, flush=True)
data = get_json(SOURCE, {"Accept": "application/json"})
series = data.get("Serie")
if isinstance(series, list):
    series = next((s for s in series if s.get("CdStationHydro") == STATION), None)
if not isinstance(series, dict) or series.get("CdStationHydro") != STATION or series.get("GrdSerie") != "H":
    raise RuntimeError("Wrong station or measurement series")
readings = []
seen = set()
for observation in series.get("ObssHydro", []):
    milliseconds, metres = observation.get("DtObsHydro"), observation.get("ResObsHydro")
    if isinstance(milliseconds, bool) or not isinstance(milliseconds, int) or not isinstance(metres, (float, int)) or isinstance(metres, bool):
        continue
    if not math.isfinite(metres):
        continue
    mm = round(metres * 1000)
    if not -5000 <= mm <= 30000 or milliseconds in seen:
        continue
    seen.add(milliseconds)
    readings.append([milliseconds, mm])
readings.sort(reverse=True)
readings = readings[:700]
if len(readings) < 2:
    raise RuntimeError("Insufficient valid observations")
latest = readings[0][0] / 1000
age = NOW.timestamp() - latest
if age < -15 * 60 or age > 3 * 3600:
    raise RuntimeError(f"Vigicrues readings stale/future ({age / 60:.1f} minutes)")
snapshot = {
    "station": STATION,
    "collectedAt": int(NOW.timestamp() * 1000),
    "readings": readings,
}
print(f"Verified {len(readings)} readings; newest {readings[0][1] / 1000:.2f} m, age {age / 60:.1f} min", flush=True)

request_url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
request_token = os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]
separator = "&" if "?" in request_url else "?"
identity = get_json(
    request_url + separator + urllib.parse.urlencode({"audience": AUDIENCE}),
    {"Authorization": "Bearer " + request_token, "Accept": "application/json"},
    timeout=15,
)
jwt = identity.get("value")
if not isinstance(jwt, str) or not jwt:
    raise RuntimeError("GitHub OIDC identity token unavailable")
body = json.dumps(snapshot, separators=(",", ":")).encode("utf-8")
request = urllib.request.Request(
    TARGET,
    data=body,
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + jwt},
    method="POST",
)
try:
    with urllib.request.urlopen(request, timeout=30) as response:
        status = response.status
        reply = json.load(response)
except urllib.error.HTTPError as error:
    reason = error.read(1024).decode("utf-8", errors="replace")
    raise RuntimeError(f"Cloudflare ingestion HTTP {error.code}: {reason}") from None
if status != 200 or reply.get("ok") is not True or reply.get("station") != STATION:
    raise RuntimeError("Cloudflare did not confirm backup receipt")
print("Cloudflare confirmed backup:", json.dumps(reply, ensure_ascii=False), flush=True)
