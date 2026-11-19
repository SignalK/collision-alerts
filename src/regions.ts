import type { ServerAPI } from '@signalk/server-api'
import type { LatLon } from './cpa.js'

/** GeoJSON positions: [longitude, latitude]. */
type Ring = number[][]
/** Polygons, each an outer ring followed by its holes. */
type Area = Ring[][]

interface RegionResource {
  name?: unknown
  feature?: { geometry?: { type?: unknown; coordinates?: unknown } }
}

function areaOf(region: RegionResource): Area {
  const geometry = region.feature?.geometry
  if (!Array.isArray(geometry?.coordinates)) return []
  if (geometry.type === 'Polygon') return [geometry.coordinates as Ring[]]
  if (geometry.type === 'MultiPolygon') return geometry.coordinates as Ring[][]
  return []
}

function inRing(point: LatLon, ring: Ring): boolean {
  const x = point.longitude
  const y = point.latitude
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function inArea(point: LatLon, area: Area): boolean {
  return area.some(
    (polygon) =>
      polygon.length > 0 &&
      inRing(point, polygon[0]) &&
      !polygon.slice(1).some((hole) => inRing(point, hole))
  )
}

/**
 * The regions the user chose to keep quiet, as last read from the resources
 * API. A region that cannot be read (deleted, provider stopped) is dropped,
 * so alarms come back rather than stay silenced by a region that is gone.
 */
export class SilentRegions {
  private areas = new Map<string, { name: string; area: Area }>()

  constructor(
    private readonly app: ServerAPI,
    private readonly ids: string[]
  ) {}

  async refresh(): Promise<void> {
    for (const id of this.ids) {
      try {
        const region = (await this.app.resourcesApi.getResource('regions', id)) as RegionResource
        this.areas.set(id, {
          name: typeof region.name === 'string' && region.name !== '' ? region.name : id,
          area: areaOf(region)
        })
      } catch (err) {
        if (this.areas.delete(id)) {
          this.app.error(`Region ${id} can no longer be read: ${String(err)}`)
        }
      }
    }
  }

  /** The name of a chosen region the position lies in, if any. */
  containing(position: LatLon): string | undefined {
    for (const { name, area } of this.areas.values()) {
      if (inArea(position, area)) return name
    }
    return undefined
  }
}

/**
 * The region choices for the admin form: every region the server knows, plus
 * any chosen one that is gone, so a saved choice still validates.
 */
export async function regionChoices(
  app: ServerAPI,
  chosen: string[]
): Promise<{ enum: string[]; enumNames: string[] } | undefined> {
  let regions: Record<string, unknown> = {}
  try {
    regions = await app.resourcesApi.listResources('regions', {})
  } catch (err) {
    app.debug(`Could not list regions: ${String(err)}`)
  }
  const choices = new Map<string, string>()
  for (const [id, region] of Object.entries(regions)) {
    const name = (region as RegionResource).name
    choices.set(id, typeof name === 'string' && name !== '' ? name : id)
  }
  for (const id of chosen) {
    if (!choices.has(id)) choices.set(id, `${id} (not found)`)
  }
  if (choices.size === 0) return undefined
  return { enum: [...choices.keys()], enumNames: [...choices.values()] }
}
