import { describe, expect, it } from 'vitest'
import type { AlarmSink, CollisionAlert } from '../src/alarms.js'
import { Evaluator, toTrack, type EvaluatorOptions, type VesselNode } from '../src/evaluator.js'
import { PRESETS } from '../src/zones.js'
import { defined } from './helpers.js'

const NOW = Date.parse('2026-10-02T12:00:00Z')
const fresh = new Date(NOW - 5000).toISOString()

function vessel(lat: number, lon: number, cogDeg: number, sog: number, name?: string): VesselNode {
  return {
    name,
    navigation: {
      position: { value: { latitude: lat, longitude: lon }, timestamp: fresh },
      courseOverGroundTrue: { value: (cogDeg * Math.PI) / 180, timestamp: fresh },
      speedOverGround: { value: sog, timestamp: fresh }
    }
  }
}

class RecordingSink implements AlarmSink {
  calls: Array<[string, CollisionAlert | undefined]> = []
  cleared = false
  set(id: string, alert: CollisionAlert | undefined) {
    this.calls.push([id, alert])
  }
  clearAll() {
    this.cleared = true
  }
}

const own = defined(toTrack(vessel(50, 1, 0, 5), NOW, 360))
const SELF = 'urn:mrn:imo:mmsi:111111111'
const OTHER = 'urn:mrn:imo:mmsi:222222222'
const THIRD = 'urn:mrn:imo:mmsi:333333333'

function setup(options: Partial<EvaluatorOptions> = {}) {
  const sink = new RecordingSink()
  const ev = new Evaluator(
    {
      zones: PRESETS.coastal,
      slowZones: PRESETS.harbour,
      slowSpeed: 0,
      maxRange: 12 * 1852,
      maxAge: 360,
      ...options
    },
    sink
  )
  return { sink, ev }
}

describe('toTrack', () => {
  it('rejects stale positions', () => {
    const v = vessel(50, 1, 0, 5)
    defined(defined(v.navigation).position).timestamp = new Date(NOW - 400_000).toISOString()
    expect(toTrack(v, NOW, 360)).toBeNull()
  })

  it('treats a vessel below steerage speed as stationary even without COG', () => {
    const v = vessel(50, 1, 0, 0.05)
    delete defined(v.navigation).courseOverGroundTrue
    expect(toTrack(v, NOW, 360)).toMatchObject({ sog: 0 })
  })

  it('rejects a moving vessel without COG', () => {
    const v = vessel(50, 1, 0, 5)
    delete defined(v.navigation).courseOverGroundTrue
    expect(toTrack(v, NOW, 360)).toBeNull()
  })
})

describe('Evaluator', () => {
  it('raises an alarm for a closing target and names it', () => {
    const { sink, ev } = setup()
    // 1 NM ahead, coming straight at us at 5 m/s: TCPA ~185 s.
    ev.evaluate(own, { [OTHER]: vessel(50 + 1 / 60, 1, 180, 5, 'Nordic Star') }, SELF, NOW)
    const [id, alert] = sink.calls[0]
    expect(id).toBe(OTHER)
    expect(alert?.level).toBe('alarm')
    expect(alert?.message).toContain('Nordic Star')
    expect(alert?.data).toMatchObject({ targetRef: `vessels.${OTHER}`, source: 'ais' })
  })

  it('raises one alarm per closing target and clears each independently', () => {
    const { sink, ev } = setup()
    // One dead ahead, one on the starboard bow, both closing.
    const ahead = vessel(50 + 1 / 60, 1, 180, 5, 'Nordic Star')
    const starboard = vessel(50 + 1 / 60, 1 + 1 / 60, 225, 5, 'Baltic Wind')
    ev.evaluate(own, { [OTHER]: ahead, [THIRD]: starboard }, SELF, NOW)

    const raised = new Map(sink.calls)
    expect([...raised.keys()]).toEqual([OTHER, THIRD])
    expect(raised.get(OTHER)?.message).toContain('Nordic Star')
    expect(raised.get(OTHER)?.data.targetRef).toBe(`vessels.${OTHER}`)
    expect(raised.get(THIRD)?.message).toContain('Baltic Wind')
    expect(raised.get(THIRD)?.data.targetRef).toBe(`vessels.${THIRD}`)

    // The ship ahead drops out; the other keeps its alarm.
    sink.calls = []
    ev.evaluate(own, { [THIRD]: starboard }, SELF, NOW)
    expect(sink.calls).toContainEqual([OTHER, undefined])
    expect(sink.calls).toContainEqual([THIRD, expect.objectContaining({ level: 'alarm' })])
  })

  it('skips own ship', () => {
    const { sink, ev } = setup()
    const evaluations = ev.evaluate(own, { [SELF]: vessel(50, 1, 0, 5) }, SELF, NOW)
    expect(evaluations).toHaveLength(0)
    expect(sink.calls).toHaveLength(0)
  })

  it('clears the alarm when the target disappears', () => {
    const { sink, ev } = setup()
    ev.evaluate(own, { [OTHER]: vessel(50 + 1 / 60, 1, 180, 5) }, SELF, NOW)
    ev.evaluate(own, {}, SELF, NOW)
    expect(sink.calls.at(-1)).toEqual([OTHER, undefined])
  })

  it('clears every alarm when own ship data goes stale', () => {
    const { sink, ev } = setup()
    ev.evaluate(own, { [OTHER]: vessel(50 + 1 / 60, 1, 180, 5) }, SELF, NOW)
    ev.evaluate(null, { [OTHER]: vessel(50 + 1 / 60, 1, 180, 5) }, SELF, NOW)
    expect(sink.calls.at(-1)).toEqual([OTHER, undefined])
  })

  it('ignores targets beyond the range limit', () => {
    const { sink, ev } = setup()
    const evaluations = ev.evaluate(own, { [OTHER]: vessel(50 + 20 / 60, 1, 180, 20) }, SELF, NOW)
    expect(evaluations[0].result).toBeNull()
    expect(sink.calls).toHaveLength(0)
  })

  it('clears outstanding alarms on stop', () => {
    const { sink, ev } = setup()
    ev.stop()
    expect(sink.cleared).toBe(true)
  })

  it('uses the slow zones while own ship is slow, with a margin before leaving them', () => {
    // A boat at anchor 0.2 NM ahead, 150 m to starboard of our track: inside
    // the Coastal limits, outside the Harbour ones.
    const target = vessel(50 + 0.2 / 60, 1 + 150 / 1852 / 60 / Math.cos((50 * Math.PI) / 180), 0, 0)
    const at = (sog: number) => defined(toTrack(vessel(50, 1, 0, sog), NOW, 360))

    const normal = setup()
    normal.ev.evaluate(at(1), { [OTHER]: target }, SELF, NOW)
    expect(normal.sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])

    const { sink, ev } = setup({ slowSpeed: 1.5 })
    ev.evaluate(at(1), { [OTHER]: target }, SELF, NOW)
    expect(sink.calls).toHaveLength(0)
    // Just above the threshold the slow zones still hold.
    ev.evaluate(at(1.6), { [OTHER]: target }, SELF, NOW)
    expect(sink.calls).toHaveLength(0)
    ev.evaluate(at(2), { [OTHER]: target }, SELF, NOW)
    expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
  })

  it('keeps the normal zones for a fast target while own ship is slow', () => {
    const { sink, ev } = setup({ slowSpeed: 1.5 })
    const slowOwn = defined(toTrack(vessel(50, 1, 0, 1), NOW, 360))
    // A ship 2 NM ahead at 10 m/s, passing 300 m off: a Coastal alarm, no Harbour one.
    const ship = vessel(50 + 2 / 60, 1 + 300 / 1852 / 60 / Math.cos((50 * Math.PI) / 180), 180, 10)
    ev.evaluate(slowOwn, { [OTHER]: ship }, SELF, NOW)
    expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
  })
})
