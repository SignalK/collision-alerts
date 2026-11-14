import { describe, expect, it } from 'vitest'
import { computeCpa } from '../src/cpa.js'
import { defined } from './helpers.js'

const DEG = Math.PI / 180
const KN = 1852 / 3600

describe('computeCpa', () => {
  it('finds a head-on collision', () => {
    // Target 2 NM due north, both closing at 10 kn: meet in 6 min.
    const r = computeCpa(
      { position: { latitude: 50, longitude: 1 }, cog: 0, sog: 10 * KN },
      { position: { latitude: 50 + 2 / 60, longitude: 1 }, cog: 180 * DEG, sog: 10 * KN }
    )
    expect(r.cpa).toBeLessThan(5)
    expect(r.tcpa).toBeCloseTo(360, -1)
    expect(r.range).toBeCloseTo(2 * 1852, -2)
    expect(r.relativeSpeed).toBeCloseTo(20 * KN, 6)
  })

  it('gives the true bearing of the target', () => {
    const own = { position: { latitude: 50, longitude: 1 }, cog: 0, sog: 0 }
    const at = (dLat: number, dLon: number) =>
      computeCpa(own, {
        position: { latitude: 50 + dLat, longitude: 1 + dLon },
        cog: 0,
        sog: 0
      }).bearing
    expect(at(0.01, 0)).toBeCloseTo(0, 6)
    expect(at(0, 0.01)).toBeCloseTo(90 * DEG, 6)
    expect(at(-0.01, 0)).toBeCloseTo(180 * DEG, 6)
    expect(at(0, -0.01)).toBeCloseTo(270 * DEG, 6)
  })

  it('tells two boats lying still that they keep their distance', () => {
    const r = computeCpa(
      { position: { latitude: 50, longitude: 1 }, cog: 0, sog: 0 },
      { position: { latitude: 50 + 0.05 / 60, longitude: 1 }, cog: 0, sog: 0 }
    )
    expect(r).toMatchObject({ tcpa: 0, keepingDistance: true })
    expect(r.cpa).toBeCloseTo(r.range, 6)
  })

  it('reports the miss distance of a crossing target', () => {
    // Own ship stationary; target 1 NM west of a point 1 NM north,
    // heading east: passes 1 NM north of us.
    const r = computeCpa(
      { position: { latitude: 0, longitude: 0 }, cog: 0, sog: 0 },
      { position: { latitude: 1 / 60, longitude: -1 / 60 }, cog: 90 * DEG, sog: 6 * KN }
    )
    expect(r.cpa).toBeCloseTo(1852, -1)
    expect(r.tcpa).toBeCloseTo(600, -1)
    expect(r.targetAtCpa.longitude).toBeCloseTo(0, 3)
  })

  it('finds where a target crosses our course line, ahead or astern', () => {
    const own = { position: { latitude: 50, longitude: 1 }, cog: 0, sog: 5 }
    // 1 NM west heading east at our speed: it reaches our line in 370 s, when
    // we have made 1 NM north.
    const crossing = (northNm: number) => ({
      position: { latitude: 50 + northNm / 60, longitude: 1 - 1 / 60 / Math.cos(50 * DEG) },
      cog: 90 * DEG,
      sog: 5
    })
    const ahead = defined(computeCpa(own, crossing(1.4)).bowCrossing)
    expect(ahead.distance).toBeCloseTo(0.4 * 1852, -1)
    expect(ahead.time).toBeCloseTo(1852 / 5, 0)
    expect(defined(computeCpa(own, crossing(0.6)).bowCrossing).distance).toBeCloseTo(
      -0.4 * 1852,
      -1
    )
  })

  it('finds no crossing for a boat on a parallel course, or while we are stopped', () => {
    const own = { position: { latitude: 50, longitude: 1 }, cog: 0, sog: 2.5 }
    // Coming the other way 40 m to starboard, as in a channel.
    const oncoming = {
      position: { latitude: 50 + 500 / 111_195, longitude: 1 + 40 / 71_474 },
      cog: 180 * DEG,
      sog: 2.5
    }
    expect(computeCpa(own, oncoming).bowCrossing).toBeNull()
    expect(computeCpa({ ...own, sog: 0 }, { ...oncoming, cog: 270 * DEG }).bowCrossing).toBeNull()
  })

  it('tells when a target already crossed', () => {
    const own = { position: { latitude: 50, longitude: 1 }, cog: 0, sog: 5 }
    // 200 m east of our line heading east: it crossed 100 s ago.
    const crossed = defined(
      computeCpa(own, {
        position: { latitude: 50 + 1000 / 111_195, longitude: 1 + 200 / 71_474 },
        cog: 90 * DEG,
        sog: 2
      }).bowCrossing
    )
    expect(crossed.time).toBeCloseTo(-100, 0)
  })

  it('reports a negative TCPA once the target has passed', () => {
    const r = computeCpa(
      { position: { latitude: 0, longitude: 0 }, cog: 0, sog: 0 },
      { position: { latitude: 0, longitude: 0.01 }, cog: 90 * DEG, sog: 5 }
    )
    expect(r.tcpa).toBeLessThan(0)
  })

  it('handles targets across the antimeridian', () => {
    const r = computeCpa(
      { position: { latitude: 0, longitude: 179.99 }, cog: 90 * DEG, sog: 5 },
      { position: { latitude: 0, longitude: -179.99 }, cog: 270 * DEG, sog: 5 }
    )
    expect(r.range).toBeLessThan(2500)
    expect(r.tcpa).toBeGreaterThan(0)
    expect(r.cpa).toBeLessThan(1)
  })

  it('keeps current range when there is no relative motion', () => {
    const r = computeCpa(
      { position: { latitude: 0, longitude: 0 }, cog: 0, sog: 3 },
      { position: { latitude: 0.01, longitude: 0 }, cog: 0, sog: 3 }
    )
    expect(r.tcpa).toBe(0)
    expect(r.cpa).toBeCloseTo(r.range, 6)
  })
})
