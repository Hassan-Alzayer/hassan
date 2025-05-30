# apps/api/worker.py  –  Poll GFW GET /v3/events ✅

import os, ssl, certifi, asyncio, aiohttp, socket
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
from shapely.geometry import shape, Point
import onnxruntime as ort
from supabase import create_client
from feature_builder import vectorize

load_dotenv()

# ──────────────────────────────────────────────────────────────
# Globals
# ──────────────────────────────────────────────────────────────
ssl_ctx = ssl.create_default_context(cafile=certifi.where())
SUPA    = create_client(
    os.environ["SUPABASE_URL"],
    os.environ["SUPABASE_SERVICE_KEY"]
)

sess = ort.InferenceSession("fishing_classifier.onnx")
inp, out = sess.get_inputs()[0].name, sess.get_outputs()[0].name
THR = 0.60

API_BASE = "https://gateway.api.globalfishingwatch.org"
EEZ = None  # only needed if you still want spatial filtering


# ──────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────
async def get_eez_polygon():
    global EEZ
    if EEZ:
        return EEZ

    url = "https://geo.vliz.be/geoserver/wfs"
    params = {
        "service":      "WFS",
        "request":      "GetFeature",
        "version":      "1.1.0",
        "typename":     "MarineRegions:eez",
        "outputFormat": "application/json",
        "filter": (
            f"<Filter><PropertyIsEqualTo>"
            f"<PropertyName>mrgid_eez</PropertyName>"
            f"<Literal>{os.getenv('MRGID')}</Literal>"
            f"</PropertyIsEqualTo></Filter>"
        )
    }
    async with aiohttp.ClientSession(
        connector=aiohttp.TCPConnector(ssl=ssl_ctx, family=socket.AF_INET)
    ) as s:
        async with s.get(url, params=params) as r:
            r.raise_for_status()
            geo = (await r.json())["features"][0]["geometry"]
            EEZ = shape(geo)
    return EEZ


async def fetch_events(since: datetime, limit=5000, offset=0):
    """
    Pull *every* public fishing event in the window [since → now].
    If you wanted to filter by a single vessel, you could add:
       params["vessels[0]"] = "<SSVID-GUID>"
    """
    url = f"{API_BASE}/v3/events"
    params = {
        "datasets[0]": "public-global-fishing-events:latest",
        "start-date":  since.date().isoformat(),
        "end-date":    datetime.now(timezone.utc).date().isoformat(),
        "limit":       limit,
        "offset":      offset,
    }
    headers = {
        "Authorization": f"Bearer {os.getenv('GFW_TOKEN')}",
        "Accept":        "application/json",
    }

    async with aiohttp.ClientSession(
        connector=aiohttp.TCPConnector(ssl=ssl_ctx, family=socket.AF_INET)
    ) as s:
        async with s.get(url, params=params, headers=headers) as r:
            if r.status >= 300:
                text = await r.text()
                raise RuntimeError(f"GFW {r.status}: {text}")
            return await r.json()


# ──────────────────────────────────────────────────────────────
# Main loop
# ──────────────────────────────────────────────────────────────
async def main():
    # optional: load EEZ if you still want to spatial-filter
    eez = await get_eez_polygon()

    while True:
        since  = datetime.now(timezone.utc) - timedelta(minutes=15)
        payload = await fetch_events(since)
        print(f"[{datetime.now()}] fetched {payload['total']} events")

        for ev in payload.get("entries", []):
            lon = ev["position"]["lon"]
            lat = ev["position"]["lat"]

            # example spatial filter; remove if you want *all* events
            if not eez.contains(Point(lon, lat)):
                continue

            ssvid = ev["vessel"]["ssvid"]
            # skip already‐licensed
            exists = SUPA.table("licences")\
                        .select("mmsi")\
                        .eq("mmsi", ssvid)\
                        .execute().data
            if exists:
                continue

            prob = float(sess.run([out], {inp: vectorize(ev)[None, :]})[0][0][0])
            if prob < THR:
                continue

            SUPA.table("iuu_alerts").insert({
                "mmsi": ssvid,
                "ts":   ev["start"],
                "lat":  lat,
                "lon":  lon,
                "prob": prob
            }).execute()

        # sleep before fetching the next window
        await asyncio.sleep(600)


if __name__ == "__main__":
    asyncio.run(main())
