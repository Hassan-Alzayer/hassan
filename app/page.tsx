'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import MapView, { Source, Layer } from 'react-map-gl/maplibre'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection, Feature, Point } from 'geojson'

/* ─── Types ─── */
type Alert = {
  id: number
  mmsi: number
  lat: number
  lon: number
  prob: number
  ts: string
}

type EventEntry = {
  position: { lon: number; lat: number }
  vessel: { id: string; flag: string }
}

type EventsPayload = {
  entries: EventEntry[]
  nextOffset?: number
}

/* ─── ENV ─── */
const TOKEN = process.env.NEXT_PUBLIC_GFW_TOKEN ?? ''

export default function Home() {
  /* ─── IUU alerts (red) ─── */
  const [alerts, setAlerts] = useState<Alert[]>([])
  const ws = useRef<WebSocket | null>(null)

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws.current = new WebSocket(`${protocol}//${window.location.hostname}:8000/ws`)
    ws.current.onmessage = (e) => {
      try {
        setAlerts((prev) => [...prev, JSON.parse(e.data) as Alert])
      } catch {}
    }
    return () => ws.current?.close()
  }, [])

  const alertGeo: FeatureCollection<Point, { mmsi: number; prob: number }> = useMemo(() => {
    return {
      type: 'FeatureCollection',
      features: alerts.map((a) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
        properties: { mmsi: a.mmsi, prob: a.prob },
      })),
    }
  }, [alerts])

  /* ─── Saudi "fishing events" (blue) ─── */
  const [vesselsGeo, setVesselsGeo] = useState<FeatureCollection<Point, { uuid: string }> | null>(null)

  useEffect(() => {
    if (!TOKEN) {
      console.error('NEXT_PUBLIC_GFW_TOKEN missing')
      return
    }

    /**
     * Instead of first paging through all vessels, we can directly ask:
     *   "Give me all fishing events in the last 7 days, where the vessel's flag = 'SAU'."
     *
     * We will page in batches of 1000 events at a time (via offset), and stop when nextOffset is null.
     * Any returned event tells us that vessel "id" (UUID) had fishing at that lat/lon.
     */
    const fetchSaudiFishingEvents = async (): Promise<Feature<Point, { uuid: string }>[]> => {
      const features: Feature<Point, { uuid: string }>[] = []

      // 1) Build date strings for a 7-day window (YYYY-MM-DD)
      const now = new Date()
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      const startDate = sevenDaysAgo.toISOString().slice(0, 10) // e.g. "2025-05-28"
      const endDate = now.toISOString().slice(0, 10) // e.g. "2025-06-04"

      // 2) We'll request up to 1000 events per page, offset = 0, 1000, 2000, ...
      let offset = 0
      let pageCount = 0
      let more = false

      do {
        pageCount += 1

        // Build URL parameters:
        //   - datasets[0]=public-global-fishing-events:latest
        //   - start-date=<7-days-ago>
        //   - end-date=<today>
        //   - flags[0]=SAU       (only Saudi-flagged vessels)
        //   - limit=1000
        //   - offset=<offset>
        //
        // In a single GET request, we can simply put these in the query string:
        const params = [
          'datasets[0]=public-global-fishing-events:latest',
          `start-date=${startDate}`,
          `end-date=${endDate}`,
          'flags[0]=SAU',   // <-- only "SAU"
          'limit=1000',
          `offset=${offset}`,
        ].join('&')

        const url = `https://gateway.api.globalfishingwatch.org/v3/events?${params}`

        // 3) Fetch this page
        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
        if (!resp.ok) throw new Error(`events fetch failed ${resp.status}`)

        const payload: EventsPayload = await resp.json()

        // 4) If this page returned any entries, log how many:
        if (payload.entries.length > 0) {
          console.log(
            `[GFW] Page ${pageCount}: fetched ${payload.entries.length} Saudi fishing events (offset=${offset})`
          )
        } else {
          console.log(`[GFW] Page ${pageCount}: no events (offset=${offset})`)
        }

        // 5) Convert each event into a GeoJSON Feature
        payload.entries.forEach((ev) => {
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [ev.position.lon, ev.position.lat] },
            properties: { uuid: ev.vessel.id },
          })
        })

        // 6) Advance offset. If nextOffset is null or undefined, we stop.
        offset = payload.nextOffset ?? -1
        more = offset >= 0
      } while (more)

      console.log(`[GFW] Total Saudi fishing‐events fetched: ${features.length}`)
      return features
    }

    /* Orchestrate: call fetchSaudiFishingEvents(), set state */
    ;(async () => {
      try {
        const feats = await fetchSaudiFishingEvents()
        setVesselsGeo({ type: 'FeatureCollection', features: feats })
      } catch (err) {
        console.error(err)
      }
    })()
  }, [])

  /* ─── Render the Map ─── */
  return (
    <div className="h-screen">
      <MapView
        initialViewState={{ longitude: 43.5, latitude: 23.5, zoom: 5.5 }}
        interactive
        mapLib={maplibregl}
        mapStyle="https://demotiles.maplibre.org/style.json"
      >
        {vesselsGeo && (
          <Source id="saudi-vessels" type="geojson" data={vesselsGeo}>
            <Layer
              id="saudi-vessels-layer"
              type="circle"
              paint={{
                'circle-radius': 6,
                'circle-color': '#3366FF',
                'circle-stroke-color': '#FFFFFF',
                'circle-stroke-width': 1,
              }}
            />
          </Source>
        )}

        <Source id="iuu-alerts" type="geojson" data={alertGeo}>
          <Layer
            id="iuu-alerts-layer"
            type="circle"
            paint={{
              'circle-radius': 5,
              'circle-color': '#FF3333',
              'circle-stroke-color': '#FFFFFF',
              'circle-stroke-width': 1,
            }}
          />
        </Source>
      </MapView>
    </div>
  )
}