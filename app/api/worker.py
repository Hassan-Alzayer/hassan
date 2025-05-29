# app/api/worker.py

import os
import ssl
import certifi
import asyncio
import aiohttp
import numpy as np
import onnxruntime as ort
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
from supabase import create_client
from shapely.geometry import shape, Point
from feature_builder import vectorize, FEATS

load_dotenv()

# Build an SSL context once (using certifi’s trusted CAs)
ssl_context = ssl.create_default_context(cafile=certifi.where())

# Supabase client
SUPA = create_client(
    os.environ["SUPABASE_URL"],
    os.environ["SUPABASE_SERVICE_KEY"]
)

# ONNX model session
sess = ort.InferenceSession("fishing_classifier.onnx")
inp  = sess.get_inputs()[0].name
out  = sess.get_outputs()[0].name
THR  = 0.60   # probability threshold

# Cache for EEZ polygon
EEZ = None

async def get_eez_polygon():
    global EEZ
    if EEZ is not None:
        return EEZ

    mrgid  = os.environ["MRGID"]
    wfs_url = "https://geo.vliz.be/geoserver/wfs"
    params = {
        "request":      "GetFeature",
        "service":      "WFS",
        "version":      "1.1.0",
        "typename":     "MarineRegions:eez",
        "outputFormat": "application/json",
        "filter": (
            f"<Filter>"
              f"<PropertyIsEqualTo>"
                f"<PropertyName>mrgid_eez</PropertyName>"
                f"<Literal>{mrgid}</Literal>"
              f"</PropertyIsEqualTo>"
            f"</Filter>"
        ),
    }

    # NOW we’re inside async code—loop is running, so connector() works
    connector = aiohttp.TCPConnector(ssl=ssl_context)
    async with aiohttp.ClientSession(connector=connector) as session:
        async with session.get(wfs_url, params=params) as resp:
            resp.raise_for_status()
            gj = await resp.json()

    EEZ = shape(gj["features"][0]["geometry"])
    return EEZ

async def fetch_events(bbox, since):
    url = "https://api.globalfishingwatch.org/v3/events"
    params = {
        "minLat": bbox[0],
        "maxLat": bbox[1],
        "minLon": bbox[2],
        "maxLon": bbox[3],
        "from":   since.isoformat() + "Z"
    }
    headers = {"Authorization": f"Bearer {os.environ['GFW_TOKEN']}"}

    connector = aiohttp.TCPConnector(ssl=ssl_context)
    async with aiohttp.ClientSession(connector=connector) as session:
        async with session.get(url, params=params, headers=headers) as resp:
            resp.raise_for_status()
            return await resp.json()

async def loop():
    # e.g. BBOX="latMin,latMax,lonMin,lonMax"
    bbox = list(map(float, os.environ["BBOX"].split(",")))
    eez  = await get_eez_polygon()

    while True:
        since = datetime.now(timezone.utc) - timedelta(minutes=15)
        data  = await fetch_events(bbox, since)

        for ev in data.get("data", []):
            pt = Point(ev["lon"], ev["lat"])
            if not eez.contains(pt):
                continue

            # skip licensed vessels
            lic = (
                SUPA
                .table("licences")
                .select("mmsi")
                .eq("mmsi", ev["vessel"]["mmsi"])
                .execute()
                .data
            )
            if lic:
                continue

            vec  = vectorize(ev)
            prob = float(sess.run([out], {inp: vec[np.newaxis, :]})[0][0][0])
            if prob < THR:
                continue

            SUPA.table("iuu_alerts").insert({
                "mmsi": ev["vessel"]["mmsi"],
                "ts":   datetime.utcfromtimestamp(ev["timestamp"]).isoformat(),
                "lat":  ev["lat"],
                "lon":  ev["lon"],
                "prob": prob
            }).execute()

        await asyncio.sleep(600)  # 10 minutes

if __name__ == "__main__":
    asyncio.run(loop())
