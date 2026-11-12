import { describe, expect, it, vi } from 'vitest'
import { ClosestApproachPublisher, type ClosestApproach } from '../src/closestApproach.js'
import { computeCpa, type Track } from '../src/cpa.js'
import type { Evaluation } from '../src/evaluator.js'

const DEG = Math.PI / 180
const NOW = Date.parse('2026-06-01T12:00:00Z')
const CONTEXT = 'vessels.urn:mrn:imo:mmsi:222222222'

const own: Track = { position: { latitude: 50, longitude: 1 }, cog: 0, sog: 3 }
const target: Track = { position: { latitude: 50 + 1 / 60, longitude: 1 }, cog: 180 * DEG, sog: 3 }

function seen(t: Track = target, reportedAt = NOW, ownTrack: Track = own): Evaluation {
  return { targetId: 'x', context: CONTEXT, result: computeCpa(ownTrack, t), target: t, reportedAt }
}

const lost: Evaluation = { targetId: 'x', context: CONTEXT, result: null }

function publisher() {
  const send = vi.fn<(context: string, value: ClosestApproach | null) => void>()
  return { send, p: new ClosestApproachPublisher(send) }
}

describe('ClosestApproachPublisher', () => {
  it('publishes a target once until something about it changes', () => {
    const { send, p } = publisher()
    p.publish([seen()], own, NOW)
    p.publish([seen()], own, NOW + 2000)
    p.publish([seen()], own, NOW + 4000)
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(CONTEXT, {
      distance: expect.any(Number) as number,
      timeTo: expect.any(Number) as number
    })
  })

  it('refreshes an unchanged target every 10 s, as its time to closest approach runs down', () => {
    const { send, p } = publisher()
    p.publish([seen()], own, NOW)
    p.publish([seen()], own, NOW + 9999)
    expect(send).toHaveBeenCalledOnce()
    p.publish([seen()], own, NOW + 10_000)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('publishes on a new report from the target', () => {
    const { send, p } = publisher()
    p.publish([seen()], own, NOW)
    const moved = { ...target, position: { latitude: 50 + 0.9 / 60, longitude: 1 } }
    p.publish([seen(moved, NOW + 2000)], own, NOW + 2000)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('publishes on a report with the same values at a later time', () => {
    const { send, p } = publisher()
    p.publish([seen()], own, NOW)
    p.publish([seen(target, NOW + 2000)], own, NOW + 2000)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('publishes on a new course of the target alone', () => {
    const { send, p } = publisher()
    p.publish([seen()], own, NOW)
    p.publish([seen({ ...target, cog: 170 * DEG })], own, NOW + 2000)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('publishes when own course or speed changes, not on a small wobble', () => {
    const { send, p } = publisher()
    p.publish([seen()], own, NOW)
    const wobble = { ...own, cog: 1 * DEG, position: { latitude: 50.0001, longitude: 1 } }
    p.publish([seen(target, NOW, wobble)], wobble, NOW + 2000)
    expect(send).toHaveBeenCalledOnce()
    const turned = { ...own, cog: 5 * DEG }
    p.publish([seen(target, NOW, turned)], turned, NOW + 4000)
    expect(send).toHaveBeenCalledTimes(2)
    const slowed = { ...turned, sog: 2.8 }
    p.publish([seen(target, NOW, slowed)], slowed, NOW + 6000)
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('takes own ship stopping as a change of speed', () => {
    const { send, p } = publisher()
    p.publish([seen()], own, NOW)
    const stopped = { ...own, sog: 0 }
    p.publish([seen(target, NOW, stopped)], stopped, NOW + 2000)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('clears a target once when it loses its closest approach', () => {
    const { send, p } = publisher()
    p.publish([lost], own, NOW)
    expect(send).not.toHaveBeenCalled()
    p.publish([seen()], own, NOW + 2000)
    p.publish([lost], own, NOW + 4000)
    p.publish([lost], own, NOW + 6000)
    expect(send.mock.calls.map(([, value]) => value)).toEqual([expect.any(Object), null])
  })

  it('publishes a target again at once when it comes back', () => {
    const { send, p } = publisher()
    p.publish([seen()], own, NOW)
    p.publish([lost], own, NOW + 2000)
    p.publish([seen()], own, NOW + 4000)
    expect(send).toHaveBeenCalledTimes(3)
    expect(send).toHaveBeenLastCalledWith(CONTEXT, expect.any(Object))
  })

  it('clears a target the server stopped reporting', () => {
    const { send, p } = publisher()
    p.publish([seen()], own, NOW)
    p.publish([], own, NOW + 2000)
    expect(send).toHaveBeenLastCalledWith(CONTEXT, null)
  })

  it('clears everything it published', () => {
    const { send, p } = publisher()
    const other = 'vessels.urn:mrn:imo:mmsi:333333333'
    p.publish([seen(), { ...seen(), context: other }], own, NOW)
    p.clearAll()
    expect(send.mock.calls.slice(2)).toEqual([
      [CONTEXT, null],
      [other, null]
    ])
    p.clearAll()
    expect(send).toHaveBeenCalledTimes(4)
  })

  it('tries a failed clear again next time', () => {
    const { send, p } = publisher()
    p.publish([seen()], own, NOW)
    send.mockImplementationOnce(() => {
      throw new Error('server busy')
    })
    expect(() => {
      p.publish([lost], own, NOW + 2000)
    }).toThrow('server busy')
    p.publish([], own, NOW + 4000)
    expect(send).toHaveBeenCalledTimes(3)
    expect(send).toHaveBeenLastCalledWith(CONTEXT, null)
    p.publish([], own, NOW + 6000)
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('tries again next time when publishing fails', () => {
    const { send, p } = publisher()
    send.mockImplementationOnce(() => {
      throw new Error('server busy')
    })
    expect(() => {
      p.publish([seen()], own, NOW)
    }).toThrow('server busy')
    p.publish([seen()], own, NOW + 2000)
    expect(send).toHaveBeenCalledTimes(2)
  })
})
