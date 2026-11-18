#!/usr/bin/env python3
"""Back up all active Rivière Alerte user stations over signed GitHub Actions OIDC.
Never invent readings: unsupported, stale, or unreachable stations remain unprotected.
GitHub selects only active station codes supplied by the trusted Cloudflare D1 database.
"""
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
import datetime as dt
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

API_ROOT = "https://argens-alerte-push.p-hammerschmidt.workers.dev"
STATION_URL = API_ROOT + "/api/vigicrues-stations"
SYNC_URL = API_ROOT + "/api/vigicrues-ingest"
UNAVAILABLE_URL = API_ROOT + "/api/vigicrues-unavailable"
AUDIENCE = "riviere-alerte-vigicrues-sync"
APP_USER_AGENT = "RiviereAlerteBackup/1.0 (+https://riviere-alerte.fr)"
STATION_PATTERN = re.compile(r"^[A-Z][0-9]{8,12}$")
MAX_STATIONS_PER_RUN = 200  # Explicit error rather than silently skipping users.
MAX_REQUEST_WORKERS = 8
VALID_HISTORY_SECONDS = 2 * 24 * 3600  # Enough for rate calculations and recent chart history.
# An upstream timeout must not turn a single delayed response into an Actions failure.
# After bounded retries the job still fails, so persistent backup outages remain visible.
VIGICRUES_MAX_ATTEMPTS = 3
VIGICRUES_RETRY_PAUSES_SECONDS = (2, 5)
VIGICRUES_TRANSIENT_HTTP = {408, 429, 500, 502, 503, 504, 520, 522, 524}


class UnusableSeries(Exception):
    """Official API has no usable current height series for the selected station."""
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def http_json(url, headers=None, data=None, timeout=20, method=None):
    headers = {"Accept": "application/json", "User-Agent": APP_USER_AGENT, **(headers or {})}
    request = urllib.request.Request(url, headers=headers, data=data, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError("Unexpected HTTP " + str(response.status))
        return json.load(response)


def github_identity():
    request_url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
    request_token = os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]
    separator = "&" if "?" in request_url else "?"
    identity = http_json(
        request_url + separator + urllib.parse.urlencode({"audience": AUDIENCE}),
        {"Authorization": "Bearer " + request_token},
        timeout=15,
    )
    jwt = identity.get("value")
    if not isinstance(jwt, str) or not jwt:
        raise RuntimeError("GitHub OIDC identity token unavailable")
    # Only public repository/workflow claims are printed; never log the token.
    claims = json.loads(base64.urlsafe_b64decode(jwt.split(".")[1] + "==="))
    print("OIDC source:", claims.get("repository"), claims.get("workflow_ref"),
          claims.get("ref"), flush=True)
    return jwt


def signed_json(url, token, body=None):
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    headers = {"Authorization": "Bearer " + token}
    if data is not None:
        headers["Content-Type"] = "application/json"
    return http_json(url, headers, data=data, method="POST" if data is not None else "GET")


def active_station_codes(token):
    response = signed_json(STATION_URL, token)
    if response.get("ok") is not True or not isinstance(response.get("stations"), list):
        raise RuntimeError("Cloudflare active station discovery failed")
    codes = response["stations"]
    if (len(codes) > MAX_STATIONS_PER_RUN or
        any(not isinstance(c, str) or not STATION_PATTERN.fullmatch(c) for c in codes) or
        len(codes) != len(set(codes))):
        raise RuntimeError("Unexpected active station list; no user stations were silently skipped")
    print(f"Active station count: {response.get('activeCount')}, "
          f"ready for retry: {len(codes)}, "
          f"temporarily deferred: {len(response.get('deferred', []))}", flush=True)
    return codes


def fetch_vigicrues_with_retries(url, code):
    """Retry only transient official-Vigicrues transport failures; never fake data."""
    for attempt in range(1, VIGICRUES_MAX_ATTEMPTS + 1):
        try:
            return http_json(url, timeout=16)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            # HTTPError extends URLError, but 403/404 and other permanent HTTP
            # responses must be handled by the station-specific unavailable logic.
            if isinstance(error, urllib.error.HTTPError):
                transient = error.code in VIGICRUES_TRANSIENT_HTTP
                reason = "HTTP " + str(error.code)
            else:
                transient = True
                reason = type(error).__name__
            if not transient or attempt >= VIGICRUES_MAX_ATTEMPTS:
                raise
            delay = VIGICRUES_RETRY_PAUSES_SECONDS[attempt - 1]
            print(f"BACKUP RETRY {code}: {reason}, attempt {attempt + 1}/"
                  f"{VIGICRUES_MAX_ATTEMPTS} after {delay}s", flush=True)
            time.sleep(delay)


def load_vigicrues_station(code, now):
    if not STATION_PATTERN.fullmatch(code):
        raise ValueError("Invalid station code")
    url = ("https://www.vigicrues.gouv.fr/services/observations.json?"
           + urllib.parse.urlencode({"CdStationHydro": code}))
    try:
        payload = fetch_vigicrues_with_retries(url, code)
    except urllib.error.HTTPError as error:
        if error.code == 403:
            raise UnusableSeries("access_denied") from None
        if error.code == 404:
            raise UnusableSeries("not_found") from None
        raise
    series = payload.get("Serie")
    if isinstance(series, list):
        series = next((s for s in series if isinstance(s, dict) and s.get("CdStationHydro") == code), None)
    if not isinstance(series, dict) or series.get("CdStationHydro") != code or series.get("GrdSerie") != "H":
        raise UnusableSeries("invalid_series")
    readings = []
    seen = set()
    min_ms = int(now.timestamp() * 1000) - VALID_HISTORY_SECONDS * 1000
    max_ms = int(now.timestamp() * 1000) + 15 * 60 * 1000
    for point in series.get("ObssHydro") or []:
        if not isinstance(point, dict):
            continue
        timestamp, metres = point.get("DtObsHydro"), point.get("ResObsHydro")
        if (type(timestamp) is not int or type(metres) not in (float, int)
            or not math.isfinite(metres) or timestamp in seen
            or not min_ms <= timestamp <= max_ms):
            continue
        mm = round(metres * 1000)
        if not -5000 <= mm <= 30000:
            continue
        seen.add(timestamp)
        readings.append([timestamp, mm])
    readings.sort(reverse=True)
    readings = readings[:700]
    if len(readings) < 2:
        raise UnusableSeries("no_data")
    age = now.timestamp() - readings[0][0] / 1000
    if not -15 * 60 <= age <= 3 * 3600:
        raise UnusableSeries("stale")
    return {"station": code, "collectedAt": int(now.timestamp() * 1000), "readings": readings}


def handle_station(code, token):
    now = dt.datetime.now(dt.timezone.utc)
    try:
        snapshot = load_vigicrues_station(code, now)
    except UnusableSeries as error:
        # This does not mark the station healthy; it schedules a later retry.
        response = signed_json(UNAVAILABLE_URL, token, {"station": code, "reason": error.reason})
        if response.get("ok") is not True:
            raise RuntimeError("Cloudflare did not accept unavailable report")
        return {"station": code, "state": "unavailable", "reason": error.reason}
    reply = signed_json(SYNC_URL, token, snapshot)
    if reply.get("ok") is not True or reply.get("station") != code:
        raise RuntimeError("Cloudflare did not confirm stored snapshot")
    return {"station": code, "state": "stored",
            "readings": reply.get("readings"), "observedAt": reply.get("observedAt")}


def main():
    jwt = github_identity()
    stations = active_station_codes(jwt)
    if not stations:
        print("No stations need fresh attempts. Previously stored snapshots remain subject to expiry.", flush=True)
        return
    successes = 0
    unavailable = 0
    failures = []
    with ThreadPoolExecutor(max_workers=min(MAX_REQUEST_WORKERS, len(stations))) as executor:
        tasks = {executor.submit(handle_station, code, jwt): code for code in stations}
        for done in as_completed(tasks):
            code = tasks[done]
            try:
                outcome = done.result()
                if outcome["state"] == "stored":
                    successes += 1
                    print(f"BACKUP OK {code}: {outcome['readings']} values, last {outcome['observedAt']}", flush=True)
                else:
                    unavailable += 1
                    print(f"BACKUP UNSUPPORTED {code}: {outcome['reason']} (deferred)", flush=True)
            except Exception as error:
                failures.append(code)
                print(f"BACKUP ERROR {code}: {type(error).__name__}: {str(error)[:250]}", flush=True)
    print(f"Completed: {successes} stored, {unavailable} without usable Vigicrues data, "
          f"{len(failures)} transient errors", flush=True)
    if failures:
        # Report actual connectivity/storage problems to GitHub, but do not
        # discard valid backups already ingested for other stations.
        raise RuntimeError("Failed to refresh " + str(len(failures)) + " station(s): " + ", ".join(failures[:20]))


if __name__ == "__main__":
    main()
