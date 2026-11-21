import { gunzipSync } from 'node:zlib'
import { VectorTile, type VectorTileLayer } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import type { ServerAPI } from '@signalk/server-api'
import type { LatLon } from './cpa.js'

/**
 * The PropertyValue through which a chart provider plugin hands its tiles to
 * other plugins in-process, whatever the server's security settings.
 */
export const CHART_TILES_PROPERTY = 'chartTiles'

export interface ChartTiles {
  /**
   * The tile body as served over HTTP (a vector tile may be gzipped). Null
   * where the chart has no tile, undefined for a chart this provider does
   * not have.
   */
  getTile(chartId: string, z: number, x: number, y: number): Promise<Uint8Array | null | undefined>
}

/** A stretch of land along a course: where it begins and its length, metres. */
export interface LandRun {
  start: number
  length: number
}

// S-57 object classes, which S-57 vector charts carry as layer names. On one
// chart the land and the water areas never overlap.
const LAND = 'LNDARE'
const WATER = ['DEPARE', 'DRGARE']

// Tiles about 2 km across in the tropics. A chart that has no tiles this
// fine is an overview, whose generalised coastline can close a narrow
// passage, and is not read.
const ZOOM = 14
// Metres between the points tested along a course.
const STEP = 10
// Points tested on one course at most: a course is read only this far
// (20 km), as a wider spacing would measure land too short to count.
const MAX_POINTS = 2000
// Tiles kept; more while the courses being checked need them.
const MAX_TILES = 256
// By default, a tile used this recently (ms) is not evicted.
const IN_USE_MS = 5000
const PARALLEL_READS = 4
const READ_TIMEOUT_MS = 5000
const RETRY_MS = 60_000
// Charts can be rebuilt in place under the same id; tiles are read afresh
// this often (ms).
const TILE_TTL_MS = 600_000
const MAX_TILE_BYTES = 16 * 1024 * 1024
// Horizontal bands per tile into which a layer's edges are sorted, so a
// point is tested against the edges near it only.
const BANDS = 64
const EARTH_RADIUS = 6371008.8
const DEG = Math.PI / 180

/** A layer's polygon edges, sorted into horizontal bands of the tile. */
export interface Layer {
  extent: number
  /** Per band, the edges reaching into it, flat as x1, y1, x2, y2, feature. */
  bands: Int32Array[]
  features: number
}

interface Chart {
  id: string
  zoom: number
  /** West, south, east, north; west > east across the antimeridian. */
  bounds?: [number, number, number, number]
}

interface ChartResource {
  type?: unknown
  minzoom?: unknown
  maxzoom?: unknown
  bounds?: unknown
}

type Tile =
  | { state: 'loaded'; land: Layer[]; water: Layer[] }
  | { state: 'none' }
  | { state: 'failed'; retryAt: number }
  | { state: 'loading' }

interface Entry {
  tile: Tile
  usedAt: number
}

/** What the charts show at a point. */
type Ground = 'water' | 'land' | 'unknown' | 'loading'

function chartOf(id: string, chart: ChartResource): Chart | undefined {
  if (typeof chart.type !== 'string' || chart.type.toUpperCase() !== 'S-57') return undefined
  const min = typeof chart.minzoom === 'number' ? chart.minzoom : 0
  const max = typeof chart.maxzoom === 'number' ? chart.maxzoom : ZOOM
  if (max < ZOOM) return undefined
  const bounds =
    Array.isArray(chart.bounds) &&
    chart.bounds.length === 4 &&
    chart.bounds.every((b) => typeof b === 'number' && Number.isFinite(b))
      ? (chart.bounds as [number, number, number, number])
      : undefined
  return { id, zoom: Math.max(min, ZOOM), bounds }
}

function covers(chart: Chart, { latitude, longitude }: LatLon): boolean {
  if (!chart.bounds) return true
  const [west, south, east, north] = chart.bounds
  if (latitude < south || latitude > north) return false
  return west <= east
    ? longitude >= west && longitude <= east
    : longitude >= west || longitude <= east
}

function wrap(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180
}

/** Web Mercator tile coordinates of a point, fractional. */
export function tileXY({ latitude, longitude }: LatLon, zoom: number): [number, number] {
  const n = 2 ** zoom
  const lat = Math.max(-85.0511, Math.min(85.0511, latitude)) * DEG
  return [
    ((wrap(longitude) + 180) / 360) * n,
    ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n
  ]
}

function bandOf(y: number, extent: number): number {
  return Math.max(0, Math.min(BANDS - 1, Math.floor((y / extent) * BANDS)))
}

function layerOf(layer: VectorTileLayer): Layer {
  const bands: number[][] = Array.from({ length: BANDS }, () => [])
  let features = 0
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i)
    if (feature.type !== 3) continue
    for (const ring of feature.loadGeometry()) {
      for (let j = 0, k = ring.length - 1; j < ring.length; k = j++) {
        const a = ring[k]
        const b = ring[j]
        if (a.y === b.y) continue
        const last = bandOf(Math.max(a.y, b.y), layer.extent)
        for (let band = bandOf(Math.min(a.y, b.y), layer.extent); band <= last; band++) {
          bands[band].push(a.x, a.y, b.x, b.y, features)
        }
      }
    }
    features++
  }
  return { extent: layer.extent, bands: bands.map((edges) => Int32Array.from(edges)), features }
}

/** The polygons of the named layers of a vector tile, by name. */
export function tileLayers(body: Uint8Array, names: string[]): Map<string, Layer> {
  const bytes =
    body[0] === 0x1f && body[1] === 0x8b
      ? gunzipSync(body, { maxOutputLength: MAX_TILE_BYTES })
      : body
  const tile = new VectorTile(new PbfReader(bytes))
  const layers = new Map<string, Layer>()
  for (const name of names) {
    const layer = tile.layers[name] as VectorTileLayer | undefined
    if (!layer) continue
    // Its positions cannot be read: skipped, a water layer would turn water
    // into land.
    if (!(layer.extent > 0)) throw new Error(`layer ${name} has no extent`)
    layers.set(name, layerOf(layer))
  }
  return layers
}

/**
 * Whether a point in tile units lies inside any polygon of a layer, by the
 * even-odd rule over each feature's rings: inside an outer ring, outside its
 * holes.
 */
export function inLayer({ extent, bands, features }: Layer, x: number, y: number): boolean {
  const edges = bands[bandOf(y, extent)]
  const odd = new Uint8Array(features)
  for (let i = 0; i < edges.length; i += 5) {
    const x1 = edges[i]
    const y1 = edges[i + 1]
    const x2 = edges[i + 2]
    const y2 = edges[i + 3]
    if (y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) odd[edges[i + 4]] ^= 1
  }
  return odd.includes(1)
}

function isChartTiles(value: unknown): value is ChartTiles {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getTile?: unknown }).getTile === 'function'
  )
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no tile within ${ms / 1000} s`))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}

/**
 * The land on the S-57 charts that chart provider plugins hand out, for
 * telling where a course runs across it. Tiles are read as courses need
 * them, so a question about a new stretch of water is answered once its
 * tiles have loaded.
 */
export class ChartLand {
  private charts: Chart[] = []
  /** In order of last use, the oldest first. */
  private tiles = new Map<string, Entry>()
  private queue: { entry: Entry; chart: Chart; x: number; y: number }[] = []
  private reading = 0
  private clearedAt = Date.now()
  private stopped = false
  /** The latest `chartTiles` of each provider plugin. */
  private providers = new Map<string, ChartTiles>()
  private readonly unsubscribe: () => void
  /** Per chart, the failures already logged since it last read. */
  private readonly reported = new Map<string, Set<string>>()

  /**
   * @param inUseMs a tile used this recently (ms) is not evicted: at least
   *   the time between two checks of all courses.
   */
  constructor(
    private readonly app: ServerAPI,
    private readonly inUseMs = IN_USE_MS
  ) {
    this.unsubscribe = app.onPropertyValues(CHART_TILES_PROPERTY, (history) => {
      const latest = new Map<string, unknown>()
      for (const entry of history) {
        if (entry) latest.set(entry.setter, entry.value)
      }
      this.providers = new Map(
        [...latest].filter((pair): pair is [string, ChartTiles] => isChartTiles(pair[1]))
      )
      // A provider that came or went may change what a tile reads as, and
      // one that came may bring charts the list did not have.
      this.clear()
      void this.refresh()
    })
  }

  async refresh(now = Date.now()): Promise<void> {
    let charts: Chart[]
    // The list comes from other plugins: anything in it that is not a chart
    // is skipped, and nothing it holds may make this reject.
    try {
      const resources: unknown = await this.app.resourcesApi.listResources('charts', {})
      charts =
        typeof resources === 'object' && resources !== null
          ? Object.entries(resources).flatMap(([id, chart]) =>
              typeof chart === 'object' && chart !== null
                ? (chartOf(id, chart as ChartResource) ?? [])
                : []
            )
          : []
    } catch (err) {
      this.app.debug(`Could not list charts: ${String(err)}`)
      return
    }
    // A refresh still running at stop() brings no charts back.
    if (this.stopped) return
    if (
      JSON.stringify(charts) !== JSON.stringify(this.charts) ||
      now - this.clearedAt > TILE_TTL_MS
    ) {
      this.charts = charts
      this.clear(now)
    }
  }

  stop(): void {
    this.unsubscribe()
    this.stopped = true
    this.charts = []
    this.clear()
  }

  /**
   * The stretches of land a straight course from `from` to `to` crosses with
   * charted water on either side, in order, or undefined while the charts
   * for it are still loading. Land at either end, or next to waters no chart
   * covers, does not count: a boat charted on land is where a chart is wrong
   * or too coarse, not behind land, and land reaching past the end may not
   * end in water. Only the first 20 km of the course are read.
   */
  landRuns(from: LatLon, to: LatLon, now = Date.now()): LandRun[] | undefined {
    // Without a provider no tile can come, so there is nothing to wait for.
    if (this.providers.size === 0) return []
    // A tile that cannot be read must not stop the alarms: it shows no land.
    try {
      return this.scan(from, to, now)
    } catch (err) {
      this.report('', err instanceof Error ? err.message : String(err))
      return []
    }
  }

  /**
   * Whether the charts show land at a point, as `landRuns` counts it, or
   * undefined while its tiles are still loading.
   */
  onLand(at: LatLon, now = Date.now()): boolean | undefined {
    if (this.providers.size === 0) return false
    try {
      const ground = this.groundAt(at, now, new Map())
      return ground === 'loading' ? undefined : ground === 'land'
    } catch (err) {
      this.report('', err instanceof Error ? err.message : String(err))
      return undefined
    }
  }

  private scan(from: LatLon, to: LatLon, now: number): LandRun[] | undefined {
    const lat0 = from.latitude * DEG
    const dLon = wrap(to.longitude - from.longitude)
    const dx = dLon * DEG * Math.cos(lat0) * EARTH_RADIUS
    const dy = (to.latitude - from.latitude) * DEG * EARTH_RADIUS
    const length = Math.hypot(dx, dy)
    const read = Math.min(length, MAX_POINTS * STEP)
    const points = Math.ceil(read / STEP)
    if (points < 2) return []
    const step = read / points
    const memo = new Map<string, Tile>()
    const grounds: Ground[] = []
    for (let i = 0; i <= points; i++) {
      const f = (i * step) / length
      const point = {
        latitude: from.latitude + f * (to.latitude - from.latitude),
        longitude: wrap(from.longitude + f * dLon)
      }
      grounds.push(this.groundAt(point, now, memo))
    }
    if (grounds.includes('loading')) return undefined
    // A run is measured from its first land point to its last, so it is
    // never longer than the land between them.
    const runs: LandRun[] = []
    let before: Ground | undefined
    let run: LandRun | undefined
    grounds.forEach((ground, i) => {
      if (ground === 'land') {
        if (before === 'water') run = { start: i * step, length: 0 }
        if (run) run.length = i * step - run.start
      } else if (ground === 'water' && run) {
        runs.push(run)
      }
      if (ground !== 'land') run = undefined
      before = ground
    })
    return runs
  }

  private groundAt(point: LatLon, now: number, memo: Map<string, Tile>): Ground {
    let land = false
    let loading = false
    // A chart that could not be read may show water here.
    let unread = false
    for (const chart of this.charts) {
      if (!covers(chart, point)) continue
      const [fx, fy] = tileXY(point, chart.zoom)
      const x = Math.floor(fx)
      const y = Math.floor(fy)
      const tile = this.tile(chart, x, y, now, memo)
      if (tile.state === 'loading') {
        loading = true
        continue
      }
      if (tile.state === 'failed') unread = true
      if (tile.state !== 'loaded') continue
      const inside = (layer: Layer) =>
        inLayer(layer, (fx - x) * layer.extent, (fy - y) * layer.extent)
      // Charts can disagree on a coastline; where any shows water, a boat
      // may well be able to pass.
      if (tile.water.some(inside)) return 'water'
      if (tile.land.some(inside)) land = true
    }
    return loading ? 'loading' : land && !unread ? 'land' : 'unknown'
  }

  private tile(chart: Chart, x: number, y: number, now: number, memo: Map<string, Tile>): Tile {
    const key = `${chart.id}/${chart.zoom}/${x}/${y}`
    const memoised = memo.get(key)
    if (memoised) return memoised
    let entry = this.tiles.get(key)
    if (entry?.tile.state === 'failed' && now >= entry.tile.retryAt) entry = undefined
    if (entry) {
      entry.usedAt = now
      this.tiles.delete(key)
      this.tiles.set(key, entry)
    } else {
      entry = { tile: { state: 'loading' }, usedAt: now }
      this.tiles.set(key, entry)
      if (!this.stopped) this.queue.push({ entry, chart, x, y })
      this.evict(now)
      this.pump()
    }
    memo.set(key, entry.tile)
    return entry.tile
  }

  private evict(now: number): void {
    for (const [key, entry] of this.tiles) {
      if (this.tiles.size <= MAX_TILES) return
      if (entry.tile.state !== 'loading' && now - entry.usedAt >= this.inUseMs) {
        this.tiles.delete(key)
      }
    }
  }

  private clear(now = Date.now()): void {
    this.tiles = new Map()
    this.queue = []
    this.clearedAt = now
  }

  private pump(): void {
    while (this.reading < PARALLEL_READS && this.queue.length > 0) {
      const next = this.queue.shift()
      if (next) void this.load(next)
    }
  }

  /** Reads a tile into its entry; one cleared meanwhile is read into nothing. */
  private async load({ entry, chart, x, y }: { entry: Entry; chart: Chart; x: number; y: number }) {
    this.reading++
    try {
      const body = await withTimeout(this.read(chart, x, y), READ_TIMEOUT_MS)
      if (body === undefined) {
        // No provider has the chart, perhaps not yet: one is starting.
        entry.tile = { state: 'failed', retryAt: Date.now() + RETRY_MS }
      } else {
        const layers = body && tileLayers(body, [LAND, ...WATER])
        const land = layers?.get(LAND)
        entry.tile = layers
          ? {
              state: 'loaded',
              land: land ? [land] : [],
              water: WATER.flatMap((name) => layers.get(name) ?? [])
            }
          : { state: 'none' }
        this.reported.delete(chart.id)
      }
    } catch (err) {
      this.report(chart.id, err instanceof Error ? err.message : String(err))
      entry.tile = { state: 'failed', retryAt: Date.now() + RETRY_MS }
    } finally {
      this.reading--
    }
    this.pump()
  }

  /** The tile body, null where its provider has none, undefined when no provider has the chart. */
  private async read(chart: Chart, x: number, y: number): Promise<Uint8Array | null | undefined> {
    for (const provider of this.providers.values()) {
      const body = await provider.getTile(chart.id, chart.zoom, x, y)
      if (body !== undefined) return body
    }
    return undefined
  }

  private report(chart: string, reason: string): void {
    const reported = this.reported.get(chart) ?? new Set()
    this.reported.set(chart, reported)
    if (reported.has(reason)) return
    reported.add(reason)
    this.app.error(
      chart
        ? `Could not read chart ${chart} to check courses across land: ${reason}`
        : `Could not check a course across land: ${reason}`
    )
  }
}
