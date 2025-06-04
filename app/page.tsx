// File: app/page.tsx
// ------------------------------
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import MapView, { Source, Layer } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection, Feature, Point } from 'geojson'

/* ─── Types ─── */
type Alert = { id: number; mmsi: number; lat: number; lon: number; prob: number; ts: string }
type SearchPayload = { entries: SearchEntry[]; since?: string | null }
type SearchEntry = {
  selfReportedInfo?: { id: string; ssvid: string }[]
  combinedSourcesInfo?: { vesselId: string }[]
}
type EventEntry = { position: { lon: number; lat: number }; vessel: { id: string } }
type EventsPayload = { entries: EventEntry[]; nextOffset?: number }

/* ─── ENV ─── */
const TOKEN = process.env.NEXT_PUBLIC_GFW_TOKEN ?? ''

export default function Home() {
  /* IUU alerts (red) */
  const [alerts, setAlerts] = useState<Alert[]>([])
  const ws = useRef<WebSocket | null>(null)
  useEffect(() => {
    ws.current = new WebSocket('ws://localhost:8000/ws')
    ws.current.onmessage = (e) => {
      try {
        setAlerts((prev) => [...prev, JSON.parse(e.data) as Alert])
      } catch {}
    }
    return () => ws.current?.close()
  }, [])

  const alertGeo: FeatureCollection<Point, { mmsi: number; prob: number }> = useMemo(
    () => ({
      type: 'FeatureCollection',
      features: alerts.map((a) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
        properties: { mmsi: a.mmsi, prob: a.prob },
      })),
    }),
    [alerts],
  )

  /* Saudi vessels (blue) */
  const [vesselsGeo, setVesselsGeo] = useState<FeatureCollection<Point, { uuid: string }> | null>(null)

  useEffect(() => {
    if (!TOKEN) {
      console.error('NEXT_PUBLIC_GFW_TOKEN missing')
      return
    }

    /* 1️⃣  Pull up to 1000 MMSI-403 vessels (pagination with `since`) */
    const fetchAllUUIDs = async () => {
      const uuids: string[] = []
      let since: string | null | undefined = null
      let pageCount = 0

      do {
        const q =
          'https://gateway.api.globalfishingwatch.org/v3/vessels/search?' +
          [
            'datasets[0]=public-global-vessel-identity:latest',
            'limit=50',
            since ? `since=${encodeURIComponent(since)}` : '',
            'where=' +
              encodeURIComponent(
                "(registryInfo.ssvid LIKE '403%' OR selfReportedInfo.ssvid LIKE '403%')",
              ),
          ]
            .filter(Boolean)
            .join('&')
            
        // Log the first 10 “search” URLs so you can copy/paste in Postman:
        if (pageCount < 10) {
          console.log(`[GFW-SEARCH Page ${pageCount + 1} URL]: ${q}`)
        }
        pageCount += 1

        const resp = await fetch(q, { headers: { Authorization: `Bearer ${TOKEN}` } })
        if (!resp.ok) throw new Error(`search failed ${resp.status}`)
        const payload: SearchPayload = await resp.json()

        payload.entries.forEach((e) => {
          if (uuids.length < 10000) {
            const id = e.combinedSourcesInfo?.[0]?.vesselId ?? e.selfReportedInfo?.[0]?.id
            if (id) uuids.push(id)
          }
        })

        since = payload.since
      } while (since && uuids.length < 10000)
      console.log(`fetched ${uuids.length} UUIDs`)
      return uuids.slice(0, 10000)
      
    }

    /* 2️⃣  Fetch fishing events (last 24 h) for those UUIDs */
    const fetchLatestPositions = async (ids: string[]) => {
      if (!ids.length) return []

      const now = new Date()
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      const baseParams = [
        'datasets[0]=public-global-fishing-events:latest',
        `start-date=${yesterday.toISOString().slice(0, 10)}`,
        `end-date=${now.toISOString().slice(0, 10)}`,
        'limit=1000',
      ]

      /*  <--  tweak: max 20 vessels per call  */
      const chunkSize = 20
      const features: Feature<Point, { uuid: string }>[] = []

      for (let i = 0; i < ids.length; i += chunkSize) {
        const slice = ids.slice(i, i + chunkSize)
        const vesselParams = slice.map((u, idx) => `vessels[${idx}]=${u}`)
        let offset = 0
        let more = false

        do {
          const url =
            'https://gateway.api.globalfishingwatch.org/v3/events?' +
            [
              ...baseParams,
              ...vesselParams,
              /*  <--  omit offset when 0  */
              `offset=${offset}`,   
            ].join('&')

          const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })
          if (!r.ok) throw new Error(`events fetch ${r.status}`)
          const p: EventsPayload = await r.json()

          p.entries.forEach((ev) => {
            // Log any fetched event positions to the console:
            console.log(
              `[GFW Event] Vessel=${ev.vessel.id}  lat=${ev.position.lat}  lon=${ev.position.lon}`,
            )

            features.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [ev.position.lon, ev.position.lat] },
              properties: { uuid: ev.vessel.id },
            })
          })

          offset = p.nextOffset ?? -1
          more = offset >= 0
        } while (more)
      }

      // After collecting all features, log how many we found:
      console.log(`[GFW] Total event‐features fetched: ${features.length}`)

      return features
    }

    /* orchestrate */
    ;(async () => {
      try {
        const uuids = await fetchAllUUIDs()
        console.log(`[GFW] Collected UUIDs: ${uuids.length}`) // should be up to 10 000

        const feats = await fetchLatestPositions(uuids)
        setVesselsGeo({ type: 'FeatureCollection', features: feats })
      } catch (err) {
        console.error(err)
      }
    })()
  }, [])

  /* ─── Map ─── */
  return (
    <div className="h-screen">
      <MapView
        initialViewState={{ longitude: 43.5, latitude: 23.5, zoom: 5.5 }}
        interactive
        mapLib={import('maplibre-gl')}
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
