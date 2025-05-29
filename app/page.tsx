// src/app/page.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import Map, { Source, Layer } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection, Feature, Point } from 'geojson'

type Alert = {
  id: number
  mmsi: number
  lat: number
  lon: number
  prob: number
  ts: string
}

export default function Home() {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const wsRef = useRef<WebSocket | null>(null)

  // —— live WebSocket stream ——
  useEffect(() => {
    wsRef.current = new WebSocket('ws://localhost:8000/ws')
    wsRef.current.onmessage = (e) =>
      setAlerts((prev) => [...prev, JSON.parse(e.data) as Alert])
    return () => wsRef.current?.close()
  }, [])

  // Typed as a proper GeoJSON FeatureCollection of Point features
  const alertGeoJSON: FeatureCollection<
    Point,
    { mmsi: number; prob: number }
  > = {
    type: 'FeatureCollection',
    features: alerts.map(
      (a): Feature<Point, { mmsi: number; prob: number }> => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [a.lon, a.lat],
        },
        properties: {
          mmsi: a.mmsi,
          prob: a.prob,
        },
      })
    ),
  }

  // 72 hours ago for your vector-tile URL
  const t0 = new Date(Date.now() - 72 * 3600 * 1000).toISOString()

  return (
    <div className="h-screen">
      <Map
        initialViewState={{ longitude: 42, latitude: 22, zoom: 4 }}
        mapStyle="https://demotiles.maplibre.org/style.json"
      >
        {/* GFW public vessel-events vector tiles (blue) */}
        <Source
          id="gfw"
          type="vector"
          tiles={[
            `https://tiles.globalfishingwatch.org/v2/{z}/{x}/{y}.pbf?layer=vessel-events&from=${t0}`,
          ]}
        >
          <Layer
            id="vessels"
            source-layer="vessel-events"
            type="circle"
            paint={{ 'circle-radius': 2, 'circle-color': '#00AEEB' }}
          />
        </Source>

        {/* Live IUU alerts (red) */}
        <Source id="iuu" type="geojson" data={alertGeoJSON}>
          <Layer
            id="iuu-layer"
            type="circle"
            paint={{ 'circle-radius': 4, 'circle-color': '#FF3333' }}
          />
        </Source>
      </Map>
    </div>
  )
}
