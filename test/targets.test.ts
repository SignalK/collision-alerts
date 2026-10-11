import { describe, expect, it } from 'vitest'
import type { AlarmSink, CollisionAlert } from '../src/alarms.js'
import { Evaluator, toTrack, type VesselNode } from '../src/evaluator.js'
import { targetNodes, type SensorTargetNode } from '../src/targets.js'
import { PRESETS } from '../src/zones.js'
import { defined } from './helpers.js'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const VESSEL = 'urn:mrn:imo:mmsi:244060000'
const RADAR = 'radar:radar-0-17'

/** A boat `nm` NM north of own ship, coming straight at it, last seen `ageMs` ago. */
function boat(nm: number, ageMs = 2000): VesselNode {
  const timestamp = new Date(NOW - ageMs).toISOString()
  return {
    navigation: {
      position: { value: { latitude: 50 + nm / 60, longitude: 1 }, timestamp },
      courseOverGroundTrue: { value: Math.PI, timestamp },
      speedOverGround: { value: 5, timestamp }
    }
  }
}

const linked = (node: VesselNode, sameAs: string): SensorTargetNode => ({
  ...node,
  sameAs: { value: sameAs }
})

const timestamp = new Date(NOW - 2000).toISOString()
const own = defined(
  toTrack(
    {
      navigation: {
        position: { value: { latitude: 50, longitude: 1 }, timestamp },
        courseOverGroundTrue: { value: 0, timestamp },
        speedOverGround: { value: 5, timestamp }
      }
    },
    NOW,
    360
  )
)

function evaluate(vessels: Record<string, VesselNode>, targets?: Record<string, SensorTargetNode>) {
  const raised: Array<[string, CollisionAlert | undefined]> = []
  const sink: AlarmSink = {
    set: (id, alert) => raised.push([id, alert]),
    clearAll: () => undefined
  }
  const evaluations = new Evaluator(
    {
      zones: PRESETS.coastal,
      slowZones: PRESETS.harbour,
      slowSpeed: 0,
      maxRange: 12 * 1852,
      maxAge: 360
    },
    sink
  ).evaluate(own, targetNodes(vessels, targets, NOW), 'self', NOW)
  return { raised, evaluations }
}

describe('evaluating AIS vessels and sensor targets', () => {
  it('raises one alarm for a boat seen on AIS and radar, pointing at the AIS vessel', () => {
    const { raised, evaluations } = evaluate(
      { [VESSEL]: { ...boat(1), name: 'Nordic Star' } },
      { [RADAR]: linked(boat(1.01), `vessels.${VESSEL}`) }
    )
    expect(raised).toHaveLength(1)
    const [id, alert] = raised[0]
    expect(id).toBe(VESSEL)
    expect(alert?.message).toContain('Nordic Star')
    expect(alert?.data).toMatchObject({
      targetRef: `vessels.${VESSEL}`,
      source: 'ais',
      sources: ['ais', 'radar']
    })
    expect(evaluations.map((e) => e.context)).toEqual([`vessels.${VESSEL}`])
  })

  it('points a radar-only alarm at the radar target and publishes on its context', () => {
    const { raised, evaluations } = evaluate({}, { [RADAR]: boat(1) })
    const [id, alert] = raised[0]
    expect(id).toBe(RADAR)
    expect(alert?.message).toContain('radar target radar-0-17')
    expect(alert?.data).toMatchObject({ targetRef: `targets.${RADAR}`, source: 'radar' })
    expect(evaluations[0].context).toBe(`targets.${RADAR}`)
  })

  it('follows radar when the AIS vessel it is linked to falls silent', () => {
    const { raised } = evaluate(
      { [VESSEL]: boat(3, 20 * 60_000) },
      { [RADAR]: linked(boat(1), `vessels.${VESSEL}`) }
    )
    expect(raised.map(([id]) => id)).toEqual([VESSEL])
  })

  it('folds a camera target into the radar target that names a boat without AIS', () => {
    const { raised } = evaluate(
      {},
      { [RADAR]: boat(1), 'camera:bow-7': linked(boat(1.01), `targets.${RADAR}`) }
    )
    expect(raised).toHaveLength(1)
    expect(raised[0][1]?.data).toMatchObject({ sources: ['radar', 'camera'] })
  })

  it('keeps a target linked to a vessel that is gone as an object of its own', () => {
    const { raised } = evaluate({}, { [RADAR]: linked(boat(1), `vessels.${VESSEL}`) })
    expect(raised.map(([id]) => id)).toEqual([RADAR])
  })

  it('follows a chain of links to the vessel at its end', () => {
    const { raised } = evaluate(
      { [VESSEL]: boat(1) },
      {
        [RADAR]: linked(boat(1.01), `vessels.${VESSEL}`),
        'camera:bow-7': linked(boat(1.02), `targets.${RADAR}`)
      }
    )
    expect(raised).toHaveLength(1)
    expect(raised[0][0]).toBe(VESSEL)
    expect(raised[0][1]?.data).toMatchObject({ sources: ['ais', 'radar', 'camera'] })
  })

  it('groups a chain that ends at a missing context under its last target', () => {
    const { raised } = evaluate(
      {},
      {
        [RADAR]: linked(boat(1), `vessels.${VESSEL}`),
        'camera:bow-7': linked(boat(1.01), `targets.${RADAR}`)
      }
    )
    expect(raised.map(([id]) => id)).toEqual([RADAR])
    expect(raised[0][1]?.data).toMatchObject({ sources: ['radar', 'camera'] })
  })

  it('raises one alarm for targets whose links form a loop', () => {
    const { raised } = evaluate(
      {},
      {
        [RADAR]: linked(boat(1), 'targets.camera:bow-7'),
        'camera:bow-7': linked(boat(1.01), `targets.${RADAR}`)
      }
    )
    expect(raised.map(([id]) => id)).toEqual(['camera:bow-7'])
  })

  it('does not treat inherited object properties as contexts', () => {
    const { raised } = evaluate({}, { [RADAR]: linked(boat(1), 'vessels.constructor') })
    expect(raised.map(([id]) => id)).toEqual([RADAR])
  })

  it('ignores a target whose track was lost', () => {
    const lost: SensorTargetNode = {
      navigation: { position: { value: null, timestamp } }
    }
    const { raised } = evaluate({}, { [RADAR]: lost })
    expect(raised).toHaveLength(0)
  })

  it('ignores a target its sensor stopped updating a minute ago', () => {
    const { raised } = evaluate({}, { [RADAR]: boat(1, 90_000) })
    expect(raised).toHaveLength(0)
  })

  it('places a boat by its AIS once the radar linked to it falls silent', () => {
    const { evaluations } = evaluate(
      { [VESSEL]: boat(3, 90_000) },
      { [RADAR]: linked(boat(1, 80_000), `vessels.${VESSEL}`) }
    )
    expect(evaluations[0].result?.range).toBeGreaterThan(2 * 1852)
  })
})
