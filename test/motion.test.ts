import { describe, expect, it } from 'vitest'
import { MotionCheck } from '../src/motion.js'

const T0 = Date.parse('2026-10-31T12:00:00Z')
const SECOND = 1000
// Metres to degrees of latitude.
const M = 1 / 111_195

function reported(northMetres: number, sog: number) {
  return { position: { latitude: 50 + northMetres * M, longitude: 1 }, sog, cog: 0 }
}

describe('MotionCheck', () => {
  it('stops a boat yawing at anchor that reports 0.9 kn', () => {
    const check = new MotionCheck()
    let track
    // Every 10 s for 5 min, its position sheering 10 m either side.
    for (let s = 0; s <= 300; s += 10) {
      track = check.apply('a', reported(s % 40 < 20 ? 10 : -10, 0.46), T0 + s * SECOND)
      expect(track.sog).toBe(0)
    }
  })

  it('takes 0.9 kn once the position has moved that far', () => {
    const check = new MotionCheck()
    let track
    for (let s = 0; s <= 150; s += 10) {
      track = check.apply('a', reported(0.46 * s, 0.46), T0 + s * SECOND)
    }
    expect(track).toMatchObject({ sog: 0.46, cog: 0 })
  })

  it('keeps a confirmed boat moving when one report runs high', () => {
    const check = new MotionCheck()
    for (let s = 0; s <= 150; s += 10) {
      check.apply('a', reported(0.33 * s, 0.33), T0 + s * SECOND)
    }
    expect(check.apply('a', reported(0.33 * 152, 0.5), T0 + 152 * SECOND).sog).toBe(0.5)
  })

  it('checks an AIS boat against its previous report 3 min earlier', () => {
    const check = new MotionCheck()
    check.apply('a', reported(0, 0.46), T0)
    expect(check.apply('a', reported(83, 0.46), T0 + 180 * SECOND).sog).toBe(0.46)
    expect(check.apply('b', reported(0, 0.46), T0).sog).toBe(0)
    expect(check.apply('b', reported(20, 0.46), T0 + 180 * SECOND).sog).toBe(0)
  })

  it('stops a boat swinging at anchor whose reported course points elsewhere', () => {
    const check = new MotionCheck()
    // Moving north 0.2 m/s as it swings, reporting 0.5 kn east.
    check.apply('a', { ...reported(0, 0.27), cog: Math.PI / 2 }, T0)
    const track = check.apply('a', { ...reported(30, 0.27), cog: Math.PI / 2 }, T0 + 150 * SECOND)
    expect(track.sog).toBe(0)
  })

  it('takes 1 kn and more as reported, at once', () => {
    expect(new MotionCheck().apply('a', reported(0, 0.52), T0).sog).toBe(0.52)
  })
})
