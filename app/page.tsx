// File: app/page.tsx
// ------------------------------

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Map, { Source, Layer } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection, Feature, Point } from 'geojson'

//
// (1) Define our IUU‐alert type (pushed from FastAPI WebSocket)
//
type Alert = {
  id: number
  mmsi: number
  lat: number
  lon: number
  prob: number
  ts: string
}

//
// (2) Read the GFW token from NEXT_PUBLIC_GFW_TOKEN so it’s available client‐side.
//     If this is blank or wrong, every tile will return {"error":"Not authorized"}.
//     Make sure your .env.local contains exactly:
//       NEXT_PUBLIC_GFW_TOKEN=<your_valid_token>
//
const TOKEN = process.env.NEXT_PUBLIC_GFW_TOKEN ?? ''

export default function Home() {
  //
  // (A) Stream “live IUU alerts” from FastAPI WebSocket
  //
  const [alerts, setAlerts] = useState<Alert[]>([])
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    console.log('🚀 GFW token is:', TOKEN)
    wsRef.current = new WebSocket('ws://localhost:8000/ws')
    wsRef.current.onmessage = (e) => {
      const newAlert = JSON.parse(e.data) as Alert
      setAlerts((prev) => [...prev, newAlert])
    }
    return () => {
      wsRef.current?.close()
    }
  }, [])

  //
  // (B) Convert “alerts” → GeoJSON so we can plot red dots
  //
  const alertGeo: FeatureCollection<Point, { mmsi: number; prob: number }> = useMemo(
    () => ({
      type: 'FeatureCollection',
      features: alerts.map((a) => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [a.lon, a.lat],
        },
        properties: {
          mmsi: a.mmsi,
          prob: a.prob,
        },
      })) as Feature<Point, { mmsi: number; prob: number }>[],
    }),
    [alerts]
  )

  //
  // (C) Build and URL‐encode the “date-range” per GFW docs:
  //     "2025-05-22,2025-05-29" → "2025-05-22%2C2025-05-29"
  //
  const endDate = new Date(Date.now() - 3 * 24 * 3600_000).toISOString().slice(0, 10)   // "2025-05-29"
  const startDate = new Date(Date.now() - 10 * 24 * 3600_000).toISOString().slice(0, 10) // "2025-05-22"
  const rawDateRange = `${startDate},${endDate}`                                       // "2025-05-22,2025-05-29"
  const dateRangeEncoded = encodeURIComponent(rawDateRange)                             // "2025-05-22%2C2025-05-29"

  //
  // (D) Build the GFW tile URL, but lock z=6 (only one zoom level).
  //     Example working URL (z=6, x=42, y=25):
  //     https://gateway.api.globalfishingwatch.org/v3/4wings/tile/heatmap/6/42/25
  //       ?datasets[0]=public-global-fishing-effort:latest
  //       &date-range=2025-05-22%2C2025-05-29
  //       &interval=DAY
  //       &format=MVT
  //       &temporal-aggregation=true
  //
  // We replace “42/25” → “{x}/{y}” so MapLibre can fetch any (x,y) at z=6.
  //
  const gfwTiles = [
    'https://gateway.api.globalfishingwatch.org',
    '/v3/4wings/tile/heatmap/6/{x}/{y}',
    `?datasets[0]=public-global-fishing-effort:latest`,
    `&date-range=${dateRangeEncoded}`,
    `&interval=DAY`,
    `&format=MVT`,
    `&temporal-aggregation=true`,
  ].join('')

  //
  // (E) Saudi Arabia bounding box, as [minLng, minLat, maxLng, maxLat]
  //     ≈ [34.5°E, 16.0°N, 55.5°E, 32.5°N]
  //
  const SA_BOUNDS: [number, number, number, number] = [34.5, 16.0, 55.5, 32.5]

  return (
    <div className="h-screen">
      <Map
        //
        // 1) CENTER on Saudi Arabia at zoom=6
        // 2) LOCK zoom so the user cannot zoom in/out (minZoom = maxZoom = 6)
        // 3) interactive={false} → no panning or zooming at all
        //
        initialViewState={{
          longitude: 43.5, // center of KSA
          latitude: 23.5,
          zoom: 6,
        }}
        minZoom={6}
        maxZoom={6}
        interactive={false}

        //
        // 4) maxBounds locks the viewport strictly to Saudi’s bounding box.
        //    Otherwise, MapLibre might try to request tiles outside SA (causing 404/401).
        //
        maxBounds={SA_BOUNDS}

        //
        // 5) transformRequest: attach `Authorization: Bearer <TOKEN>` to
        //    **every** request whose URL contains “globalfishingwatch.org”. 
        //    That guarantees no tile ever goes out without the token.
        //
        transformRequest={(url) => {
          if (url.includes('globalfishingwatch.org')) {
            return {
              url,
              headers: {
                Authorization: `Bearer ${TOKEN}`,
              },
            }
          }
          return { url }
        }}

        mapLib={import('maplibre-gl')}
        mapStyle="https://demotiles.maplibre.org/style.json"
      >
        {/*
          (F) “Blue” GFW heatmap at z=6. Because we locked zoom=6, MapLibre only ever
          requests /heatmap/6/{x}/{y}. All valid x,y ∈ [0..63] inside SA_BOUNDS get drawn.
        */}
        <Source
          id="gfw-effort"
          type="vector"
          tiles={[gfwTiles]}
        >
          <Layer
            id="effort"
            source-layer="grid"
            type="heatmap"
            paint={{
              'heatmap-weight': 1,
              'heatmap-intensity': 1,
              'heatmap-color': [
                'interpolate',
                ['linear'],
                ['heatmap-density'],
                0,
                'rgba(0,174,235,0)',   // transparent where density=0
                0.4,
                'rgba(0,174,235,0.4)',
                1,
                'rgba(0,174,235,0.8)',
              ],
            }}
          />
        </Source>

        {/*
          (G) “Red dots” for IUU alerts, overlaid on top of the blue heatmap.
        */}
        <Source id="iuu-alerts" type="geojson" data={alertGeo}>
          <Layer
            id="iuu-layer"
            type="circle"
            paint={{
              'circle-radius': 5,
              'circle-color': '#FF3333',
              'circle-stroke-width': 1,
              'circle-stroke-color': '#ffffff',
            }}
          />
        </Source>
      </Map>
    </div>
  )
}
