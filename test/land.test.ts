import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PropertyValue, ServerAPI } from '@signalk/server-api'
import {
  CHART_TILES_PROPERTY,
  ChartLand,
  inLayer,
  tileLayers,
  tileXY,
  type ChartTiles,
  type LandRun
} from '../src/land.js'
import { bandTile, encodeTile, stripsTile } from './tiles.js'

// A band of land 0.004° (445 m) wide from 10° N, right across the chart, in
// tile row 7734 at zoom 14.
const SOUTH = 10
const NORTH = 10.004
const ROW = 7734
const METRES = (6371008.8 * Math.PI) / 180
const BAND = 0.004 * METRES

const enc = { type: 'S-57', minzoom: 8, maxzoom: 16, bounds: [19, 9, 21, 11] }

const at = (latitude: number, longitude = 20) => ({ latitude, longitude })

type Requests = [string, number, number, number][]

function band(
  options: Parameters<typeof bandTile>[4] = {},
  zip = false,
  chart = 'enc',
  requests: Requests = []
): ChartTiles {
  return {
    getTile: (chartId, z, x, y) => {
      requests.push([chartId, z, x, y])
      if (chartId !== chart) return Promise.resolve(undefined)
      const tile = bandTile(z, y, SOUTH, NORTH, options)
      return Promise.resolve(zip ? gzipSync(tile) : tile)
    }
  }
}

function fakeApp(charts: Record<string, unknown>) {
  const history: (PropertyValue | undefined)[] = [undefined]
  let listener: ((values: (PropertyValue | undefined)[]) => void) | undefined
  const app = {
    debug: vi.fn(),
    error: vi.fn(),
    resourcesApi: { listResources: vi.fn(() => Promise.resolve(charts)) },
    onPropertyValues: vi.fn((name: string, cb: (values: (PropertyValue | undefined)[]) => void) => {
      if (name !== CHART_TILES_PROPERTY) return () => undefined
      listener = cb
      cb([...history])
      return () => {
        listener = undefined
      }
    })
  }
  const emit = (setter: string, value: unknown) => {
    history.push({ timestamp: Date.now(), setter, name: CHART_TILES_PROPERTY, value })
    listener?.([...history])
  }
  return { app: app as unknown as ServerAPI, error: app.error, emit }
}

async function chartLand(charts: Record<string, unknown>, ...providers: ChartTiles[]) {
  const fake = fakeApp(charts)
  providers.forEach((provider, i) => {
    fake.emit(`provider${i}`, provider)
  })
  const land = new ChartLand(fake.app)
  await land.refresh()
  return { land, ...fake }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The land along a course once its tiles have loaded. */
async function runs(
  land: ChartLand,
  from: { latitude: number; longitude: number },
  to = from,
  now = Date.now()
): Promise<LandRun[] | undefined> {
  land.landRuns(from, to, now)
  await settle()
  return land.landRuns(from, to, now)
}

/** The single run across the band on a course from 9.995° N to 10.009° N. */
function expectBand(found: LandRun[] | undefined) {
  expect(found).toHaveLength(1)
  const [run] = found ?? []
  expect(run.start).toBeGreaterThan(0.005 * METRES - 20)
  expect(run.start).toBeLessThan(0.005 * METRES + 20)
  expect(run.length).toBeGreaterThan(BAND - 20)
  expect(run.length).toBeLessThan(BAND + 20)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('tileLayers', () => {
  it('reads the polygons of the named layers, gzipped or not', () => {
    const square: [number, number][] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100]
    ]
    const hole: [number, number][] = [
      [40, 40],
      [40, 60],
      [60, 60],
      [60, 40]
    ]
    const tile = encodeTile({ LNDARE: [[square, hole]], SOUNDG: [[square]] })
    for (const body of [tile, gzipSync(tile)]) {
      const layers = tileLayers(body, ['LNDARE', 'DEPARE'])
      expect([...layers.keys()]).toEqual(['LNDARE'])
      const layer = layers.get('LNDARE')
      expect(layer).toBeDefined()
      if (!layer) return
      expect(inLayer(layer, 20, 20)).toBe(true)
      expect(inLayer(layer, 50, 50)).toBe(false)
      expect(inLayer(layer, 150, 20)).toBe(false)
    }
  })
})

describe('tileXY', () => {
  it('finds the tiles a chart plotter shows', () => {
    // Nouméa, in the tile Freeboard requests at zoom 14.
    const [x, y] = tileXY(at(-22.2877, 166.4356), 14)
    expect([Math.floor(x), Math.floor(y)]).toEqual([15766, 9232])
  })
})

describe('ChartLand', () => {
  it('finds where a course crosses land with water on either side', async () => {
    const { land } = await chartLand({ enc }, band())
    // Undecided until the tiles have loaded.
    expect(land.landRuns(at(9.995), at(10.009))).toBeUndefined()
    expectBand(await runs(land, at(9.995), at(10.009)))
  })

  it('counts no land at either end of a course', async () => {
    const { land } = await chartLand({ enc }, band())
    expect(await runs(land, at(10.002), at(10.009))).toEqual([])
    expect(await runs(land, at(9.995), at(10.002))).toEqual([])
  })

  it('measures land from its first point to its last, never longer than it is', async () => {
    const narrow: ChartTiles = {
      getTile: (_chart, z, _x, y) =>
        Promise.resolve(
          stripsTile(z, y, {
            LNDARE: [[SOUTH, SOUTH + 142 / METRES]],
            DEPARE: [
              [9, SOUTH],
              [SOUTH + 142 / METRES, 11]
            ]
          })
        )
    }
    const { land } = await chartLand({ enc }, narrow)
    // However the points along the course fall on it.
    for (let shift = 0; shift < 10; shift++) {
      const from = at(9.995 + shift / METRES)
      const found = await runs(land, from, { ...from, latitude: from.latitude + 0.014 })
      expect(found).toHaveLength(1)
      expect(found?.[0].length).toBeLessThanOrEqual(142)
      expect(found?.[0].length).toBeGreaterThan(120)
    }
  })

  it('keeps its 10 m spacing on a long course, read for its first 20 km', async () => {
    // 190 m of land 5 km out, and more 25 km out, on a course of 136 km.
    const m = (metres: number) => SOUTH + metres / METRES
    const lands: ChartTiles = {
      getTile: (_chart, z, _x, y) =>
        Promise.resolve(
          stripsTile(z, y, {
            LNDARE: [
              [m(5000), m(5190)],
              [m(25000), m(25500)]
            ],
            DEPARE: [
              [9, m(5000)],
              [m(5190), m(25000)],
              [m(25500), 11]
            ]
          })
        )
    }
    const { land } = await chartLand({ enc }, lands)
    const from = at(SOUTH)
    const to = at(m(136_000))
    let found = land.landRuns(from, to)
    for (let i = 0; i < 20 && !found; i++) {
      await settle()
      found = land.landRuns(from, to)
    }
    expect(found).toHaveLength(1)
    expect(found?.[0].start).toBeCloseTo(5000, -1)
    expect(found?.[0].length).toBeGreaterThan(180)
  })

  it('breaks land at waters no chart covers', async () => {
    // Water, 80 m of land, 500 m nothing charted, 80 m of land, water.
    const m = (metres: number) => SOUTH + metres / METRES
    const islets: ChartTiles = {
      getTile: (_chart, z, _x, y) =>
        Promise.resolve(
          stripsTile(z, y, {
            LNDARE: [
              [m(0), m(80)],
              [m(580), m(660)]
            ],
            DEPARE: [
              [9, m(0)],
              [m(660), 11]
            ]
          })
        )
    }
    const { land } = await chartLand({ enc }, islets)
    expect(await runs(land, at(9.995), at(10.009))).toEqual([])
  })

  it('counts no land where a chart that covers it could not be read', async () => {
    const charts = { enc, other: enc }
    const unread: ChartTiles = {
      getTile: (chartId) =>
        chartId === 'other' ? Promise.reject(new Error('busy')) : Promise.resolve(undefined)
    }
    const { land } = await chartLand(charts, band(), unread)
    expect(await runs(land, at(9.995), at(10.009))).toEqual([])
  })

  it('takes a tile whose layer has no extent for one it could not read', async () => {
    const square: [number, number][] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100]
    ]
    expect(() => tileLayers(encodeTile({ DEPARE: [[square]] }, 0), ['DEPARE'])).toThrow('no extent')
    // So the water it may hold vetoes another chart's land.
    const charts = { enc, other: enc }
    const broken: ChartTiles = {
      getTile: (chartId) =>
        Promise.resolve(chartId === 'other' ? encodeTile({ DEPARE: [[square]] }, 0) : undefined)
    }
    const { land } = await chartLand(charts, band(), broken)
    expect(await runs(land, at(9.995), at(10.009))).toEqual([])
  })

  it('shows no land, and says so, where a course cannot be checked', async () => {
    const { land, error } = await chartLand({ enc }, band())
    vi.spyOn(land as unknown as { scan: () => never }, 'scan').mockImplementation(() => {
      throw new Error('bad geometry')
    })
    expect(land.landRuns(at(9.995), at(10.009))).toEqual([])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('bad geometry'))
  })

  it('counts no land without charted water on either side', async () => {
    const { land } = await chartLand({ enc }, band({ water: false }))
    expect(await runs(land, at(9.995), at(10.009))).toEqual([])
  })

  it('counts no land where another chart shows water', async () => {
    const charts = { enc, other: enc }
    const { land } = await chartLand(
      charts,
      band(),
      band({ layer: 'DEPARE', water: false }, false, 'other')
    )
    expect(await runs(land, at(9.995), at(10.009))).toEqual([])
  })

  it('reads gzipped tiles', async () => {
    const { land } = await chartLand({ enc }, band({}, true))
    expectBand(await runs(land, at(9.995), at(10.009)))
  })

  it('reads the tiles of zoom 14, and no chart that has none', async () => {
    const requests: Requests = []
    const { land } = await chartLand({ enc }, band({}, false, 'enc', requests))
    await runs(land, at(9.995), at(10.009))
    expect(requests).toEqual([['enc', 14, 9102, ROW]])
    const overview = await chartLand({ enc: { ...enc, maxzoom: 12 } }, band())
    expect(overview.land.landRuns(at(9.995), at(10.009))).toEqual([])
    // A chart that starts finer is read at its first zoom.
    const fine: Requests = []
    const harbour = await chartLand({ enc: { ...enc, minzoom: 15 } }, band({}, false, 'enc', fine))
    await runs(harbour.land, at(9.995), at(10.009))
    expect(new Set(fine.map(([, z]) => z))).toEqual(new Set([15]))
  })

  it('keeps tiles as long as it is told they are in use', async () => {
    const requests: Requests = []
    const fake = fakeApp({ enc: { ...enc, bounds: [19, 9, 30, 11] } })
    fake.emit('provider', band({}, false, 'enc', requests))
    const land = new ChartLand(fake.app, 60_000)
    await land.refresh()
    const now = Date.now()
    const course = async (i: number, time: number) => {
      const from = at(9.995, 19.001 + i * 0.022)
      await runs(land, from, { ...from, latitude: from.latitude + 0.001 }, time)
    }
    for (let i = 0; i < 300; i++) await course(i, now)
    await course(300, now + 20_000)
    await course(1, now + 20_000)
    expect(requests).toHaveLength(301)
  })

  it('keeps tiles in use, and evicts the longest unused beyond 256', async () => {
    const requests: Requests = []
    const wide = { ...enc, bounds: [19, 9, 30, 11] }
    const { land } = await chartLand({ enc: wide }, band({}, false, 'enc', requests))
    const now = Date.now()
    // A short course in each of 300 tiles along the parallel.
    const tile = (i: number) => at(9.995, 19.001 + i * 0.022)
    const course = async (i: number, time: number) => {
      const from = tile(i)
      await runs(land, from, { ...from, latitude: from.latitude + 0.001 }, time)
    }
    for (let i = 0; i < 300; i++) await course(i, now)
    expect(requests).toHaveLength(300)
    // All used within 5 s: none evicted.
    await course(0, now + 3000)
    expect(requests).toHaveLength(300)
    // A new tile later evicts the oldest unused ones, down to 256.
    await course(300, now + 20_000)
    await course(299, now + 20_000)
    expect(requests).toHaveLength(301)
    await course(1, now + 20_000)
    expect(requests).toHaveLength(302)
  })

  it('skips anything in the chart list that is not a chart', async () => {
    const { land } = await chartLand({ broken: null, odd: 'x', enc }, band())
    expectBand(await runs(land, at(9.995), at(10.009)))
    const fake = fakeApp({})
    fake.app.resourcesApi.listResources = vi.fn(() =>
      Promise.resolve(null as unknown as Record<string, unknown>)
    )
    await expect(new ChartLand(fake.app).refresh()).resolves.toBeUndefined()
  })

  it('reads only S-57 charts, and only where they have data', async () => {
    const raster = await chartLand({ enc: { ...enc, type: 'tilelayer' } }, band())
    expect(raster.land.landRuns(at(9.995), at(10.009))).toEqual([])
    const elsewhere = await chartLand({ enc: { ...enc, bounds: [21, 9, 22, 11] } }, band())
    expect(elsewhere.land.landRuns(at(9.995), at(10.009))).toEqual([])
  })

  it('reads a chart that spans the antimeridian, on a course across it', async () => {
    const { land } = await chartLand({ enc: { ...enc, bounds: [170, 9, -170, 11] } }, band())
    expectBand(await runs(land, at(9.995, 179.99), at(10.009, 179.99)))
    // Diagonally across 180°: the land is the same share of a longer course.
    const length = Math.hypot(0.014 * METRES, 0.01 * METRES * Math.cos((9.995 * Math.PI) / 180))
    const found = await runs(land, at(9.995, 179.995), at(10.009, -179.995))
    expect(found).toHaveLength(1)
    expect(found?.[0].length).toBeGreaterThan((length * 0.004) / 0.014 - 20)
    expect(found?.[0].length).toBeLessThan((length * 0.004) / 0.014 + 20)
  })

  it('knows no land without a chart provider, and reads the tiles once one comes', async () => {
    const { land, emit } = await chartLand({ enc })
    // At once: there is nothing to load.
    expect(land.landRuns(at(9.995), at(10.009))).toEqual([])
    emit('provider', band())
    expectBand(await runs(land, at(9.995), at(10.009)))
    // Withdrawn, as a provider does when it stops.
    emit('provider', null)
    expect(await runs(land, at(9.995), at(10.009))).toEqual([])
  })

  it('reads a tile again when its provider changes under a read', async () => {
    let release: (tile: Uint8Array) => void = () => undefined
    const slow: ChartTiles = {
      getTile: () =>
        new Promise((resolve) => {
          release = resolve
        })
    }
    const { land, emit } = await chartLand({ enc }, slow)
    land.landRuns(at(9.995), at(10.009))
    emit('provider0', band({ layer: 'DEPARE' }))
    release(bandTile(14, ROW, SOUTH, NORTH))
    await settle()
    expect(await runs(land, at(9.995), at(10.009))).toEqual([])
  })

  it('gives up a read after 5 s, and tries again a minute later', async () => {
    vi.useFakeTimers()
    const getTile = vi.fn<ChartTiles['getTile']>(() => new Promise(() => undefined))
    const { land, error } = await chartLand({ enc }, { getTile })
    const now = Date.now()
    expect(land.landRuns(at(9.995), at(10.009), now)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(5000)
    expect(land.landRuns(at(9.995), at(10.009), now + 5000)).toEqual([])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no tile within 5 s'))
    const reads = getTile.mock.calls.length
    land.landRuns(at(9.995), at(10.009), now + 5000 + 60_000)
    expect(getTile.mock.calls.length).toBeGreaterThan(reads)
  })

  it('reports a chart it cannot read once, and knows no land there', async () => {
    const broken: ChartTiles = { getTile: () => Promise.reject(new Error('disk gone')) }
    const { land, error } = await chartLand({ enc }, broken)
    expect(await runs(land, at(9.995), at(10.009))).toEqual([])
    expect(await runs(land, at(9.995), at(10.009))).toEqual([])
    expect(error).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('disk gone'))
  })

  it('reads the tiles afresh every 10 minutes, as a chart may be rebuilt', async () => {
    const requests: Requests = []
    const { land } = await chartLand({ enc }, band({}, false, 'enc', requests))
    const now = Date.now()
    await runs(land, at(9.995), at(10.009), now)
    const read = requests.length
    await land.refresh(now + 60_000)
    await runs(land, at(9.995), at(10.009), now + 60_000)
    expect(requests).toHaveLength(read)
    await land.refresh(now + 601_000)
    await runs(land, at(9.995), at(10.009), now + 601_000)
    expect(requests.length).toBeGreaterThan(read)
  })

  it('stops reading and listening for providers when stopped', async () => {
    const requests: Requests = []
    const { land, emit } = await chartLand({ enc })
    land.stop()
    emit('provider', band({}, false, 'enc', requests))
    expect(await runs(land, at(9.995), at(10.009))).toEqual([])
    expect(requests).toHaveLength(0)
  })
})
