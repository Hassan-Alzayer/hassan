'use client'

import {useEffect, useRef, useState, useMemo} from 'react'
import Map, {Source, Layer} from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import type {FeatureCollection, Feature, Point} from 'geojson'

type Alert = {
  id: number
  mmsi: number
  lat: number
  lon: number
  prob: number
  ts: string
}

/* your .env file must define NEXT_PUBLIC_GFW_TOKEN */
const TOKEN = process.env.NEXT_PUBLIC_GFW_TOKEN || ''

export default function Home() {
  /* ───────────── live IUU alerts from FastAPI websocket ───────────── */
  const [alerts, setAlerts] = useState<Alert[]>([])
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    wsRef.current = new WebSocket('ws://localhost:8000/ws')
    wsRef.current.onmessage = e =>
      setAlerts(prev => [...prev, JSON.parse(e.data) as Alert])
    return () => wsRef.current?.close()
  }, [])

  /* convert alert array → GeoJSON once per render */
  const alertGeo: FeatureCollection<
    Point,
    {mmsi: number; prob: number}
  > = useMemo(
    () => ({
      type: 'FeatureCollection',
      features: alerts.map(
        (a): Feature<Point, {mmsi: number; prob: number}> => ({
          type: 'Feature',
          geometry: {type: 'Point', coordinates: [a.lon, a.lat]},
          properties: {mmsi: a.mmsi, prob: a.prob}
        })
      )
    }),
    [alerts]
  )

  /* 4Wings tiles want a YYYY-MM-DD date range */
  const end = new Date(Date.now() - 3 * 24 * 3600_000) // 72 h lag
    .toISOString()
    .slice(0, 10)
  const start = new Date(Date.now() - 10 * 24 * 3600_000)
    .toISOString()
    .slice(0, 10)
  const dateRange = `${start},${end}`

  const gfwTiles =
    'https://gateway.api.globalfishingwatch.org' +
    `/v3/4wings/tile/events/{z}/{x}/{y}` +
    `?format=MVT` +
    `&datasets[0]=public-global-fishing-events:latest` +
    `&date-range=${dateRange}`

  return (
    <div className="h-screen">
      <Map
        mapLib={import('maplibre-gl')}
        initialViewState={{longitude: 42, latitude: 22, zoom: 4}}
        mapStyle="https://demotiles.maplibre.org/style.json"
        /* — add Bearer token only on tile requests hitting the gateway — */
        transformRequest={(url, resourceType) =>
          resourceType === 'Tile' &&
          url.startsWith('https://gateway.api.globalfishingwatch.org')
            ? {url, headers: {Authorization: `Bearer ${TOKEN}`}}
            : {url}
        }
      >
        {/* blue vessel-events layer from GFW */}
        <Source id="gfw-events" type="vector" tiles={[gfwTiles]}>
          <Layer
            id="gfw-dots"
            source-layer="events"
            type="circle"
            paint={{'circle-radius': 2, 'circle-color': '#00AEEB'}}
          />
        </Source>

        {/* red live alerts from your ML pipeline */}
        <Source id="iuu-alerts" type="geojson" data={alertGeo}>
          <Layer
            id="iuu-layer"
            type="circle"
            paint={{'circle-radius': 4, 'circle-color': '#FF3333'}}
          />
        </Source>
      </Map>
    </div>
  )
}
