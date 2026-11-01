import type { LatLon } from './cpa.js'

/**
 * Region kinds where boats lie still by design, read from
 * `feature.properties.zoneType` of the server's `regions` resources.
 * Proposed as a shared convention so other plugins can act on the same
 * regions; see the README.
 */
export const QUIET_ZONE_TYPES: readonly string[] = ['harbour', 'berth', 'mooringField']

/** A GeoJSON polygon: outer ring first, then holes; positions are [lon, lat]. */
export type Polygon = Array<Array<[number, number]>>

function isPosition(p: unknown): p is [number, number] {
  return (
    Array.isArray(p) &&
    p.length >= 2 &&
    typeof p[0] === 'number' &&
    typeof p[1] === 'number' &&
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1])
  )
}

function toPolygon(coords: unknown): Polygon | null {
  if (!Array.isArray(coords) || coords.length === 0) {
    return null
  }
  const rings: Polygon = []
  for (const ring of coords) {
    if (!Array.isArray(ring) || ring.length < 4 || !ring.every(isPosition)) {
      return null
    }
    rings.push(ring)
  }
  return rings
}

interface RegionLike {
  feature?: {
    geometry?: { type?: unknown; coordinates?: unknown }
    properties?: Record<string, unknown> | null
  }
}

/**
 * The polygons of every region whose zoneType marks it as a place where
 * boats lie still. Regions of other kinds, and malformed geometry, are left
 * out.
 */
export function quietPolygons(resources: Record<string, unknown> | undefined | null): Polygon[] {
  const polygons: Polygon[] = []
  for (const value of Object.values(resources ?? {})) {
    const feature = (value as RegionLike | null)?.feature
    const zoneType = feature?.properties?.zoneType
    if (typeof zoneType !== 'string' || !QUIET_ZONE_TYPES.includes(zoneType)) {
      continue
    }
    const geometry = feature?.geometry
    if (geometry?.type === 'Polygon') {
      const polygon = toPolygon(geometry.coordinates)
      if (polygon) {
        polygons.push(polygon)
      }
    } else if (geometry?.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
      for (const coords of geometry.coordinates) {
        const polygon = toPolygon(coords)
        if (polygon) {
          polygons.push(polygon)
        }
      }
    }
  }
  return polygons
}

/** Ray casting; harbour-sized regions are small enough to treat as flat. */
function inRing(p: LatLon, ring: Array<[number, number]>): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (
      yi > p.latitude !== yj > p.latitude &&
      p.longitude < ((xj - xi) * (p.latitude - yi)) / (yj - yi) + xi
    ) {
      inside = !inside
    }
  }
  return inside
}

export function inPolygon(p: LatLon, polygon: Polygon): boolean {
  const [outer, ...holes] = polygon
  return inRing(p, outer) && !holes.some((hole) => inRing(p, hole))
}

export function inAnyPolygon(p: LatLon, polygons: Polygon[]): boolean {
  return polygons.some((polygon) => inPolygon(p, polygon))
}
