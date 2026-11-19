import { describe, expect, it, vi } from 'vitest'
import type { ServerAPI } from '@signalk/server-api'
import { regionChoices, SilentRegions } from '../src/regions.js'

// A 0.01° square around 42.275 N 8.735 W with a 0.002° hole in its middle.
const square = [
  [-8.74, 42.27],
  [-8.73, 42.27],
  [-8.73, 42.28],
  [-8.74, 42.28],
  [-8.74, 42.27]
]
const hole = [
  [-8.736, 42.274],
  [-8.734, 42.274],
  [-8.734, 42.276],
  [-8.736, 42.276],
  [-8.736, 42.274]
]
const harbour = {
  name: 'Harbour',
  feature: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [square, hole] } }
}

const fakeApp = (regions: Record<string, unknown>) => {
  const app = {
    error: vi.fn(),
    debug: vi.fn(),
    resourcesApi: {
      getResource: vi.fn((_type: string, id: string) =>
        id in regions ? Promise.resolve(regions[id]) : Promise.reject(new Error('not found'))
      ),
      listResources: vi.fn(() => Promise.resolve(regions))
    }
  }
  return app as unknown as ServerAPI & { resourcesApi: typeof app.resourcesApi }
}

const at = (latitude: number, longitude: number) => ({ latitude, longitude })

describe('SilentRegions', () => {
  it('finds a position inside a chosen region but not in its hole', async () => {
    const regions = new SilentRegions(fakeApp({ h: harbour }), ['h'])
    await regions.refresh()
    expect(regions.containing(at(42.272, -8.738))).toBe('Harbour')
    expect(regions.containing(at(42.275, -8.735))).toBeUndefined()
    expect(regions.containing(at(42.29, -8.735))).toBeUndefined()
  })

  it('reads a MultiPolygon', async () => {
    const multi = {
      name: 'Two basins',
      feature: { geometry: { type: 'MultiPolygon', coordinates: [[hole], [square]] } }
    }
    const regions = new SilentRegions(fakeApp({ m: multi }), ['m'])
    await regions.refresh()
    expect(regions.containing(at(42.272, -8.738))).toBe('Two basins')
  })

  it('drops a region that can no longer be read', async () => {
    const stored: Record<string, unknown> = { h: harbour }
    const app = fakeApp(stored)
    const regions = new SilentRegions(app, ['h'])
    await regions.refresh()
    delete stored.h
    await regions.refresh()
    expect(regions.containing(at(42.272, -8.738))).toBeUndefined()
    expect(app.error).toHaveBeenCalledOnce()
  })
})

describe('regionChoices', () => {
  it('lists the server regions by name and keeps a chosen one that is gone', async () => {
    expect(await regionChoices(fakeApp({ h: harbour }), ['gone'])).toEqual({
      enum: ['h', 'gone'],
      enumNames: ['Harbour', 'gone (not found)']
    })
  })

  it('offers no choices when there are no regions', async () => {
    expect(await regionChoices(fakeApp({}), [])).toBeUndefined()
  })
})
