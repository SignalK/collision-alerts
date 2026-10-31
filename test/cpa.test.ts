import { describe, expect, it } from 'vitest'
import { computeCpa } from '../src/cpa.js'

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

  it('tells a target crossing ahead from one crossing astern', () => {
    const own = { position: { latitude: 50, longitude: 1 }, cog: 0, sog: 5 }
    // A target 1 NM west heading east at our speed crosses our track ahead of
    // us when it starts more than 1 NM north, astern when less.
    const crossing = (northNm: number) => ({
      position: { latitude: 50 + northNm / 60, longitude: 1 - 1 / 60 / Math.cos(50 * DEG) },
      cog: 90 * DEG,
      sog: 5
    })
    expect(computeCpa(own, crossing(1.4)).ahead).toBeCloseTo(0.2 * 1852, -1)
    expect(computeCpa(own, crossing(0.6)).ahead).toBeCloseTo(-0.2 * 1852, -1)
    expect(computeCpa({ ...own, sog: 0 }, crossing(0.6)).ahead).toBe(0)
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
