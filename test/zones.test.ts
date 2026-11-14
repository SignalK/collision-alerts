import { describe, expect, it } from 'vitest'
import { PASSING_DISTANCE, PRESETS, assess, assessPassage } from '../src/zones.js'

const zones = PRESETS.coastal // warn 926 m / 720 s, alarm 463 m / 360 s

describe('assess', () => {
  it('raises the highest matching level', () => {
    expect(assess(zones, 400, 300, undefined)).toBe('alarm')
    expect(assess(zones, 800, 300, undefined)).toBe('warn')
    expect(assess(zones, 400, 600, undefined)).toBe('warn')
    expect(assess(zones, 2000, 300, undefined)).toBeUndefined()
  })

  it('never raises for a target that has already passed', () => {
    expect(assess(zones, 10, -5, undefined)).toBeUndefined()
  })

  it('holds a raised level while the target hovers just outside the zone', () => {
    expect(assess(zones, 950, 300, undefined)).toBeUndefined()
    expect(assess(zones, 950, 300, 'warn')).toBe('warn')
    expect(assess(zones, 1200, 300, 'warn')).toBeUndefined()
  })

  it('steps down to the lower level rather than clearing outright', () => {
    expect(assess(zones, 700, 300, 'alarm')).toBe('warn')
  })

  it('holds briefly after closest approach, then clears', () => {
    expect(assess(zones, 100, -10, 'alarm')).toBe('alarm')
    expect(assess(zones, 100, -60, 'alarm')).toBeUndefined()
  })

  it('does not let a held lower level mask an escalation', () => {
    expect(assess(zones, 300, 200, 'warn')).toBe('alarm')
  })
})

describe('assessPassage', () => {
  const harbour = PRESETS.harbour // warn 100 m / 300 s, alarm 50 m / 120 s
  const passing = PASSING_DISTANCE.harbour // 15 m
  const passage = (cpa: number, tcpa: number, distance?: number, time = tcpa) => ({
    cpa,
    tcpa,
    bowCrossing: distance === undefined ? null : { distance, time }
  })

  it('stays quiet for a boat passing on either side without crossing ahead', () => {
    expect(assessPassage(harbour, passing, passage(40, 60), undefined)).toBeUndefined()
    expect(assessPassage(harbour, passing, passage(40, 60, -60), undefined)).toBeUndefined()
  })

  it('raises for a boat that would come within the passing distance', () => {
    expect(assessPassage(harbour, passing, passage(10, 60), undefined)).toBe('alarm')
    expect(assessPassage(harbour, passing, passage(10, 200), undefined)).toBe('warn')
  })

  it('raises by how far ahead of the bow a boat crosses', () => {
    expect(assessPassage(harbour, passing, passage(30, 70, 40, 60), undefined)).toBe('alarm')
    expect(assessPassage(harbour, passing, passage(60, 70, 80, 60), undefined)).toBe('warn')
    expect(assessPassage(harbour, passing, passage(100, 70, 150, 60), undefined)).toBeUndefined()
  })

  it('holds, but never raises, a level while the crossing swings astern', () => {
    expect(assessPassage(harbour, passing, passage(30, 70, -40, 60), 'warn')).toBe('warn')
    expect(assessPassage(harbour, passing, passage(30, 70, -40, 60), 'alarm')).toBe('alarm')
    expect(assessPassage(harbour, passing, passage(30, 70, -200, 60), 'alarm')).toBeUndefined()
  })

  it('clears once the boat turns parallel', () => {
    expect(assessPassage(harbour, passing, passage(40, 60), 'alarm')).toBeUndefined()
  })
})
