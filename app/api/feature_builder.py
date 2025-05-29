import numpy as np, pandas as pd, json, pathlib

FEATS = pathlib.Path(__file__).with_name("fishing_classifier.features.txt").read_text().splitlines()

def vectorize(e: dict) -> np.ndarray:
    # Event JSON comes from GFW `/v3/events`
    ts = pd.to_datetime(e["timestamp"], unit="s", utc=True)
    v  = [
        e.get("speed", 0.0),
        e.get("course", 0.0),
        e.get("distance_from_shore", 1e6),
        e.get("distance_from_port", 1e6),
        np.sin(2*np.pi*ts.hour/24),
        np.cos(2*np.pi*ts.hour/24),
        np.floor(e["lat"]/0.25)*0.25,
        np.floor(e["lon"]/0.25)*0.25,
        "unknown",          # gear_type placeholder (categorical)
    ]
    return np.array(v, dtype=object)    # ONNX mixed types
