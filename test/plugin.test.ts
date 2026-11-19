import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerAPI } from '@signalk/server-api'
import createPlugin from '../src/index.js'
import { sentValue, type HandleMessage } from './helpers.js'

const SELF = 'urn:mrn:imo:mmsi:111111111'
const OTHER = 'urn:mrn:imo:mmsi:222222222'

function nav(lat: number, cogDeg: number, sog: number) {
  const timestamp = new Date().toISOString()
  return {
    position: { value: { latitude: lat, longitude: 1 }, timestamp },
    courseOverGroundTrue: { value: (cogDeg * Math.PI) / 180, timestamp },
    speedOverGround: { value: sog, timestamp }
  }
}

function fakeApp(managed: boolean) {
  const notifications = {
    getId: vi.fn(() => {
      if (!managed) throw new Error('disabled')
      return undefined
    }),
    raise: vi.fn(() => 'n1'),
    update: vi.fn(),
    clear: vi.fn()
  }
  const app = {
    selfId: SELF,
    notifications,
    debug: vi.fn(),
    error: vi.fn(),
    setPluginStatus: vi.fn(),
    registerPutHandler: vi.fn(),
    savePluginOptions: vi.fn(),
    emitPropertyValue: vi.fn(),
    handleMessage: vi.fn<HandleMessage>(),
    getSelfPath: vi.fn(() => nav(50, 0, 5)),
    getPath: vi.fn((path: string): unknown =>
      path === 'vessels'
        ? {
            [SELF]: { navigation: nav(50, 0, 5) },
            [OTHER]: { navigation: nav(50 + 1 / 60, 180, 5) }
          }
        : undefined
    )
  }
  return { app: app as unknown as ServerAPI, notifications, handleMessage: app.handleMessage }
}

describe('plugin', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts with an empty config and raises through the Notifications API', async () => {
    const { app, notifications, handleMessage } = fakeApp(true)
    const plugin = createPlugin(app)
    plugin.start({}, () => undefined)
    vi.advanceTimersByTime(2000)
    expect(notifications.raise).toHaveBeenCalledOnce()
    expect(handleMessage).toHaveBeenCalledWith(
      'collision-alerts',
      expect.objectContaining({ context: `vessels.${OTHER}` })
    )
    await plugin.stop()
    expect(notifications.clear).toHaveBeenCalledWith('n1')
    expect(sentValue(handleMessage, -1)).toEqual({
      path: 'navigation.closestApproach',
      value: null
    })
  })

  it('falls back to notification deltas when the server does not manage notifications', async () => {
    const { app, notifications, handleMessage } = fakeApp(false)
    const plugin = createPlugin(app)
    plugin.start({ publishClosestApproach: false }, () => undefined)
    vi.advanceTimersByTime(2000)
    expect(notifications.raise).not.toHaveBeenCalled()
    // The first delta publishes that alarms are not paused.
    expect(sentValue(handleMessage, 1).path).toBe(
      `notifications.navigation.closestApproach.${OTHER}`
    )
    await plugin.stop()
  })

  it('tells other plugins it is running until it stops', async () => {
    const { app } = fakeApp(true)
    const plugin = createPlugin(app)
    plugin.start({}, () => undefined)
    expect(app.emitPropertyValue).toHaveBeenLastCalledWith('collisionAlerts', {
      evaluatesTargets: true
    })
    await plugin.stop()
    expect(app.emitPropertyValue).toHaveBeenLastCalledWith('collisionAlerts', {
      evaluatesTargets: false
    })
  })

  it('withdraws the announcement even when a clear fails on stop', async () => {
    const { app, handleMessage } = fakeApp(true)
    const plugin = createPlugin(app)
    plugin.start({}, () => undefined)
    vi.advanceTimersByTime(2000)
    handleMessage.mockImplementation(() => {
      throw new Error('send failed')
    })
    await expect(async () => plugin.stop()).rejects.toThrow('send failed')
    expect(app.emitPropertyValue).toHaveBeenLastCalledWith('collisionAlerts', {
      evaluatesTargets: false
    })
  })

  it('keeps raising alarms when the server refuses the announcement', async () => {
    const { app, notifications } = fakeApp(true)
    vi.mocked(app.emitPropertyValue).mockImplementation(() => {
      throw new Error('Max PropertyValues count 1000 exceeded')
    })
    const plugin = createPlugin(app)
    plugin.start({}, () => undefined)
    vi.advanceTimersByTime(2000)
    expect(notifications.raise).toHaveBeenCalledOnce()
    expect(app.error).toHaveBeenCalledWith(expect.stringContaining('Max PropertyValues'))
    await plugin.stop()
    expect(notifications.clear).toHaveBeenCalledWith('n1')
  })

  it('emits nothing on a stop without a start', async () => {
    const { app } = fakeApp(true)
    await createPlugin(app).stop()
    expect(app.emitPropertyValue).not.toHaveBeenCalled()
  })
})

describe('plugin publishing navigation.closestApproach', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('skips a target with no new report until the refresh', async () => {
    const { app, handleMessage } = fakeApp(true)
    // One report each, kept for every evaluation.
    const ownNav = nav(50, 0, 5)
    const otherNav = nav(50 + 1 / 60, 180, 5)
    vi.mocked(app.getSelfPath).mockImplementation(() => ownNav)
    vi.mocked(app.getPath).mockImplementation((path: string): unknown =>
      path === 'vessels' ? { [OTHER]: { navigation: otherNav } } : undefined
    )
    const closestApproaches = () =>
      handleMessage.mock.calls.filter(
        (_, i) => sentValue(handleMessage, i).path === 'navigation.closestApproach'
      ).length
    const plugin = createPlugin(app)
    plugin.start({}, () => undefined)
    // Evaluated at 2, 4, …, 10 s: published at 2 s, refreshed at 12 s.
    vi.advanceTimersByTime(10_000)
    expect(closestApproaches()).toBe(1)
    vi.advanceTimersByTime(2000)
    expect(closestApproaches()).toBe(2)
    await plugin.stop()
  })
})

describe('plugin at anchor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not take own ship yawing in a gust for motion towards a neighbour', async () => {
    const { app, notifications } = fakeApp(true)
    // Own GPS reports 0.9 kn straight at the neighbour 60 m north, lying still.
    vi.mocked(app.getSelfPath).mockImplementation(() => nav(50, 0, 0.46))
    vi.mocked(app.getPath).mockImplementation((path: string): unknown =>
      path === 'vessels' ? { [OTHER]: { navigation: nav(50 + 60 / 1852 / 60, 0, 0) } } : undefined
    )
    const plugin = createPlugin(app)
    plugin.start({}, () => undefined)
    vi.advanceTimersByTime(300_000)
    expect(notifications.raise).not.toHaveBeenCalled()
    await plugin.stop()
  })
})

describe('plugin at a berth', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // We lie still; a boat 1400 m north heads straight for us at 5 m/s: CPA 0
  // in 280 s, a Coastal alarm and a Harbour warning.
  const raised = async (
    state: string,
    config: object = { whileMoored: 'harbour' },
    ownSpeed = 0
  ) => {
    const { app, notifications } = fakeApp(true)
    vi.mocked(app.getSelfPath).mockImplementation((path: string) =>
      path === 'navigation.state' ? { value: state } : nav(50, 0, ownSpeed)
    )
    vi.mocked(app.getPath).mockImplementation((path: string): unknown =>
      path === 'vessels'
        ? { [OTHER]: { navigation: nav(50 + 1400 / 1852 / 60, 180, 5) } }
        : undefined
    )
    const plugin = createPlugin(app)
    plugin.start(config, () => undefined)
    vi.advanceTimersByTime(2000)
    await plugin.stop()
    return notifications.raise
  }

  it('judges a boat by the Harbour limits while moored', async () => {
    expect(await raised('moored')).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ state: 'warn' })
    )
  })

  it('keeps the normal limits while moored unless told to read moored as a berth', async () => {
    expect(await raised('moored', { whileMoored: 'normal' })).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ state: 'alarm' })
    )
  })

  it('reads the old Harbour-limits switch and saves it as whileMoored', async () => {
    const { app, notifications } = fakeApp(true)
    vi.mocked(app.getSelfPath).mockImplementation((path: string) =>
      path === 'navigation.state' ? { value: 'moored' } : nav(50, 0, 0)
    )
    vi.mocked(app.getPath).mockImplementation((path: string): unknown =>
      path === 'vessels'
        ? { [OTHER]: { navigation: nav(50 + 1400 / 1852 / 60, 180, 5) } }
        : undefined
    )
    const plugin = createPlugin(app)
    plugin.start({ maxRange: 2, harbourLimitsWhenMoored: true }, () => undefined)
    vi.advanceTimersByTime(2000)
    await plugin.stop()
    expect(notifications.raise).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ state: 'warn' })
    )
    expect(app.savePluginOptions).toHaveBeenCalledExactlyOnceWith(
      { maxRange: 2, whileMoored: 'harbour' },
      expect.any(Function)
    )
  })

  it('keeps the normal limits at anchor', async () => {
    expect(await raised('anchored')).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ state: 'alarm' })
    )
  })

  it('raises nothing while moored when told so', async () => {
    expect(await raised('moored', { whileMoored: 'silent' })).not.toHaveBeenCalled()
  })

  it('still alarms while moored and silent if we are moving', async () => {
    expect(await raised('moored', { whileMoored: 'silent' }, 2)).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ state: 'alarm' })
    )
  })

  it('raises nothing at anchor when told so', async () => {
    expect(await raised('anchored', { whileAnchored: 'silent' })).not.toHaveBeenCalled()
  })

  it('still alarms at anchor when only moored is quiet', async () => {
    expect(await raised('anchored', { whileMoored: 'silent' })).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ state: 'alarm' })
    )
  })
})

describe('plugin with edited limits', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // The boat of the berth tests: CPA 0 in 280 s while we lie still.
  const raised = async (config: object, state = 'moored') => {
    const { app, notifications } = fakeApp(true)
    vi.mocked(app.getSelfPath).mockImplementation((path: string) =>
      path === 'navigation.state' ? { value: state } : nav(50, 0, 0)
    )
    vi.mocked(app.getPath).mockImplementation((path: string): unknown =>
      path === 'vessels'
        ? { [OTHER]: { navigation: nav(50 + 1400 / 1852 / 60, 180, 5) } }
        : undefined
    )
    const plugin = createPlugin(app)
    plugin.start(config, () => undefined)
    vi.advanceTimersByTime(2000)
    await plugin.stop()
    return notifications.raise
  }

  it('judges by the edited zones of the chosen sensitivity', async () => {
    const coastal = { alarmMinutes: 200 / 60 }
    expect(await raised({ coastal })).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ state: 'warn' })
    )
  })

  it('ignores the edited zones of another sensitivity', async () => {
    const offshore = { warnDistance: 10, warnMinutes: 0.1 }
    expect(await raised({ offshore })).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ state: 'alarm' })
    )
  })

  it('uses the edited Harbour zones while moored, whatever the sensitivity', async () => {
    const harbour = { warnMinutes: 200 / 60 }
    expect(
      await raised({ preset: 'offshore', harbour, whileMoored: 'harbour' })
    ).not.toHaveBeenCalled()
  })
})

describe('plugin in a silent region', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // A region around own ship at 50 N 1 E; the boat of the berth tests heads
  // for us at 5 m/s while we motor at 2 m/s.
  const region = {
    name: 'Home port',
    feature: {
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0.99, 49.99],
            [1.01, 49.99],
            [1.01, 50.01],
            [0.99, 50.01],
            [0.99, 49.99]
          ]
        ]
      }
    }
  }
  const run = async (silentRegions: string[]) => {
    const { app, notifications } = fakeApp(true)
    Object.assign(app, {
      resourcesApi: { getResource: vi.fn(() => Promise.resolve(region)) }
    })
    vi.mocked(app.getSelfPath).mockImplementation(() => nav(50, 0, 2))
    vi.mocked(app.getPath).mockImplementation((path: string): unknown =>
      path === 'vessels'
        ? { [OTHER]: { navigation: nav(50 + 1400 / 1852 / 60, 180, 5) } }
        : undefined
    )
    const plugin = createPlugin(app)
    plugin.start({ silentRegions }, () => undefined)
    await vi.advanceTimersByTimeAsync(2000)
    await plugin.stop()
    return { raise: notifications.raise, status: vi.mocked(app.setPluginStatus) }
  }

  it('raises nothing while we are inside, even under way', async () => {
    const { raise, status } = await run(['home'])
    expect(raise).not.toHaveBeenCalled()
    expect(status).toHaveBeenLastCalledWith('No alarms inside Home port')
  })

  it('alarms as usual with no region chosen', async () => {
    const { raise } = await run([])
    expect(raise).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ state: 'alarm' }))
  })
})

describe('plugin paused', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // The boat of the berth tests heads for us; we motor at 2 m/s.
  const setup = () => {
    const { app, notifications } = fakeApp(true)
    vi.mocked(app.getSelfPath).mockImplementation(() => nav(50, 0, 2))
    vi.mocked(app.getPath).mockImplementation((path: string): unknown =>
      path === 'vessels'
        ? { [OTHER]: { navigation: nav(50 + 1400 / 1852 / 60, 180, 5) } }
        : undefined
    )
    const plugin = createPlugin(app)
    plugin.start({}, () => undefined)
    const [[context, path, handler]] = vi.mocked(app.registerPutHandler).mock.calls
    const put = (value: unknown) => handler(context, path, value, () => undefined)
    return { app, notifications, plugin, path, put }
  }

  it('raises nothing for the pause time after a PUT of 1, then alarms again', async () => {
    const { app, notifications, plugin, path, put } = setup()
    expect(path).toBe('navigation.collisionAlerts.paused')
    expect(put(1)).toEqual({ state: 'COMPLETED', statusCode: 200 })
    vi.advanceTimersByTime(29 * 60_000)
    expect(notifications.raise).not.toHaveBeenCalled()
    expect(vi.mocked(app.setPluginStatus).mock.lastCall?.[0]).toMatch(/^Paused until \d\d:\d\d$/)
    vi.advanceTimersByTime(2 * 60_000)
    expect(notifications.raise).toHaveBeenCalledOnce()
    await plugin.stop()
  })

  it('resumes on a PUT of 0', async () => {
    const { notifications, plugin, put } = setup()
    put(1)
    vi.advanceTimersByTime(2000)
    put(0)
    vi.advanceTimersByTime(2000)
    expect(notifications.raise).toHaveBeenCalledOnce()
    await plugin.stop()
  })

  it('clears a raised alarm at once, not at the next check', async () => {
    const { notifications, plugin, put } = setup()
    vi.advanceTimersByTime(2000)
    expect(notifications.raise).toHaveBeenCalledOnce()
    put(1)
    expect(notifications.clear).toHaveBeenCalledOnce()
    await plugin.stop()
  })

  it('refuses anything but 1 or 0', async () => {
    const { plugin, put } = setup()
    expect(put(true)).toMatchObject({ statusCode: 400 })
    expect(put('2')).toMatchObject({ statusCode: 400 })
    await plugin.stop()
  })
})

describe('plugin with sensor targets', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('evaluates targets.* alongside the vessels', async () => {
    const { app, notifications } = fakeApp(true)
    const vessels = app.getPath('vessels')
    app.getPath = vi.fn((path: string): unknown =>
      path === 'targets' ? { 'radar:radar-0-17': { navigation: nav(50 - 1 / 60, 0, 10) } } : vessels
    )
    const plugin = createPlugin(app)
    plugin.start({}, () => undefined)
    vi.advanceTimersByTime(2000)
    expect(notifications.raise).toHaveBeenCalledTimes(2)
    await plugin.stop()
  })
})

describe('config schema', () => {
  const schemaWith = async (regions: Record<string, unknown>, chosen = ['gone']) => {
    const { app } = fakeApp(true)
    Object.assign(app, {
      readPluginOptions: () => ({ configuration: { silentRegions: chosen } }),
      resourcesApi: { listResources: vi.fn(() => Promise.resolve(regions)) }
    })
    const schema = createPlugin(app).schema as () => Promise<{
      dependencies: {
        preset: { oneOf: { properties: Record<string, { items?: unknown } | undefined> }[] }
      }
    }>
    return (await schema()).dependencies.preset.oneOf.map((branch) => branch.properties)
  }

  it('offers the server regions, and keeps a chosen one that is gone', async () => {
    for (const properties of await schemaWith({ h: { name: 'Home port' } })) {
      expect(properties.silentRegions?.items).toEqual({
        type: 'string',
        enum: ['h', 'gone'],
        enumNames: ['Home port', 'gone (not found)']
      })
    }
  })

  it('leaves out the region choice when the server has no regions', async () => {
    for (const properties of await schemaWith({}, [])) {
      expect(properties.silentRegions).toBeUndefined()
    }
  })

  it('declares the same defaults the plugin applies at runtime', async () => {
    const { ConfigSchema, DEFAULTS } = await import('../src/config.js')
    // The admin UI receives the schema as plain JSON, so compare it in that form.
    const properties = JSON.parse(JSON.stringify(ConfigSchema.properties)) as Partial<
      Record<string, { default?: unknown }>
    >
    for (const [key, value] of Object.entries(DEFAULTS)) {
      expect(properties[key]?.default).toEqual(value)
    }
  })
})
