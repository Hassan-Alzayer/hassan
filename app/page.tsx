'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import MapView, { Source, Layer, Popup } from 'react-map-gl/maplibre'
import maplibreGl from 'maplibre-gl'
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
  vessel: { id: string; flag: string; name?: string }
}

type EventsPayload = {
  entries: EventEntry[]
  nextOffset?: number
}

type PopupInfo = {
  longitude: number
  latitude: number
  vesselName: string
}

/* ─── ENV ─── */
const TOKEN = process.env.NEXT_PUBLIC_GFW_TOKEN ?? ''

export default function Home() {
  /* ─── IUU alerts (red) ─── */
  const [alerts, setAlerts] = useState<Alert[]>([])
  const ws = useRef<WebSocket | null>(null)
  const [popupInfo, setPopupInfo] = useState<PopupInfo | null>(null)

  useEffect(() => {
    ws.current = new WebSocket(`ws://${window.location.hostname}:8000/ws`)
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
  const [vesselsGeo, setVesselsGeo] = useState<FeatureCollection<Point, { uuid: string; vesselName: string }> | null>(null)

  useEffect(() => {
    if (!TOKEN) {
      console.error('NEXT_PUBLIC_GFW_TOKEN missing')
      return
    }

    const fetchSaudiFishingEvents = async (): Promise<Feature<Point, { uuid: string; vesselName: string }>[]> => {
      const features: Feature<Point, { uuid: string; vesselName: string }>[] = []

      const now = new Date()
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      const startDate = sevenDaysAgo.toISOString().slice(0, 10)
      const endDate = now.toISOString().slice(0, 10)

      let offset = 0
      let pageCount = 0
      let more = false

      do {
        pageCount += 1

        const params = [
          'datasets[0]=public-global-fishing-events:latest',
          `start-date=${startDate}`,
          `end-date=${endDate}`,
          'flags[0]=SAU',
          'limit=1000',
          `offset=${offset}`,
        ].join('&')

        const url = `https://gateway.api.globalfishingwatch.org/v3/events?${params}`

        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
        if (!resp.ok) throw new Error(`events fetch failed ${resp.status}`)

        const payload: EventsPayload = await resp.json()

        if (payload.entries.length > 0) {
          console.log(
            `[GFW] Page ${pageCount}: fetched ${payload.entries.length} Saudi fishing events (offset=${offset})`
          )
        } else {
          console.log(`[GFW] Page ${pageCount}: no events (offset=${offset})`)
        }

        payload.entries.forEach((ev) => {
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [ev.position.lon, ev.position.lat] },
            properties: { 
              uuid: ev.vessel.id,
              vesselName: ev.vessel.name || 'Unknown Vessel'
            },
          })
        })

        offset = payload.nextOffset ?? -1
        more = offset >= 0
      } while (more)

      console.log(`[GFW] Total Saudi fishing‐events fetched: ${features.length}`)
      return features
    }

    ;(async () => {
      try {
        const feats = await fetchSaudiFishingEvents()
        setVesselsGeo({ type: 'FeatureCollection', features: feats })
      } catch (err) {
        console.error(err)
      }
    })()
  }, [])

  /* ─── Handle Click Events ─── */
  const onClick = (event: any) => {
    const feature = event.features?.[0]
    if (feature) {
      setPopupInfo({
        longitude: feature.geometry.coordinates[0],
        latitude: feature.geometry.coordinates[1],
        vesselName: feature.properties.vesselName || `MMSI: ${feature.properties.mmsi}`
      })
    }
  }

  /* ─── Render the Map ─── */
  return (
    <div className="h-screen">
      <MapView
        initialViewState={{ longitude: 43.5, latitude: 23.5, zoom: 5.5 }}
        interactive
        mapLib={maplibreGl}
        mapStyle="https://demotiles.maplibre.org/style.json"
        onClick={onClick}
        interactiveLayerIds={['saudi-vessels-layer', 'iuu-alerts-layer']}
      >
        {vesselsGeo && (
          <Source id="saudi-vessels\" type="geojson\" data={vesselsGeo}>
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

        {popupInfo && (
          <Popup
            longitude={popupInfo.longitude}
            latitude={popupInfo.latitude}
            onClose={() => setPopupInfo(null)}
            closeButton={true}
          >
            <div className="p-2">
              <h3 className="font-bold">{popupInfo.vesselName}</h3>
            </div>
          </Popup>
        )}
      </MapView>
    </div>
  )
}