#!/usr/bin/env python3
"""Process the official 500 m Météo-France 5-minute radar mosaic for Argens.

GitHub OIDC -> private Cloudflare download -> HDF5 -> georeferenced 720x500
RGBA PNG -> signed Cloudflare D1 ingestion. Never emits a flood alert.
Météo-France's original-dgmr example documents /dataset1/data1/data,
65535 = nodata, 1/100 mm for 5-min accumulation, stereographic lat_0=45.
"""
from __future__ import annotations

import base64
import datetime as dt
import io
import json
import math
import os
import urllib.error
import urllib.request

import h5py
import numpy as np
from PIL import Image
from pyproj import CRS, Transformer

API = "https://argens-alerte-push.p-hammerschmidt.workers.dev"
AUDIENCE = "riviere-alerte-radar-map"
BOUNDS = (5.85, 43.18, 6.91, 43.85)  # west, south, east, north
WIDTH, HEIGHT = 720, 500
MAX_HDF_BYTES = 40_000_000
UTC = dt.timezone.utc
# Geographic corners from Météo-France official original-dgmr/plot.py
# Used only for the standard 3472x3472 national mosaic when /where lacks georef.
MF_LL = (-6.715173, 38.144933)
MF_UR = (17.564203, 52.548138)
FALLBACK_PROJ = "+proj=stere +lat_0=45 +lon_0=0 +datum=WGS84 +units=m +no_defs"


def utc_now():
    return dt.datetime.now(UTC)


def api_request(path, *, method="GET", data=None, token=None):
    headers = {
        "User-Agent": "RiviereAlerteRadarSync/1.0 (+https://riviere-alerte.fr)",
        "Accept": "application/json" if data is not None else "*/*",
    }
    if token:
        headers["Authorization"] = "Bearer " + token
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=55) as res:
        payload = res.read(MAX_HDF_BYTES + 1 if path.endswith("/raw") else 1_200_000)
        if len(payload) > (MAX_HDF_BYTES if path.endswith("/raw") else 1_100_000):
            raise RuntimeError("HTTP payload is too large")
        return payload


def identity_token():
    url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
    sep = "&" if "?" in url else "?"
    req = urllib.request.Request(
        url + sep + "audience=" + AUDIENCE,
        headers={"Authorization": "Bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]},
    )
    with urllib.request.urlopen(req, timeout=12) as res:
        token = json.load(res)["value"]
    if len(token) > 16_000:
        raise RuntimeError("Oversized identity token")
    return token


def attr(group, name, default=None):
    if group is None:
        return default
    val = group.attrs.get(name, default)
    if isinstance(val, bytes):
        return val.decode("utf-8", "replace")
    if isinstance(val, np.ndarray):
        if val.size == 1:
            return val.flat[0].item()
    return val


def geographic_grid(h5, shape):
    """Prove a plausible georeferenced stereographic mapping; never guess silently."""
    where = h5.get("where")
    projdef = attr(where, "projdef")
    known = all(attr(where, key) is not None for key in ("LL_lon", "LL_lat", "UR_lon", "UR_lat"))
    if known:
        ll = (float(attr(where, "LL_lon")), float(attr(where, "LL_lat")))
        ur = (float(attr(where, "UR_lon")), float(attr(where, "UR_lat")))
        if not all(math.isfinite(n) for n in (*ll, *ur)):
            raise ValueError("Nonfinite map coordinates")
        source = "odim_where"
    elif shape == (3472, 3472):
        # These corners and projection are published by the author of the H5 data.
        ll, ur, source = MF_LL, MF_UR, "meteo_france_reference"
    else:
        raise ValueError("Missing source georeferencing; refusing an unverified map")
    if not projdef:
        if source != "meteo_france_reference":
            raise ValueError("Missing projection metadata")
        projdef = FALLBACK_PROJ
    crs = CRS.from_user_input(projdef)
    transformer = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    lower_left = transformer.transform(*ll)
    upper_right = transformer.transform(*ur)
    nx, ny = shape[1], shape[0]
    xstep = (upper_right[0] - lower_left[0]) / nx
    ystep = (upper_right[1] - lower_left[1]) / ny
    if not (300 < xstep < 1200 and 300 < ystep < 1200):
        raise ValueError("Implausible georeferenced pixel size")
    # Leaflet image-overlay is interpolated in Web Mercator: generate matching
    # pixel latitude coordinates, NOT a linearly spaced latitude grid.
    west, south, east, north = BOUNDS
    lons = np.linspace(west, east, WIDTH, dtype=np.float64)
    top_merc = np.arcsinh(np.tan(np.radians(north)))
    bottom_merc = np.arcsinh(np.tan(np.radians(south)))
    merc_y = np.linspace(top_merc, bottom_merc, HEIGHT, dtype=np.float64)
    lats = np.degrees(np.arctan(np.sinh(merc_y)))
    lon_grid, lat_grid = np.meshgrid(lons, lats)
    x, y = transformer.transform(lon_grid, lat_grid)
    col = np.floor((x - lower_left[0]) / xstep).astype(np.int32)
    row = np.floor((upper_right[1] - y) / ystep).astype(np.int32)
    inside = (row >= 0) & (row < ny) & (col >= 0) & (col < nx)
    if np.mean(inside) < 0.97:
        raise ValueError("Radar projection does not cover Argens domain")
    return row, col, inside, source


def raw_to_image(h5):
    if "dataset1/data1/data" not in h5:
        raise ValueError("Météo-France HDF5 rainfall dataset not found")
    rain = h5["dataset1/data1/data"]
    if len(rain.shape) != 2 or max(rain.shape) > 4000:
        raise ValueError("Unexpected radar image shape")
    if not np.issubdtype(rain.dtype, np.integer):
        raise ValueError("Unexpected radar rainfall encoding")
    # The official /data/ raw values are hundredths of mm over the last five minutes.
    # Météo-France original-dgmr/data.py uses this identical factor.
    where = h5.get("dataset1/data1/what")
    gain = attr(where, "gain")
    if gain is not None and not (0.009 <= float(gain) <= 0.011):
        raise ValueError("Unexpected radar calibration factor")
    row, col, inside, georef = geographic_grid(h5, rain.shape)
    image_raw = np.full((HEIGHT, WIDTH), 65535, dtype=np.uint16)
    data = rain[()]  # 3472 x 3472, ~24MB; safe in GitHub runner.
    image_raw[inside] = data[row[inside], col[inside]]
    valid = inside & (image_raw != 65535)
    coverage = float(valid.mean() * 100)
    if coverage < 5:
        raise ValueError("Insufficient radar coverage over the target region")
    rate = image_raw.astype(np.float32) * 0.12  # hundredths mm / 5 min -> mm/h
    wet = valid & (rate >= 0.2)
    wet_fraction = float(wet.sum() / valid.sum() * 100)
    rgba = np.zeros((HEIGHT, WIDTH, 4), dtype=np.uint8)
    # Discrete, readable precipitation intensity legend, in mm/h.
    levels = [
        (0.2, (59, 185, 242, 153)),
        (1.0, (13, 111, 203, 172)),
        (3.0, (13, 163, 116, 188)),
        (7.0, (253, 219, 73, 205)),
        (15.0, (249, 149, 35, 225)),
        (30.0, (216, 56, 65, 235)),
        (60.0, (166, 45, 146, 245)),
    ]
    for threshold, color in levels:
        rgba[wet & (rate >= threshold)] = color
    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG", optimize=True)
    png = buf.getvalue()
    if len(png) > 480000:
        raise ValueError("Unexpectedly large radar overlay")
    return png, round(coverage, 2), round(wet_fraction, 2), georef


def observation_timestamp(h5, fallback_iso):
    # Prefer HDF's intrinsic acquisition time when available.
    for group in (h5.get("dataset1/what"), h5.get("what")):
        for date_field, time_field in (("enddate", "endtime"), ("date", "time")):
            date, time = attr(group, date_field), attr(group, time_field)
            if date is None or time is None:
                continue
            try:
                stamp = dt.datetime.strptime(str(date) + str(time).zfill(6), "%Y%m%d%H%M%S").replace(tzinfo=UTC)
                if abs((stamp - utc_now()).total_seconds()) < 2200:
                    return stamp
            except ValueError:
                pass
    # The public, validated radar catalogue is also published by Météo-France.
    stamp = dt.datetime.fromisoformat(fallback_iso.replace("Z", "+00:00"))
    if abs((utc_now() - stamp).total_seconds()) > 2100:
        raise ValueError("Radar catalogue timestamp is stale")
    return stamp


def run():
    metadata = json.loads(api_request("/api/early-signals"))
    official = metadata.get("radar") or {}
    if official.get("status") != "catalogue_only" or not official.get("observedAt"):
        raise RuntimeError("Official radar catalogue has no current time")
    token = identity_token()
    hdf_bytes = api_request("/api/radar-map/raw", token=token)
    if not hdf_bytes.startswith(b"\x89HDF\r\n\x1a\n"):
        raise ValueError("Official radar endpoint did not return HDF5")
    with h5py.File(io.BytesIO(hdf_bytes), "r") as h5:
        observed = observation_timestamp(h5, official["observedAt"])
        png, coverage, wet, georef = raw_to_image(h5)
    print(
        "RADAR parsed HDF5;",
        "observed UTC", observed.isoformat(),
        "georef", georef,
        "coverage percent", coverage,
        "wet grid percent", wet,
        "PNG bytes", len(png),
        flush=True,
    )
    payload = {
        "bounds": list(BOUNDS),
        "observedMs": int(observed.timestamp() * 1000),
        "generatedMs": int(utc_now().timestamp() * 1000),
        "coveragePct": coverage,
        "wetPct": wet,
        "imageB64": base64.b64encode(png).decode("ascii"),
    }
    response = json.loads(api_request("/api/radar-map/ingest", token=identity_token(), method="POST", data=json.dumps(payload).encode("utf-8")))
    if not response.get("ok"):
        raise RuntimeError("Cloudflare rejected radar frame")
    print("RADAR image accepted by Cloudflare:", response.get("stored"), response.get("observedAt"), flush=True)


if __name__ == "__main__":
    run()
