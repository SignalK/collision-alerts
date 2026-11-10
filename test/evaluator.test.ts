import { describe, expect, it } from 'vitest'
import type { AlarmSink, CollisionAlert } from '../src/alarms.js'
import type { Track } from '../src/cpa.js'
import {
  deadReckon,
  Evaluator,
  reportAge,
  toTrack,
  type EvaluatorOptions,
  type TargetNode,
  type VesselNode
} from '../src/evaluator.js'
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

/** `node` with its report dated `time`, ms since the epoch. */
function reportedAt<T extends VesselNode>(node: T, time: number): T {
  const at = new Date(time).toISOString()
  const nav = defined(node.navigation)
  const stamp = <F extends { timestamp?: string }>(field: F | undefined) =>
    field && { ...field, timestamp: at }
  return {
    ...node,
    navigation: {
      position: stamp(nav.position),
      courseOverGroundTrue: stamp(nav.courseOverGroundTrue),
      speedOverGround: stamp(nav.speedOverGround)
    }
  }
}

/**
 * A report built by `vessel()` stands for the boat as it is at whatever time
 * a test evaluates it, so it is dated to that time and dead reckoning leaves
 * it where it is. Reports dated otherwise keep their time.
 */
class TestEvaluator extends Evaluator {
  /** Evaluates `vessels` with each `vessel()` report dated `nowMs`. */
  override evaluate(
    own: Track | null,
    vessels: Record<string, TargetNode>,
    selfId: string,
    nowMs: number
  ) {
    const dated = Object.entries(vessels).map(([id, node]) => [
      id,
      node.navigation?.position?.timestamp === fresh ? reportedAt(node, nowMs) : node
    ])
    return super.evaluate(
      own,
      Object.fromEntries(dated) as Record<string, TargetNode>,
      selfId,
      nowMs
    )
  }
}

const own = defined(toTrack(vessel(50, 1, 0, 5), NOW, 360))
const SELF = 'urn:mrn:imo:mmsi:111111111'
const OTHER = 'urn:mrn:imo:mmsi:222222222'
const THIRD = 'urn:mrn:imo:mmsi:333333333'
const FOURTH = 'urn:mrn:imo:mmsi:444444444'

function setup(options: Partial<EvaluatorOptions> = {}) {
  const sink = new RecordingSink()
  const ev = new TestEvaluator(
    {
      zones: PRESETS.coastal,
      slowZones: PRESETS.harbour,
      slowSpeed: 0,
      maxAlarms: 3,
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

describe('dead reckoning', () => {
  const stopped = defined(toTrack(vessel(50, 1, 0, 0), NOW, 360))
  // `northM` north of us, heading south at 2 m/s.
  const closing = (northM: number) => vessel(50 + northM / 1852 / 60, 1, 180, 2)
  const resultOf = (evaluations: ReturnType<Evaluator['evaluate']>) =>
    defined(evaluations.find((e) => e.targetId === OTHER)?.result)

  it('judges a target where it is now, not where it reported', () => {
    const { ev } = setup()
    // Reported 300 m off 30 s ago: 240 m off now, closest approach in 120 s.
    const result = resultOf(
      ev.evaluate(stopped, { [OTHER]: reportedAt(closing(300), NOW - 30_000) }, SELF, NOW)
    )
    expect(result.range).toBeCloseTo(240, 0)
    expect(result.tcpa).toBeCloseTo(120, 0)
  })

  it('raises a level between two reports once the target is inside the zone', () => {
    const { sink, ev } = setup()
    // Reported 760 m off: closest approach in 380 s, a Coastal warning.
    const report = reportedAt(closing(760), NOW)
    ev.evaluate(stopped, { [OTHER]: report }, SELF, NOW)
    // 30 s on, without a new report, it is in 350 s: inside the 6 min alarm.
    ev.evaluate(stopped, { [OTHER]: report }, SELF, NOW + 30_000)
    expect(sink.calls.map(([, alert]) => alert?.level)).toEqual(['warn', 'alarm'])
  })

  it('carries a target on for no longer than a minute', () => {
    const { ev } = setup()
    // Reported 300 m off 2 min ago: carried on for 1 min, 180 m off.
    const result = resultOf(
      ev.evaluate(stopped, { [OTHER]: reportedAt(closing(300), NOW - 120_000) }, SELF, NOW)
    )
    expect(result.range).toBeCloseTo(180, 0)
  })

  it('leaves a stopped target, and a report without a time or from the future, where it is', () => {
    const position = { latitude: 50, longitude: 1 }
    const anchored = { position, cog: 1, sog: 0 }
    expect(deadReckon(anchored, 30)).toBe(anchored)
    expect(reportAge(Number.NaN, NOW)).toBe(0)
    expect(reportAge(NOW + 5000, NOW)).toBe(0)
    expect(reportAge(NOW - 30_000, NOW)).toBe(30)
    expect(reportAge(NOW - 120_000, NOW)).toBe(60)
  })

  it('judges an old report like a fresh one where the boat is by now', () => {
    // Own ship makes 5 m/s north; the boat crosses westward at 4 m/s, 600 m
    // north and 300 m east, reported 30 s ago: by now 180 m east.
    const crossing = (eastM: number) =>
      vessel(50 + 600 / 1852 / 60, 1 + eastM / 1852 / 60 / Math.cos((50 * Math.PI) / 180), 270, 4)
    const old = resultOf(
      setup().ev.evaluate(own, { [OTHER]: reportedAt(crossing(300), NOW - 30_000) }, SELF, NOW)
    )
    const fresh = resultOf(
      setup().ev.evaluate(own, { [OTHER]: reportedAt(crossing(180), NOW) }, SELF, NOW)
    )
    expect(old.cpa).toBeCloseTo(fresh.cpa, 0)
    expect(old.tcpa).toBeCloseTo(fresh.tcpa, 0)
    expect(old.range).toBeCloseTo(fresh.range, 0)
  })

  it('holds the alarm of a boat that falls silent near its closest approach', () => {
    const { sink, ev } = setup()
    // 40 m off, closest approach in 20 s; then it falls silent. Carried on a
    // minute, it is 80 m past us, but it may have stopped.
    const report = reportedAt(closing(40), NOW)
    ev.evaluate(stopped, { [OTHER]: report }, SELF, NOW)
    const result = resultOf(ev.evaluate(stopped, { [OTHER]: report }, SELF, NOW + 60_000))
    expect(result.range).toBeCloseTo(80, 0)
    expect(sink.calls.map(([, alert]) => alert?.level)).toEqual(['alarm', 'alarm'])
  })

  it('lets a silent boat held at its closest approach give its place to one approaching', () => {
    const { sink, ev } = setup({ maxAlarms: 1 })
    const silent = reportedAt(closing(40), NOW)
    ev.evaluate(stopped, { [OTHER]: silent }, SELF, NOW)
    // 30 s on, the silent boat is held; another comes at us from 300 m east
    // at 2 m/s, closest approach 0 in 150 s.
    const east = vessel(50, 1 + 300 / 1852 / 60 / Math.cos((50 * Math.PI) / 180), 270, 2)
    sink.calls = []
    ev.evaluate(
      stopped,
      { [OTHER]: silent, [THIRD]: reportedAt(east, NOW + 30_000) },
      SELF,
      NOW + 30_000
    )
    expect(sink.calls).toEqual([
      [OTHER, undefined],
      [THIRD, expect.objectContaining({ level: 'alarm' })]
    ])
  })

  it('clears a boat that overtakes us once its reports show it past, and only once', () => {
    const { sink, ev } = setup()
    // Both on 045°: we make 4 m/s, it 5 m/s, coming up from 200 m astern to
    // pass 30 m to starboard, reporting every 30 s as a Class B boat does.
    const COS50 = Math.cos((50 * Math.PI) / 180)
    const at = (northM: number, eastM: number, sog: number) =>
      vessel(50 + northM / 1852 / 60, 1 + eastM / 1852 / 60 / COS50, 45, sog)
    const r = Math.SQRT1_2
    const states: Array<string | undefined> = []
    for (let s = 0; s <= 400; s += 2) {
      const ahead = 4 * s
      const time = NOW + s * 1000
      const ownNow = defined(toTrack(reportedAt(at(ahead * r, ahead * r, 4), time), time, 360))
      const reported = s - (s % 30)
      const along = -200 + 5 * reported
      // Starboard of 045° is 135°: 30 m that way.
      const boat = reportedAt(at(along * r - 30 * r, along * r + 30 * r, 5), NOW + reported * 1000)
      ev.evaluate(ownNow, { [OTHER]: boat }, SELF, time)
      const level = sink.calls.at(-1)?.[1]?.level
      if (sink.calls.length > 0 && states.at(-1) !== level) {
        states.push(level)
      }
    }
    expect(states).toEqual(['alarm', undefined])
  })
})

describe('a boat judged by the Harbour limits between its reports', () => {
  const COS50 = Math.cos((50 * Math.PI) / 180)
  const stopped = defined(toTrack(vessel(50, 1, 0, 0), NOW, 360))
  // `northM` north and `eastM` east of us on `cogDeg` at `sog` m/s.
  const at = (northM: number, eastM: number, cogDeg: number, sog: number) =>
    vessel(50 + northM / 1852 / 60, 1 + eastM / 1852 / 60 / COS50, cogDeg, sog)
  const levels = (sink: RecordingSink) => sink.calls.map(([, alert]) => alert?.level)

  it('rises no higher than its last report gives until the next report', () => {
    const { sink, ev } = setup({ slowSpeed: 1.5 })
    // Heading south at 0.6 m/s: CPA 36 m in 145 s, a Harbour warning.
    const report = reportedAt(at(87, 36, 180, 0.6), NOW)
    ev.evaluate(stopped, { [OTHER]: report }, SELF, NOW)
    // Carried on 27 s, its closest approach is 118 s ahead, inside the
    // Harbour alarm's 2 min: it stays a warning.
    ev.evaluate(stopped, { [OTHER]: report }, SELF, NOW + 27_000)
    // Its next report shows it turning away.
    const turned = reportedAt(at(69, 36, 90, 0.6), NOW + 31_000)
    ev.evaluate(stopped, { [OTHER]: turned }, SELF, NOW + 31_000)
    expect(levels(sink)).not.toContain('alarm')
    expect(levels(sink).slice(0, 2)).toEqual(['warn', 'warn'])
  })

  it('alarms once a report confirms it', () => {
    const { sink, ev } = setup({ slowSpeed: 1.5 })
    const report = reportedAt(at(87, 36, 180, 0.6), NOW)
    ev.evaluate(stopped, { [OTHER]: report }, SELF, NOW)
    ev.evaluate(stopped, { [OTHER]: report }, SELF, NOW + 27_000)
    // Still coming on: CPA 36 m in 115 s.
    const next = reportedAt(at(69, 36, 180, 0.6), NOW + 30_000)
    ev.evaluate(stopped, { [OTHER]: next }, SELF, NOW + 30_000)
    expect(levels(sink)).toEqual(['warn', 'warn', 'alarm'])
  })

  it('alarms on dead reckoning once its report is 40 s old', () => {
    const { sink, ev } = setup({ slowSpeed: 1.5 })
    const report = reportedAt(at(87, 36, 180, 0.6), NOW)
    for (const s of [0, 39, 40]) {
      ev.evaluate(stopped, { [OTHER]: report }, SELF, NOW + s * 1000)
    }
    expect(levels(sink)).toEqual(['warn', 'warn', 'alarm'])
  })

  it('raises a warning on dead reckoning, as before', () => {
    const { sink, ev } = setup({ slowSpeed: 1.5 })
    // CPA 36 m in 330 s, beyond the Harbour warning's 5 min; carried on 35 s,
    // in 295 s.
    const report = reportedAt(at(198, 36, 180, 0.6), NOW)
    ev.evaluate(stopped, { [OTHER]: report }, SELF, NOW)
    ev.evaluate(stopped, { [OTHER]: report }, SELF, NOW + 35_000)
    expect(levels(sink)).toEqual(['warn'])
  })

  it('keeps the warning of a boat in company while we move', () => {
    const slowSpeed = (3 * 1852) / 3600
    const { sink, ev } = setup({ slowSpeed })
    // We make 1.35 m/s north; it makes 1.5 m/s north, 22 m astern and 30 m to
    // starboard: CPA 30 m in 147 s, a Harbour warning.
    const ownAt = (s: number) =>
      defined(toTrack(vessel(50 + (1.35 * s) / 1852 / 60, 1, 0, 1.35), NOW + s * 1000, 360))
    const report = reportedAt(at(-22, 30, 0, 1.5), NOW)
    for (const s of [0, 26, 28]) {
      ev.evaluate(ownAt(s), { [OTHER]: report }, SELF, NOW + s * 1000)
    }
    // Its next report: CPA 30 m in 117 s.
    const next = reportedAt(at(-22 + 1.5 * 30, 30, 0, 1.5), NOW + 30_000)
    ev.evaluate(ownAt(30), { [OTHER]: next }, SELF, NOW + 30_000)
    expect(levels(sink)).toEqual(['warn', 'warn', 'warn', 'alarm'])
  })

  it('raises no alarm by the zones a warning was raised by', () => {
    const { sink, ev } = setup({ slowSpeed: 1.5 })
    // At 2 m/s we close on it at 3 m/s: CPA 300 m in 667 s, a Coastal warning.
    const fast = defined(toTrack(vessel(50, 1, 0, 2), NOW, 360))
    ev.evaluate(fast, { [OTHER]: at(2000, 300, 180, 1) }, SELF, NOW)
    // We slow to 1 m/s, both below the threshold. Reported 20 s ago, it closes
    // at 2 m/s: CPA 300 m in 330 s as reported, in 310 s carried on, a
    // Coastal alarm both ways, but nothing by the Harbour limits.
    const slow = defined(toTrack(vessel(50, 1, 0, 1), NOW + 2000, 360))
    const report = reportedAt(at(640, 300, 180, 1), NOW - 18_000)
    ev.evaluate(slow, { [OTHER]: report }, SELF, NOW + 2000)
    expect(levels(sink)).toEqual(['warn', 'warn'])
  })

  it('never lowers an alarm it already has', () => {
    const { sink, ev } = setup({ slowSpeed: 1.5 })
    // CPA 30 m in 100 s: an alarm.
    ev.evaluate(stopped, { [OTHER]: at(84, 30, 180, 0.84) }, SELF, NOW)
    // It slowed to 0.55 m/s: reported 10 s ago, closest approach in 150 s,
    // beyond the alarm's hold; carried on, in 140 s, inside it.
    const slowed = reportedAt(at(82.5, 30, 180, 0.55), NOW + 2000)
    ev.evaluate(stopped, { [OTHER]: slowed }, SELF, NOW + 12_000)
    expect(levels(sink)).toEqual(['alarm', 'alarm'])
  })

  it('lets a held emergency fall back to the alarm dead reckoning gives', () => {
    const zones = [
      { level: 'warn' as const, cpa: 926, tcpa: 720 },
      { level: 'alarm' as const, cpa: 463, tcpa: 360 },
      { level: 'emergency' as const, cpa: 200, tcpa: 200 }
    ]
    const { sink, ev } = setup({ slowSpeed: 1.5, zones })
    // At 2 m/s we close on it at 3 m/s: CPA 100 m in 167 s, an emergency.
    const fast = defined(toTrack(vessel(50, 1, 0, 2), NOW, 360))
    ev.evaluate(fast, { [OTHER]: at(500, 100, 180, 1) }, SELF, NOW)
    // We slow to 1 m/s, both below the threshold. Reported 20 s ago, it
    // closes at 2 m/s: CPA 100 m in 420 s carried on, an alarm by the zones it
    // was raised by; in 440 s as reported, a warning.
    const slow = defined(toTrack(vessel(50, 1, 0, 1), NOW + 2000, 360))
    const report = reportedAt(at(860, 100, 180, 1), NOW - 18_000)
    ev.evaluate(slow, { [OTHER]: report }, SELF, NOW + 2000)
    expect(levels(sink)).toEqual(['emergency', 'alarm'])
  })

  it('alarms at once for an anchored boat we close on from a 30 s old report', () => {
    const { sink, ev } = setup({ slowSpeed: 1.5 })
    // We make 1 m/s north; it lies 110 m ahead, last reported 30 s ago as a
    // boat at anchor does every 3 min: CPA 0 in 110 s.
    const moving = defined(toTrack(vessel(50, 1, 0, 1), NOW, 360))
    const anchored = reportedAt(at(110, 0, 0, 0), NOW - 30_000)
    ev.evaluate(moving, { [OTHER]: anchored }, SELF, NOW)
    expect(levels(sink)).toEqual(['alarm'])
  })

  it('leaves a boat judged by other zones rising on dead reckoning', () => {
    const { sink, ev } = setup({ slowSpeed: 1.5 })
    // At 2 m/s, faster than the threshold, it is judged by the cut zones:
    // CPA 30 m in 380 s, a warning; carried on 30 s, in 350 s, inside the
    // alarm's 6 min.
    const report = reportedAt(at(760, 30, 180, 2), NOW)
    ev.evaluate(stopped, { [OTHER]: report }, SELF, NOW)
    ev.evaluate(stopped, { [OTHER]: report }, SELF, NOW + 30_000)
    expect(levels(sink)).toEqual(['warn', 'alarm'])
  })
})

describe('a boat dragging its anchor', () => {
  it('alarms although it reports being stopped', () => {
    const { sink, ev } = setup()
    const still = defined(toTrack(vessel(50, 1, 0, 0), NOW, 360))
    // 150 m north, reporting 0.05 m/s with a random course, drifting south at 0.2 m/s.
    for (let minute = 0; minute <= 6; minute++) {
      const time = NOW - (6 - minute) * 60_000
      const north = 150 - 0.2 * 60 * minute
      const node = vessel(50 + north / 111_195, 1, 123, 0.05)
      const nav = defined(node.navigation)
      for (const field of [nav.position, nav.courseOverGroundTrue, nav.speedOverGround]) {
        defined(field).timestamp = new Date(time).toISOString()
      }
      ev.evaluate(still, { [OTHER]: node }, SELF, time)
      if (minute === 0) {
        expect(sink.calls).toEqual([])
      }
    }
    expect(sink.calls.at(-1)?.[1]?.level).toBe('warn')
  })
})

describe('Evaluator', () => {
  it('does not alarm for two boats at anchor whose AIS speed is noise', () => {
    const { sink, ev } = setup({ zones: PRESETS.harbour })
    const anchored = defined(toTrack(vessel(50, 1, 90, 0.2), NOW, 360))
    // 40 m north, reporting 0.4 kn straight at us.
    ev.evaluate(anchored, { [OTHER]: vessel(50 + 40 / 1852 / 60, 1, 180, 0.2) }, SELF, NOW)
    expect(sink.calls).toHaveLength(0)
  })

  it('does not alarm for a neighbour at anchor reporting 0.9 kn as it yaws in a gust', () => {
    const { sink, ev } = setup({ zones: PRESETS.harbour })
    const anchored = defined(toTrack(vessel(50, 1, 0, 0), NOW, 360))
    // 60 m north, reporting 0.9 kn straight at us.
    ev.evaluate(anchored, { [OTHER]: vessel(50 + 60 / 1852 / 60, 1, 180, 0.46) }, SELF, NOW)
    expect(sink.calls).toHaveLength(0)
  })

  it('alarms for a boat closing at 0.9 kn once its position bears that out', () => {
    const { sink, ev } = setup({ zones: PRESETS.harbour })
    const anchored = defined(toTrack(vessel(50, 1, 0, 0), NOW, 360))
    // From 250 m north at 0.9 kn straight at us, reporting every 10 s, until
    // its closest approach is 5 min away.
    for (let s = 0; s <= 250; s += 10) {
      const closing = vessel(50 + (250 - 0.46 * s) / 1852 / 60, 1, 180, 0.46)
      defined(defined(closing.navigation).position).timestamp = new Date(
        NOW + s * 1000
      ).toISOString()
      ev.evaluate(anchored, { [OTHER]: closing }, SELF, NOW + s * 1000)
    }
    expect(sink.calls.at(-1)).toEqual([OTHER, expect.objectContaining({ level: 'warn' })])
  })

  it('alarms for a boat closing slowly on one at anchor', () => {
    const { sink, ev } = setup({ zones: PRESETS.harbour })
    const anchored = defined(toTrack(vessel(50, 1, 0, 0), NOW, 360))
    // 100 m north at 1 kn (0.51 m/s) straight at us: closest approach in about 3 min.
    ev.evaluate(anchored, { [OTHER]: vessel(50 + 100 / 1852 / 60, 1, 180, 0.51) }, SELF, NOW)
    expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
  })

  it('clears the alarm once a neighbour that closed on us at anchor stops', () => {
    const { sink, ev } = setup({ zones: PRESETS.harbour })
    const anchored = defined(toTrack(vessel(50, 1, 0, 0), NOW, 360))
    const north = 50 + 80 / 1852 / 60
    ev.evaluate(anchored, { [OTHER]: vessel(north, 1, 180, 1) }, SELF, NOW)
    expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    const still = { [OTHER]: vessel(north, 1, 180, 0.1) }
    // Held through a moment's pause, like a target just past closest approach.
    ev.evaluate(anchored, still, SELF, NOW)
    ev.evaluate(anchored, still, SELF, NOW + 20_000)
    expect(sink.calls.at(-1)).toEqual([OTHER, expect.objectContaining({ level: 'warn' })])
    ev.evaluate(anchored, still, SELF, NOW + 40_000)
    expect(sink.calls.at(-1)).toEqual([OTHER, undefined])
  })

  it('ranks a boat that stopped near us below one still approaching', () => {
    const { sink, ev } = setup({ zones: PRESETS.harbour, maxAlarms: 1 })
    const anchored = defined(toTrack(vessel(50, 1, 0, 0), NOW, 360))
    const north = 50 + 80 / 1852 / 60
    ev.evaluate(anchored, { [OTHER]: vessel(north, 1, 180, 1) }, SELF, NOW)
    // It stops, held at warn, while a second boat closes from the south: 90 m
    // at 1 kn, warn too.
    const both = {
      [OTHER]: vessel(north, 1, 180, 0.1),
      [THIRD]: vessel(50 - 90 / 1852 / 60, 1, 0, 0.51)
    }
    ev.evaluate(anchored, both, SELF, NOW + 2000)
    ev.evaluate(anchored, both, SELF, NOW + 4000)
    expect(sink.calls.at(-1)).toEqual([THIRD, expect.objectContaining({ level: 'warn' })])
  })

  describe('a target crossing our track', () => {
    // 1 NM west heading east at our speed (5 m/s); it crosses ahead of us
    // when it starts more than 1 NM north, astern when less.
    const crossing = (northNm: number) =>
      vessel(50 + northNm / 60, 1 - 1 / 60 / Math.cos((50 * Math.PI) / 180), 90, 5)

    it('warns when it will pass ahead within the warning distance', () => {
      const { sink, ev } = setup()
      // CPA 0.28 NM, 0.2 NM ahead of us, in 7.4 min.
      ev.evaluate(own, { [OTHER]: crossing(1.4) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
    })

    it('stays quiet when it will pass astern at the same distance', () => {
      const { sink, ev } = setup()
      // CPA 0.28 NM, 0.2 NM astern of us, in 5 min.
      ev.evaluate(own, { [OTHER]: crossing(0.6) }, SELF, NOW)
      expect(sink.calls).toHaveLength(0)
    })

    it('warns early when it is on a near collision course that passes just astern', () => {
      const { sink, ev } = setup()
      // CPA 26 m astern in 6.1 min: outside the alarm time, inside the warning.
      ev.evaluate(own, { [OTHER]: crossing(0.98) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
    })

    it('still alarms when it will pass close astern', () => {
      const { sink, ev } = setup()
      // CPA 0.14 NM, inside the 0.25 NM alarm distance, in 5.6 min.
      ev.evaluate(own, { [OTHER]: crossing(0.8) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })
  })

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

  it("carries the target's course and speed in the alarm", () => {
    const { sink, ev } = setup()
    ev.evaluate(own, { [OTHER]: vessel(50 + 1 / 60, 1, 180, 5) }, SELF, NOW)
    expect(sink.calls[0][1]?.data).toMatchObject({ targetCog: Math.PI, targetSog: 5 })
  })

  it('gives a stopped target no course in the alarm', () => {
    const { sink, ev } = setup()
    // We steam at a boat lying still 0.1 NM ahead.
    ev.evaluate(own, { [OTHER]: vessel(50 + 0.1 / 60, 1, 270, 0.05) }, SELF, NOW)
    expect(sink.calls[0][1]?.data).toMatchObject({ targetCog: null, targetSog: 0 })
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
    // A boat 0.2 NM ahead, 150 m to starboard of our track, coming our way at
    // 0.6 m/s: inside the Coastal limits, outside the Harbour ones.
    const target = vessel(
      50 + 0.2 / 60,
      1 + 150 / 1852 / 60 / Math.cos((50 * Math.PI) / 180),
      180,
      0.6
    )
    const at = (sog: number) => defined(toTrack(vessel(50, 1, 0, sog), NOW, 360))

    const normal = setup()
    normal.ev.evaluate(at(1), { [OTHER]: target }, SELF, NOW)
    expect(normal.sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])

    const { sink, ev } = setup({ slowSpeed: 1.5 })
    ev.evaluate(at(1), { [OTHER]: target }, SELF, NOW)
    expect(sink.calls).toHaveLength(0)
    // Just above the threshold the slow zones still hold.
    ev.evaluate(at(1.6), { [OTHER]: target }, SELF, NOW)
    expect(sink.calls).toHaveLength(0)
    ev.evaluate(at(2), { [OTHER]: target }, SELF, NOW)
    expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
  })

  describe('a boat at anchor we pass under way', () => {
    const anchoredAt = (northNm: number, eastM: number, sog = 0) =>
      vessel(50 + northNm / 60, 1 + eastM / 1852 / 60 / Math.cos((50 * Math.PI) / 180), 309, sog)

    it('is judged by the Harbour limits', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 0.2 NM ahead, 150 m off our track: a Coastal alarm, nothing in Harbour.
      ev.evaluate(own, { [OTHER]: anchoredAt(0.2, 150) }, SELF, NOW)
      expect(sink.calls).toEqual([])
      // Dead ahead it still alarms.
      ev.evaluate(own, { [OTHER]: anchoredAt(0.2, 0) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('keeps the normal limits when Harbour limits are turned off', () => {
      const { sink, ev } = setup()
      ev.evaluate(own, { [OTHER]: anchoredAt(0.2, 150) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('stays stopped while its reported speed hovers near the threshold', () => {
      // A Harbour-limits speed below the stopped boat's reported speed.
      const { sink, ev } = setup({ slowSpeed: 0.1 })
      ev.evaluate(own, { [OTHER]: anchoredAt(0.2, 150) }, SELF, NOW)
      ev.evaluate(own, { [OTHER]: anchoredAt(0.2, 150, 0.4) }, SELF, NOW)
      expect(sink.calls).toEqual([])
    })
  })

  describe('a boat under way while we are stopped', () => {
    const COS50 = Math.cos((50 * Math.PI) / 180)
    const stopped = defined(toTrack(vessel(50, 1, 0, 0), NOW, 360))
    // `northM` north and `eastM` east of us, heading south at `sog` m/s:
    // CPA `eastM` in `northM / sog` seconds.
    const southbound = (northM: number, eastM: number, sog = 1.9) =>
      vessel(50 + northM / 1852 / 60, 1 + eastM / 1852 / 60 / COS50, 180, sog)
    const northbound = (northM: number, eastM: number, sog: number) =>
      vessel(50 + northM / 1852 / 60, 1 + eastM / 1852 / 60 / COS50, 0, sog)
    const levels = (sink: RecordingSink) => sink.calls.map(([, alert]) => alert?.level)

    it('raises nothing when it passes 130 m off', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // CPA 130 m in 30 s: a Coastal alarm.
      ev.evaluate(stopped, { [OTHER]: southbound(57, 130) }, SELF, NOW)
      expect(sink.calls).toEqual([])
    })

    it('keeps the normal limits when Harbour limits are turned off', () => {
      const { sink, ev } = setup()
      ev.evaluate(stopped, { [OTHER]: southbound(57, 130) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('warns but does not alarm when it passes 80 m off', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(stopped, { [OTHER]: southbound(57, 80) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
    })

    it('warns and alarms as early as the normal limits when it heads straight for us', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 3 m/s from 1800 m: CPA 0 in 10 min, beyond the Harbour limits' 5 min.
      ev.evaluate(stopped, { [OTHER]: southbound(1800, 0, 3) }, SELF, NOW)
      // From 900 m: CPA 0 in 5 min, inside the Coastal alarm's 6 min.
      ev.evaluate(stopped, { [OTHER]: southbound(900, 0, 3) }, SELF, NOW + 2000)
      expect(levels(sink)).toEqual(['warn', 'alarm'])
    })

    it('keeps the normal limits for a boat at 6 kn or faster while its course could bring it close', () => {
      // Passing 130 m off in 300 s, a Coastal alarm, where 3° of course error
      // is 50 m at 3.2 m/s: at 3 m/s it raises nothing.
      const under = setup({ slowSpeed: 1.5 })
      under.ev.evaluate(stopped, { [OTHER]: southbound(900, 130, 3) }, SELF, NOW)
      expect(under.sink.calls).toEqual([])
      // At 3.2 m/s, above 6 kn, it alarms, as at 3.088 m/s, just above, and at
      // 6 kn exactly.
      for (const sog of [3.2, 3.088, (6 * 1852) / 3600]) {
        const over = setup({ slowSpeed: 1.5 })
        over.ev.evaluate(stopped, { [OTHER]: southbound(300 * sog, 130, sog) }, SELF, NOW)
        expect(over.sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
      }
    })

    it('raises a warned fast boat found to pass clear no higher by the normal limits', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // At 4 m/s, 150 m off in 500 s: 3° of course error is 105 m, so the
      // Coastal limits warn.
      ev.evaluate(stopped, { [OTHER]: southbound(2000, 150, 4) }, SELF, NOW)
      // 300 m off in 250 s, a Coastal alarm, where 3° is 52 m: it passes clear
      // of the Harbour distances, and the warning stands.
      ev.evaluate(stopped, { [OTHER]: southbound(1000, 300, 4) }, SELF, NOW + 2000)
      // 40 m off in 200 s: the Coastal limits judge it again, and it alarms.
      ev.evaluate(stopped, { [OTHER]: southbound(800, 40, 4) }, SELF, NOW + 4000)
      expect(levels(sink)).toEqual(['warn', 'warn', 'alarm'])
    })

    it('raises a warned boat that slows down no higher by the cut limits', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // At 1.8 m/s, 55 m off in 56 s: a warning by the cut limits.
      ev.evaluate(stopped, { [OTHER]: southbound(100, 55, 1.8) }, SELF, NOW)
      // Slowed to 0.55 m/s, 16 m off in 136 s: a cut alarm, but a Harbour
      // warning, since its closest approach is more than 2 min away.
      ev.evaluate(stopped, { [OTHER]: southbound(75, 16, 0.55) }, SELF, NOW + 2000)
      // 16 m off in 109 s: a Harbour alarm.
      ev.evaluate(stopped, { [OTHER]: southbound(60, 16, 0.55) }, SELF, NOW + 4000)
      expect(levels(sink)).toEqual(['warn', 'warn', 'alarm'])
    })

    it('judges a fast boat passing clear of the Harbour distances by the cut limits', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // At 3.2 m/s, 130 m off in 30 s: 3° of course error is 5 m.
      ev.evaluate(stopped, { [OTHER]: southbound(96, 130, 3.2) }, SELF, NOW)
      // A ferry leaving its berth at 3.4 m/s, 715 m off in 74 s: a Coastal
      // warning, where 3° is 13 m.
      ev.evaluate(stopped, { [OTHER]: southbound(252, 715, 3.4) }, SELF, NOW + 2000)
      // Nearly abeam, 105 m off in 5 s, judged by where it passes.
      ev.evaluate(stopped, { [OTHER]: southbound(17, 105, 3.4) }, SELF, NOW + 4000)
      expect(sink.calls).toEqual([])
    })

    it('allows for 3° of error in the course of a fast boat', () => {
      // At 10 m/s, 700 s out, 3° is 366 m: passing 450 m off it warns, 480 m
      // off it does not.
      const near = setup({ slowSpeed: 1.5 })
      near.ev.evaluate(stopped, { [OTHER]: southbound(7000, 450, 10) }, SELF, NOW)
      expect(levels(near.sink)).toEqual(['warn'])
      const far = setup({ slowSpeed: 1.5 })
      far.ev.evaluate(stopped, { [OTHER]: southbound(7000, 480, 10) }, SELF, NOW)
      expect(far.sink.calls).toEqual([])
    })

    it('warns and alarms as early as the normal limits for a ship whose course is 2° off', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // At 10 m/s on a track straight for us, reporting a course 2° off it:
      // CPA 248 m in 710 s, inside the Coastal warning's 12 min.
      const ship = (northM: number) => vessel(50 + northM / 1852 / 60, 1, 182, 10)
      ev.evaluate(stopped, { [OTHER]: ship(7100) }, SELF, NOW)
      // CPA 122 m in 350 s, inside the Coastal alarm's 6 min.
      ev.evaluate(stopped, { [OTHER]: ship(3500) }, SELF, NOW + 2000)
      expect(levels(sink)).toEqual(['warn', 'alarm'])
    })

    it('holds a warning by the normal limits through noise in a fast boat’s course', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // At 9.8 m/s, 300 m east and 5000 m north, its reported course swinging
      // 1° either way: CPA 213 m and 387 m in turn, clear of the Harbour
      // distances by 3° of error only when it swings away.
      for (let i = 0; i < 10; i++) {
        const north = 5000 - i * 60
        const node = vessel(
          50 + north / 1852 / 60,
          1 + 300 / 1852 / 60 / COS50,
          i % 2 ? 179 : 181,
          9.8
        )
        ev.evaluate(stopped, { [OTHER]: node }, SELF, NOW + i * 6000)
      }
      expect(levels(sink)).toEqual(Array(10).fill('warn'))
    })

    it('keeps the 30 s count for a boat we were overtaking', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // At 2 m/s we overtake it at 1.6 m/s, 600 m ahead and 80 m to starboard.
      const moving = defined(toTrack(vessel(50, 1, 0, 2), NOW, 360))
      ev.evaluate(moving, { [OTHER]: northbound(600, 80, 1.6) }, SELF, NOW)
      // We stop, and it comes up past us 80 m off, still overtaken: CPA 80 m
      // in about 3 min, which it raises only after 30 s in the zone.
      let raisedAt: number | undefined
      for (let s = 2; s <= 40 && raisedAt === undefined; s += 2) {
        ev.evaluate(stopped, { [OTHER]: northbound(-300, 80, 1.6) }, SELF, NOW + s * 1000)
        if (sink.calls.length > 0) {
          raisedAt = s
        }
      }
      expect(raisedAt).toBe(30)
      expect(levels(sink)).toEqual(['warn'])
    })

    it('takes the normal timing at once for a boat speeding up past the threshold', () => {
      // At 1.5 m/s, the threshold itself, and at 1.6 m/s, within the slow
      // zones' release margin.
      for (const sog of [1.5, 1.6]) {
        const { sink, ev } = setup({ slowSpeed: 1.5 })
        // 1.4 m/s from 1200 m: CPA 0 in 14 min, beyond every warning.
        ev.evaluate(stopped, { [OTHER]: southbound(1200, 0, 1.4) }, SELF, NOW)
        // CPA 0 in 10 min: inside the Coastal warning's 12 min, beyond the
        // Harbour 5 min.
        ev.evaluate(stopped, { [OTHER]: southbound(600 * sog, 0, sog) }, SELF, NOW + 2000)
        // Back at 1.4 m/s it keeps the warning.
        ev.evaluate(stopped, { [OTHER]: southbound(800, 0, 1.4) }, SELF, NOW + 4000)
        expect(levels(sink)).toEqual(['warn', 'warn'])
      }
    })

    it('keeps a level raised by the slow zones through speed noise at the threshold', () => {
      // Custom limits with less time than Harbour's: an alarm within 185 m and
      // 3 min, which cut to 50 m.
      const zones = [{ level: 'alarm' as const, cpa: 185, tcpa: 180 }]
      const { sink, ev } = setup({ slowSpeed: 1.5, zones })
      // CPA 80 m in 4 min, a Harbour warning, at 1.4 and 1.6 m/s in turn.
      for (let i = 0; i < 4; i++) {
        const sog = i % 2 === 0 ? 1.4 : 1.6
        ev.evaluate(stopped, { [OTHER]: southbound(240 * sog, 80, sog) }, SELF, NOW + i * 2000)
      }
      expect(levels(sink)).toEqual(['warn', 'warn', 'warn', 'warn'])
    })

    it('keeps a warning raised by the slow zones that the zones it is judged by now lack', () => {
      // Custom limits with an alarm only, which cut to 50 m.
      const zones = [{ level: 'alarm' as const, cpa: 185, tcpa: 180 }]
      const { sink, ev } = setup({ slowSpeed: 1.5, zones })
      // CPA 80 m in 4 min, a Harbour warning.
      ev.evaluate(stopped, { [OTHER]: southbound(240 * 1.4, 80, 1.4) }, SELF, NOW)
      // At 1.8 m/s, past the release margin, the cut limits give it nothing,
      // and the Harbour limits hold it, 110 m off by their margin.
      ev.evaluate(stopped, { [OTHER]: southbound(238 * 1.8, 110, 1.8) }, SELF, NOW + 2000)
      ev.evaluate(stopped, { [OTHER]: southbound(236 * 1.8, 80, 1.8) }, SELF, NOW + 4000)
      // Inside 3 min it alarms by the limits it is judged by now.
      ev.evaluate(stopped, { [OTHER]: southbound(170 * 1.8, 40, 1.8) }, SELF, NOW + 6000)
      expect(levels(sink)).toEqual(['warn', 'warn', 'warn', 'alarm'])
    })

    it('keeps the cut limits for a level the Harbour limits rated higher for a while', () => {
      // Custom limits with an alert at 926 m in 12 min, which cuts to 100 m.
      const zones = [
        { level: 'alert' as const, cpa: 926, tcpa: 720 },
        { level: 'alarm' as const, cpa: 463, tcpa: 360 }
      ]
      const { sink, ev } = setup({ slowSpeed: 1.5, zones })
      // At 1.8 m/s, CPA 80 m in 3 min: an alert by the cut limits.
      ev.evaluate(stopped, { [OTHER]: southbound(336, 80, 1.8) }, SELF, NOW)
      // At 1.4 m/s, in 4 min: a Harbour warning.
      ev.evaluate(stopped, { [OTHER]: southbound(336, 80, 1.4) }, SELF, NOW + 2000)
      // At 0.7 m/s, in 8 min, beyond the Harbour warning's margin: the alert
      // stands.
      ev.evaluate(stopped, { [OTHER]: southbound(336, 80, 0.7) }, SELF, NOW + 4000)
      expect(levels(sink)).toEqual(['alert', 'warn', 'alert'])
    })

    it('keeps the cut limits for a warning while the boat slows again', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // CPA 80 m in 4 min, a Harbour warning.
      ev.evaluate(stopped, { [OTHER]: southbound(336, 80, 1.4) }, SELF, NOW)
      // At 1.8 m/s, past the release margin, and back at 1.4 m/s: a warning by
      // both.
      ev.evaluate(stopped, { [OTHER]: southbound(336, 80, 1.8) }, SELF, NOW + 2000)
      ev.evaluate(stopped, { [OTHER]: southbound(336, 80, 1.4) }, SELF, NOW + 4000)
      // Slowed to 0.7 m/s, CPA in 8 min: beyond the Harbour warning's margin,
      // inside the cut limits' 12 min.
      ev.evaluate(stopped, { [OTHER]: southbound(336, 80, 0.7) }, SELF, NOW + 6000)
      expect(levels(sink)).toEqual(['warn', 'warn', 'warn', 'warn'])
    })

    it('keeps the Harbour limits for a boat slower than the threshold', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 1 m/s from 600 m: CPA 0 in 10 min, beyond the Harbour limits' 5 min.
      ev.evaluate(stopped, { [OTHER]: southbound(600, 0, 1) }, SELF, NOW)
      expect(sink.calls).toEqual([])
    })

    it('keeps an alarm raised while we moved until it clears', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      const moving = defined(toTrack(vessel(50, 1, 0, 2), NOW, 360))
      ev.evaluate(moving, { [OTHER]: southbound(57, 130) }, SELF, NOW)
      ev.evaluate(stopped, { [OTHER]: southbound(57, 130) }, SELF, NOW + 2000)
      // 100 m past us, 53 s after its closest approach: the alarm clears.
      ev.evaluate(stopped, { [OTHER]: southbound(-100, 130) }, SELF, NOW + 4000)
      expect(levels(sink)).toEqual(['alarm', 'alarm', undefined])
    })
  })

  describe('a boat we overtake', () => {
    const COS50 = Math.cos((50 * Math.PI) / 180)
    // Own ship makes 5 m/s on 000°; the other boat 4 m/s on the same course.
    const sameCourse = (northM: number, eastM: number, sog = 4, cogDeg = 0) =>
      vessel(50 + northM / 1852 / 60, 1 + eastM / 1852 / 60 / COS50, cogDeg, sog)
    // 300 m ahead, 370 m to starboard: CPA 370 m in 5 min, a Coastal alarm.
    const abeam = (sog?: number) => sameCourse(300, 370, sog)
    // A boat `rangeM` off on the given true bearing from us.
    const bearingFrom = (rangeM: number, bearingDeg: number, cogDeg: number, sog: number) => {
      const b = (bearingDeg * Math.PI) / 180
      return sameCourse(rangeM * Math.cos(b), rangeM * Math.sin(b), sog, cogDeg)
    }
    const stamped = (node: VesselNode, time: number) => {
      const nav = defined(node.navigation)
      for (const field of [nav.position, nav.courseOverGroundTrue, nav.speedOverGround]) {
        defined(field).timestamp = new Date(time).toISOString()
      }
      return node
    }
    const levels = (sink: RecordingSink) => sink.calls.map(([, alert]) => alert?.level)
    // Evaluates every 2 s from `from` (ms) for `seconds`, with `node` as it is.
    const hold = (ev: Evaluator, node: VesselNode, from: number, seconds: number) => {
      for (let s = 0; s <= seconds; s += 2) {
        ev.evaluate(own, { [OTHER]: node }, SELF, from + s * 1000)
      }
    }

    it('raises nothing when we pass it 370 m off', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
      expect(sink.calls).toEqual([])
    })

    it('keeps the normal limits when Harbour limits are turned off', () => {
      const { sink, ev } = setup()
      ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('warns as early as the normal limits when it is right on our track, after 30 s', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 600 m dead ahead: CPA 0 in 10 min, outside the Harbour limits' 5 min.
      hold(ev, sameCourse(600, 0), NOW, 28)
      expect(sink.calls).toEqual([])
      ev.evaluate(own, { [OTHER]: sameCourse(600, 0) }, SELF, NOW + 30_000)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
    })

    it('warns but does not alarm for a pass 80 m off, and holds the warning', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 300 m ahead, 80 m to starboard: CPA 80 m in 5 min, a Coastal alarm,
      // but outside the Harbour alarm distance of 50 m.
      hold(ev, sameCourse(300, 80), NOW, 40)
      expect(levels(sink)).toEqual(['warn', 'warn', 'warn', 'warn', 'warn', 'warn'])
    })

    it('escalates a raised level at once', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      hold(ev, sameCourse(300, 80), NOW, 30)
      // Now 300 m dead ahead: CPA 0 in 5 min, inside the alarm zone.
      ev.evaluate(own, { [OTHER]: sameCourse(300, 0) }, SELF, NOW + 32_000)
      expect(levels(sink)).toEqual(['warn', 'alarm'])
    })

    it('rides out moments outside the zone, as between two reports', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // Of every five evaluations, one sees CPA 150 m, outside the zone.
      for (let s = 0; s <= 60; s += 2) {
        const node = s % 10 === 8 ? sameCourse(600, 150) : sameCourse(600, 0)
        ev.evaluate(own, { [OTHER]: node }, SELF, NOW + s * 1000)
      }
      expect(levels(sink)).toContain('warn')
    })

    it('counts a moment outside as a third of one inside', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // Of every five evaluations, two in a row see CPA 0: in the zone 4 s,
      // out of it 6 s, so 2 s more in every 10 s.
      let raisedAt: number | undefined
      for (let s = 0; s <= 300 && raisedAt === undefined; s += 2) {
        const node = s % 10 < 4 ? sameCourse(600, 0) : sameCourse(600, 150)
        ev.evaluate(own, { [OTHER]: node }, SELF, NOW + s * 1000)
        if (sink.calls.length > 0) {
          raisedAt = s
        }
      }
      expect(raisedAt).toBeGreaterThanOrEqual(140)
      expect(raisedAt).toBeLessThanOrEqual(160)
    })

    it('ignores brief moments in the zone, as from speed noise', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // Of every ten evaluations, two in a row see CPA 0, inside the zone.
      for (let s = 0; s <= 300; s += 2) {
        const node = s % 20 < 4 ? sameCourse(600, 0) : sameCourse(600, 150)
        ev.evaluate(own, { [OTHER]: node }, SELF, NOW + s * 1000)
      }
      expect(sink.calls).toEqual([])
    })

    it('alarms at once inside the Harbour alarm limits only', () => {
      // 250 m ahead, 80 m to starboard: CPA 80 m in 250 s, a Harbour warning.
      const warn = setup({ slowSpeed: 1.5 })
      warn.ev.evaluate(own, { [OTHER]: sameCourse(250, 80) }, SELF, NOW)
      expect(warn.sink.calls).toEqual([])
      // 100 m dead ahead: CPA 0 in 100 s, a Harbour alarm.
      const alarm = setup({ slowSpeed: 1.5 })
      alarm.ev.evaluate(own, { [OTHER]: sameCourse(100, 0) }, SELF, NOW)
      expect(alarm.sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
      // 130 m ahead, 30 m to starboard: CPA 30 m, but in 130 s.
      const later = setup({ slowSpeed: 1.5 })
      later.ev.evaluate(own, { [OTHER]: sameCourse(130, 30) }, SELF, NOW)
      expect(later.sink.calls).toEqual([])
      // 100 m ahead, 60 m to starboard: in 100 s, but CPA 60 m.
      const wider = setup({ slowSpeed: 1.5 })
      wider.ev.evaluate(own, { [OTHER]: sameCourse(100, 60) }, SELF, NOW)
      expect(wider.sink.calls).toEqual([])
      // Just inside both limits, CPA 48 m in 118 s; just outside each.
      const at = (northM: number, eastM: number) => {
        const { sink, ev } = setup({ slowSpeed: 1.5 })
        ev.evaluate(own, { [OTHER]: sameCourse(northM, eastM) }, SELF, NOW)
        return levels(sink)
      }
      expect(at(118, 48)).toEqual(['alarm'])
      expect(at(122, 48)).toEqual([])
      expect(at(118, 52)).toEqual([])
    })

    it('does not count time passing wide astern', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
      // 300 m to starboard, 80 m astern, closing on our wake at 0.75 m/s:
      // CPA 80 m astern in 400 s, outside the 50 m that a boat passing astern
      // must come within to raise anything.
      const astern = (aftM: number) =>
        vessel(
          50 - aftM / 1852 / 60,
          1 + 300 / 1852 / 60 / COS50,
          (Math.atan2(-0.75, 5) * 180) / Math.PI,
          Math.hypot(0.75, 5)
        )
      hold(ev, astern(80), NOW + 2000, 28)
      expect(sink.calls).toEqual([])
      // Now CPA 40 m astern in 400 s: inside, but only from now on.
      ev.evaluate(own, { [OTHER]: astern(40) }, SELF, NOW + 32_000)
      expect(sink.calls).toEqual([])
    })

    it('counts the time in the zone again after a level clears', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      hold(ev, sameCourse(600, 0), NOW, 30)
      // CPA 150 m: the warning clears.
      ev.evaluate(own, { [OTHER]: sameCourse(600, 150) }, SELF, NOW + 32_000)
      expect(levels(sink)).toEqual(['warn', undefined])
      hold(ev, sameCourse(600, 0), NOW + 34_000, 20)
      expect(levels(sink)).toEqual(['warn', undefined])
    })

    it('takes the normal limits at once when no longer overtaken', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      hold(ev, sameCourse(300, 80), NOW, 30)
      // It slows to 3 m/s, 2 m/s between us: CPA 80 m in 2.5 min, a Coastal alarm.
      ev.evaluate(own, { [OTHER]: sameCourse(300, 80, 3) }, SELF, NOW + 32_000)
      expect(levels(sink).at(-1)).toBe('alarm')
    })

    it('cuts the distance of every level, an emergency too', () => {
      const zones = [...PRESETS.coastal, { level: 'emergency' as const, cpa: 200, tcpa: 300 }]
      const { sink, ev } = setup({ slowSpeed: 1.5, zones })
      // 250 m ahead, 80 m to starboard: CPA 80 m in 250 s, inside the
      // emergency zone as set, outside it cut to 50 m.
      hold(ev, sameCourse(250, 80), NOW, 30)
      expect(levels(sink)).toEqual(['warn'])
    })

    it('counts the time that passes, not the evaluations', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      for (let s = 0; s <= 30; s += 5) {
        ev.evaluate(own, { [OTHER]: sameCourse(600, 0) }, SELF, NOW + s * 1000)
      }
      expect(levels(sink)).toEqual(['warn'])
    })

    it('keeps its time in the zone through a report without a course', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      hold(ev, sameCourse(600, 0), NOW, 20)
      const noCourse = sameCourse(600, 0)
      delete defined(noCourse.navigation).courseOverGroundTrue
      ev.evaluate(own, { [OTHER]: noCourse }, SELF, NOW + 22_000)
      hold(ev, sameCourse(600, 0), NOW + 24_000, 8)
      expect(levels(sink)).toEqual(['warn'])
    })

    it('ignores the clock going back', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: sameCourse(600, 150) }, SELF, NOW)
      ev.evaluate(own, { [OTHER]: sameCourse(600, 150) }, SELF, NOW - 120_000)
      ev.evaluate(own, { [OTHER]: sameCourse(600, 0) }, SELF, NOW - 118_000)
      expect(sink.calls).toEqual([])
    })

    it('counts a gap in its data as one evaluation', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: sameCourse(600, 0) }, SELF, NOW)
      // Its reports carry no course for a minute.
      const noCourse = sameCourse(600, 0)
      delete defined(noCourse.navigation).courseOverGroundTrue
      hold(ev, noCourse, NOW + 2000, 56)
      ev.evaluate(own, { [OTHER]: sameCourse(600, 0) }, SELF, NOW + 60_000)
      expect(sink.calls).toEqual([])
    })

    it('counts a long evaluation interval in full', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: sameCourse(600, 0) }, SELF, NOW)
      ev.evaluate(own, { [OTHER]: sameCourse(600, 0) }, SELF, NOW + 30_000)
      expect(levels(sink)).toEqual(['warn'])
    })

    it('counts from nothing after a long time outside the zone', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 10 min at CPA 150 m, then CPA 0 for 30 s.
      for (let s = 0; s <= 630; s += 2) {
        const time = NOW + s * 1000
        const node = s <= 600 ? sameCourse(600, 150) : sameCourse(600, 0)
        ev.evaluate(own, { [OTHER]: stamped(node, time) }, SELF, time)
      }
      expect(levels(sink)).toEqual(['warn'])
    })

    it('warns as early as the normal limits when it turns into us', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 392 m ahead, 699 m to starboard, on our course: overtaken.
      ev.evaluate(own, { [OTHER]: sameCourse(392, 699) }, SELF, NOW)
      expect(sink.calls).toEqual([])
      // It turns to 345° at 4.5 m/s: still slow between us, but a collision
      // course, CPA 0 in 10 min, warned 30 s on.
      hold(ev, sameCourse(392, 699, 4.5, 345), NOW + 2000, 26)
      expect(sink.calls).toEqual([])
      ev.evaluate(own, { [OTHER]: sameCourse(392, 699, 4.5, 345) }, SELF, NOW + 30_000)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
    })

    it('counts as overtaken on our port side, across north', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 400 m off on 350°, sailing 010° at 4 m/s: CPA 158 m in 4.8 min, a
      // Coastal alarm.
      ev.evaluate(own, { [OTHER]: bearingFrom(400, 350, 10, 4) }, SELF, NOW)
      expect(sink.calls).toEqual([])
    })

    it('counts as overtaken only from more than 22.5° abaft its beam', () => {
      // 600 m off, on our course: its course 67.4° off the line from us to it,
      // then 67.6°. Both are Coastal warnings, passing over 500 m off.
      const within = setup({ slowSpeed: 1.5 })
      within.ev.evaluate(own, { [OTHER]: bearingFrom(600, 67.4, 0, 4) }, SELF, NOW)
      expect(within.sink.calls).toEqual([])
      const outside = setup({ slowSpeed: 1.5 })
      outside.ev.evaluate(own, { [OTHER]: bearingFrom(600, 67.6, 0, 4) }, SELF, NOW)
      expect(outside.sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
    })

    it('stays overtaken as we draw abeam and pass', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // From 600 m ahead, 300 m to starboard, we gain 1 m/s on it. Once it
      // is less than 124 m ahead we no longer come up on it from abaft its
      // beam, and at 100 m ahead the Coastal limits would alarm (CPA 300 m in
      // 100 s).
      for (let s = 0; s <= 700; s += 20) {
        const time = NOW + s * 1000
        ev.evaluate(own, { [OTHER]: stamped(sameCourse(600 - s, 300), time) }, SELF, time)
      }
      expect(sink.calls).toEqual([])
    })

    it('stays overtaken through a moment without own data', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
      ev.evaluate(null, { [OTHER]: abeam() }, SELF, NOW + 2000)
      // Nearly abeam, 30 m ahead and 300 m to starboard: CPA 300 m in 30 s, a
      // Coastal alarm, and too far abeam to count as overtaken anew.
      ev.evaluate(own, { [OTHER]: sameCourse(30, 300) }, SELF, NOW + 4000)
      expect(sink.calls).toEqual([])
    })

    it('ignores the clock going back when letting it go', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
      // The clock goes back an hour, and for 70 s we have no data of our own.
      for (let s = 0; s <= 70; s += 2) {
        ev.evaluate(null, { [OTHER]: abeam() }, SELF, NOW - 3_600_000 + s * 1000)
      }
      // 400 m off on 030°, sailing 345° at 4.9 m/s: a Coastal alarm once let go.
      ev.evaluate(own, { [OTHER]: bearingFrom(400, 30, 345, 4.9) }, SELF, NOW - 3_528_000)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('is let go after a minute without usable data', () => {
      // Then 400 m off on 030°, sailing 345° at 4.9 m/s and converging: CPA
      // 298 m in 3.4 min, a Coastal alarm. We don't gain on it along its
      // course, so it is not overtaken anew.
      const after = (gapS: number) => {
        const { sink, ev } = setup({ slowSpeed: 1.5 })
        ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
        for (let s = 2; s <= gapS; s += 2) {
          ev.evaluate(null, { [OTHER]: abeam() }, SELF, NOW + s * 1000)
        }
        ev.evaluate(own, { [OTHER]: bearingFrom(400, 30, 345, 4.9) }, SELF, NOW + (gapS + 2) * 1000)
        return sink.calls
      }
      expect(after(50)).toEqual([])
      expect(after(70)).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('stays overtaken should it come up on us again slowly', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // We pass it 300 m off and sail on until it is 400 m astern.
      for (let s = 0; s <= 1000; s += 20) {
        const time = NOW + s * 1000
        ev.evaluate(own, { [OTHER]: stamped(sameCourse(600 - s, 300), time) }, SELF, time)
      }
      // Then it comes up on us from astern, 0.3 m/s faster: 100 m astern,
      // 200 m to starboard, CPA 200 m in 5.6 min, a Coastal alarm.
      const time = NOW + 1020_000
      ev.evaluate(own, { [OTHER]: stamped(sameCourse(-100, 200, 5.3), time) }, SELF, time)
      expect(sink.calls).toEqual([])
    })

    it('stays overtaken when our wind drops, until it is clearly faster', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
      // We have drawn abeam, 300 m off on 100°, when our wind drops to 3 m/s.
      const becalmed = defined(toTrack(vessel(50, 1, 0, 3), NOW, 360))
      // At 3.3 and then 4.5 m/s it gains on us, 1.5 m/s at most: still
      // overtaken, though CPA 296 m within 3 min is a Coastal alarm.
      ev.evaluate(becalmed, { [OTHER]: bearingFrom(300, 100, 0, 3.3) }, SELF, NOW + 2000)
      ev.evaluate(becalmed, { [OTHER]: bearingFrom(300, 100, 0, 4.5) }, SELF, NOW + 4000)
      expect(sink.calls).toEqual([])
      // At 5 m/s, 2 m/s between us, it is overtaking us: the Coastal limits.
      ev.evaluate(becalmed, { [OTHER]: bearingFrom(300, 100, 0, 5) }, SELF, NOW + 6000)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('is let go once too far off for the normal limits to raise it', () => {
      // The zones listed strictest first, so the farthest-reaching is not the
      // first.
      const zones = [...PRESETS.coastal].reverse()
      // Later we meet it again 400 m off on 030°, sailing 345° at 4.9 m/s and
      // converging: CPA 298 m in 3.4 min, a Coastal alarm. We don't gain on
      // it along its course, so it is not overtaken anew.
      const again = bearingFrom(400, 30, 345, 4.9)
      // 2100 m astern, within the 2186 m at which the Coastal limits could
      // still raise a boat 1.75 m/s from us: still overtaken.
      const near = setup({ slowSpeed: 1.5, zones })
      near.ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
      near.ev.evaluate(own, { [OTHER]: bearingFrom(2100, 180, 0, 4) }, SELF, NOW + 2000)
      near.ev.evaluate(own, { [OTHER]: again }, SELF, NOW + 4000)
      expect(near.sink.calls).toEqual([])
      // 2300 m astern: let go.
      const far = setup({ slowSpeed: 1.5, zones })
      far.ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
      far.ev.evaluate(own, { [OTHER]: bearingFrom(2300, 180, 0, 4) }, SELF, NOW + 2000)
      far.ev.evaluate(own, { [OTHER]: again }, SELF, NOW + 4000)
      expect(far.sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('stays overtaken until the speed between us is clearly above the threshold', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: abeam() }, SELF, NOW)
      // 1.6 m/s between us, just above the threshold: still overtaken.
      ev.evaluate(own, { [OTHER]: abeam(3.4) }, SELF, NOW)
      expect(sink.calls).toEqual([])
      ev.evaluate(own, { [OTHER]: abeam(3) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('keeps an alarm raised under the normal limits until it clears', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 1.6 m/s between us, within the margin but not yet below the threshold:
      // the normal limits, and an alarm.
      ev.evaluate(own, { [OTHER]: abeam(3.4) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
      // Speed noise takes it below the threshold and back: the alarm stands.
      ev.evaluate(own, { [OTHER]: abeam(3.6) }, SELF, NOW + 2000)
      ev.evaluate(own, { [OTHER]: abeam(3.4) }, SELF, NOW + 4000)
      expect(levels(sink)).toEqual(['alarm', 'alarm', 'alarm'])
    })

    it('becomes overtaken while an alarm raised under the normal limits stands', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      ev.evaluate(own, { [OTHER]: abeam(3.4) }, SELF, NOW)
      // Below the threshold it is overtaken, though the alarm stands.
      ev.evaluate(own, { [OTHER]: abeam(3.6) }, SELF, NOW + 2000)
      // 400 m astern, 300 m to starboard: past, and the alarm clears.
      ev.evaluate(own, { [OTHER]: sameCourse(-400, 300) }, SELF, NOW + 4000)
      // It comes up on us again, 0.3 m/s faster: 100 m astern, 300 m to
      // starboard, CPA 300 m in 5.6 min, a Coastal alarm.
      ev.evaluate(own, { [OTHER]: sameCourse(-100, 300, 5.3) }, SELF, NOW + 6000)
      expect(levels(sink)).toEqual(['alarm', 'alarm', undefined])
    })

    it('keeps an alarm raised under the normal limits when we slow down', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // A boat 0.2 NM ahead, 150 m to starboard of our track, coming our way
      // at 0.6 m/s: CPA 150 m within 3 min, a Coastal alarm, nothing in Harbour.
      const target = vessel(50 + 0.2 / 60, 1 + 150 / 1852 / 60 / COS50, 180, 0.6)
      const at = (sog: number) => defined(toTrack(vessel(50, 1, 0, sog), NOW, 360))
      ev.evaluate(at(2), { [OTHER]: target }, SELF, NOW)
      // We slow below the threshold: both boats slow, but the alarm stands.
      ev.evaluate(at(1.4), { [OTHER]: target }, SELF, NOW + 2000)
      ev.evaluate(at(2), { [OTHER]: target }, SELF, NOW + 4000)
      expect(levels(sink)).toEqual(['alarm', 'alarm', 'alarm'])
    })

    it('keeps the normal limits for a level the Harbour limits rated higher for a while', () => {
      // Custom limits with a warning only.
      const zones = [{ level: 'warn' as const, cpa: 926, tcpa: 720 }]
      const { sink, ev } = setup({ slowSpeed: 1.5, zones })
      const ahead = (eastM: number, sog: number) =>
        vessel(50 + 280 / 1852 / 60, 1 + eastM / 1852 / 60 / COS50, 180, sog)
      // We make 1 m/s. 280 m ahead and 45 m to starboard at 1.8 m/s, it warns.
      const at1 = defined(toTrack(vessel(50, 1, 0, 1), NOW, 360))
      ev.evaluate(at1, { [OTHER]: ahead(45, 1.8) }, SELF, NOW)
      // At 1.4 m/s both boats are slow: CPA 45 m in 117 s, a Harbour alarm.
      ev.evaluate(at1, { [OTHER]: ahead(45, 1.4) }, SELF, NOW + 2000)
      // 125 m off, outside the Harbour limits, and back at 1.8 m/s: the
      // warning stands.
      ev.evaluate(at1, { [OTHER]: ahead(125, 1.4) }, SELF, NOW + 4000)
      ev.evaluate(at1, { [OTHER]: ahead(125, 1.8) }, SELF, NOW + 6000)
      expect(levels(sink)).toEqual(['warn', 'alarm', 'warn', 'warn'])
    })

    it('raises a held level further by the limits it is judged by now', () => {
      // Custom limits with an alarm at 25 m, narrower than the Harbour 50 m.
      const zones = [
        { level: 'warn' as const, cpa: 926, tcpa: 720 },
        { level: 'alarm' as const, cpa: 25, tcpa: 360 }
      ]
      const { sink, ev } = setup({ slowSpeed: 1.5, zones })
      // 200 m ahead, 40 m to starboard, coming our way at 0.6 m/s.
      const target = vessel(50 + 200 / 1852 / 60, 1 + 40 / 1852 / 60 / COS50, 180, 0.6)
      const at = (sog: number) => defined(toTrack(vessel(50, 1, 0, sog), NOW, 360))
      // At 2 m/s, CPA 40 m in 77 s: a warning by the custom limits.
      ev.evaluate(at(2), { [OTHER]: target }, SELF, NOW)
      // We slow to 1.4 m/s, both boats slow: CPA 40 m in 100 s, a Harbour alarm.
      ev.evaluate(at(1.4), { [OTHER]: target }, SELF, NOW + 2000)
      // Its CPA wanders out to 55 m and back: the alarm holds by the Harbour
      // limits' margin.
      const wider = vessel(50 + 200 / 1852 / 60, 1 + 55 / 1852 / 60 / COS50, 180, 0.6)
      ev.evaluate(at(1.4), { [OTHER]: wider }, SELF, NOW + 4000)
      ev.evaluate(at(1.4), { [OTHER]: target }, SELF, NOW + 6000)
      expect(levels(sink)).toEqual(['warn', 'alarm', 'alarm', 'alarm'])
    })

    it('counts as overtaken though the normal limits judged it before', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 1500 m ahead, 80 m to starboard, gaining 2 m/s: the normal limits, but
      // CPA is 12.5 min away.
      ev.evaluate(own, { [OTHER]: sameCourse(1500, 80, 3) }, SELF, NOW)
      // It slows our gain to 1 m/s, 300 m ahead: CPA 80 m in 5 min, a Coastal
      // alarm, a warning when overtaken.
      hold(ev, sameCourse(300, 80), NOW + 2000, 32)
      expect(levels(sink)).toEqual(['warn', 'warn'])
    })

    it('keeps the Harbour limits when both boats are slow', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // We make 1.4 m/s; 100 m dead ahead it makes 0.9 m/s on our course: CPA
      // 0 in 200 s, a Harbour warning, an alarm by the normal limits' timing.
      const slowOwn = defined(toTrack(vessel(50, 1, 0, 1.4), NOW, 360))
      ev.evaluate(slowOwn, { [OTHER]: sameCourse(100, 0, 0.9) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
    })

    it('keeps the normal limits for a boat ahead we gain on fast at an angle', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 400 m off on 010°, sailing 025° at 3.6 m/s: we come up on it from
      // abaft its beam and gain 0.9 m/s on it along its course, but the speed
      // between us is 2.3 m/s. CPA 312 m in 109 s.
      ev.evaluate(own, { [OTHER]: bearingFrom(400, 10, 25, 3.6) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })
  })

  describe('a boat closing slowly that we do not overtake', () => {
    const COS50 = Math.cos((50 * Math.PI) / 180)
    const at = (northM: number, eastM: number, cogDeg: number, sog: number) =>
      vessel(50 + northM / 1852 / 60, 1 + eastM / 1852 / 60 / COS50, cogDeg, sog)
    const bearingFrom = (rangeM: number, bearingDeg: number, cogDeg: number, sog: number) => {
      const b = (bearingDeg * Math.PI) / 180
      return at(rangeM * Math.cos(b), rangeM * Math.sin(b), cogDeg, sog)
    }

    it('keeps the normal limits when it crosses at a fine angle', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // On 345° at our speed, 388 m to starboard and 51 m ahead: a collision
      // course 15° off ours, 1.3 m/s between us. CPA 0 in 5 min.
      ev.evaluate(own, { [OTHER]: at(51, 388, 345, 5) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('keeps the normal limits when it converges at a fine angle and we do not gain on it', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 400 m off on 030°, sailing 345° at 4.9 m/s: we come up on it from
      // abaft its beam and are faster, but not along its course. CPA 298 m
      // in 3.4 min.
      ev.evaluate(own, { [OTHER]: bearingFrom(400, 30, 345, 4.9) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })

    it('keeps the normal limits when it crosses ahead of us at a fine angle', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 700 m off on 055°, sailing 345° at 4.6 m/s: ahead of us and slower,
      // but its course is 70° off the line from us to it. CPA 121 m in 8.8 min.
      ev.evaluate(own, { [OTHER]: bearingFrom(700, 55, 345, 4.6) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
    })

    it('keeps the normal limits when it overtakes us', () => {
      const { sink, ev } = setup({ slowSpeed: 1.5 })
      // 400 m astern, 60 m to starboard, 1.2 m/s faster on our course: CPA
      // 60 m in 5.6 min.
      ev.evaluate(own, { [OTHER]: at(-400, 60, 0, 6.2) }, SELF, NOW)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
    })
  })

  it('keeps the normal zones for a fast target while own ship is slow', () => {
    const { sink, ev } = setup({ slowSpeed: 1.5 })
    const slowOwn = defined(toTrack(vessel(50, 1, 0, 1), NOW, 360))
    // A ship 2 NM ahead at 10 m/s, passing 300 m off: a Coastal alarm, no Harbour one.
    const ship = vessel(50 + 2 / 60, 1 + 300 / 1852 / 60 / Math.cos((50 * Math.PI) / 180), 180, 10)
    ev.evaluate(slowOwn, { [OTHER]: ship }, SELF, NOW)
    expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
  })

  it('alarms only the most urgent targets and promotes the next when one clears', () => {
    const { sink, ev } = setup({ maxAlarms: 2 })
    // Three boats dead ahead, closing at 5 m/s from 0.4, 0.6 and 0.8 NM.
    const near = vessel(50 + 0.4 / 60, 1, 180, 5)
    const mid = vessel(50 + 0.6 / 60, 1, 180, 5)
    const far = vessel(50 + 0.8 / 60, 1, 180, 5)
    ev.evaluate(own, { [OTHER]: far, [THIRD]: mid, [FOURTH]: near }, SELF, NOW)
    expect(new Map(sink.calls)).toEqual(
      new Map([
        [FOURTH, expect.objectContaining({ level: 'alarm' })],
        [THIRD, expect.objectContaining({ level: 'alarm' })]
      ])
    )

    sink.calls = []
    ev.evaluate(own, { [OTHER]: far, [THIRD]: mid }, SELF, NOW)
    expect(sink.calls).toContainEqual([FOURTH, undefined])
    expect(sink.calls).toContainEqual([OTHER, expect.objectContaining({ level: 'alarm' })])
  })

  it('lets a higher level displace a lower one at the cap', () => {
    const { sink, ev } = setup({ maxAlarms: 1 })
    // Passing 0.4 NM abeam (warn) versus coming straight at us (alarm).
    const passing = vessel(50 + 0.5 / 60, 1 + 0.4 / 60 / Math.cos((50 * Math.PI) / 180), 180, 5)
    const headOn = vessel(50 + 1 / 60, 1, 180, 5)
    ev.evaluate(own, { [OTHER]: passing }, SELF, NOW)
    expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])

    sink.calls = []
    ev.evaluate(own, { [OTHER]: passing, [THIRD]: headOn }, SELF, NOW)
    expect(sink.calls).toContainEqual([THIRD, expect.objectContaining({ level: 'alarm' })])
    expect(sink.calls).toContainEqual([OTHER, undefined])
  })

  describe('a target pushed out at the cap', () => {
    const COS50 = Math.cos((50 * Math.PI) / 180)
    // `northNm` north, passing `eastNm` abeam, closing at 10 m/s with us.
    const at = (northNm: number, eastNm: number) =>
      vessel(50 + northNm / 60, 1 + eastNm / 60 / COS50, 180, 5)
    // A warning: CPA 0.4 NM in 93 s.
    const passing = at(0.5, 0.4)
    // An alarm: CPA 0 in 185 s.
    const headOn = at(1, 0)
    // In no zone: CPA 2 NM.
    const wide = at(3, 2)
    const pushedOut = () => {
      const { sink, ev } = setup({ maxAlarms: 1 })
      ev.evaluate(own, { [OTHER]: passing }, SELF, NOW)
      ev.evaluate(own, { [OTHER]: passing, [THIRD]: headOn }, SELF, NOW + 2000)
      sink.calls = []
      return { sink, ev }
    }

    it('is held back for two minutes as a warning, the place free or not', () => {
      const { sink, ev } = pushedOut()
      // The head-on boat is gone, which frees the place.
      ev.evaluate(own, { [OTHER]: passing }, SELF, NOW + 4000)
      // A report without a course doesn't start the hold anew.
      const noCourse = at(0.5, 0.4)
      delete defined(noCourse.navigation).courseOverGroundTrue
      ev.evaluate(own, { [OTHER]: noCourse }, SELF, NOW + 120_000)
      // Pushed out at NOW + 2 s: the last moment of the hold.
      ev.evaluate(own, { [OTHER]: passing }, SELF, NOW + 121_999)
      expect(sink.calls).toEqual([[THIRD, undefined]])
      ev.evaluate(own, { [OTHER]: passing }, SELF, NOW + 122_000)
      expect(sink.calls.at(-1)).toEqual([OTHER, expect.objectContaining({ level: 'warn' })])
    })

    it('is raised at once at a higher level, and stays raised when it drops back', () => {
      const { sink, ev } = pushedOut()
      // It turns towards us as the head-on boat goes.
      ev.evaluate(own, { [OTHER]: headOn }, SELF, NOW + 4000)
      ev.evaluate(own, { [OTHER]: passing }, SELF, NOW + 6000)
      expect(sink.calls).toEqual([
        [THIRD, undefined],
        [OTHER, expect.objectContaining({ level: 'alarm' })],
        [OTHER, expect.objectContaining({ level: 'warn' })]
      ])
    })

    it('is never held back as an alarm', () => {
      const { sink, ev } = setup({ maxAlarms: 1 })
      ev.evaluate(own, { [OTHER]: headOn }, SELF, NOW)
      // Head-on from 0.3 NM, closest approach 2 min sooner: it takes the place.
      ev.evaluate(own, { [OTHER]: headOn, [FOURTH]: at(0.3, 0) }, SELF, NOW + 2000)
      sink.calls = []
      ev.evaluate(own, { [OTHER]: headOn }, SELF, NOW + 4000)
      expect(sink.calls).toEqual([
        [FOURTH, undefined],
        [OTHER, expect.objectContaining({ level: 'alarm' })]
      ])
    })

    it('stays held back through a report without a course', () => {
      const { sink, ev } = pushedOut()
      const noCourse = at(0.5, 0.4)
      delete defined(noCourse.navigation).courseOverGroundTrue
      ev.evaluate(own, { [OTHER]: noCourse }, SELF, NOW + 4000)
      ev.evaluate(own, { [OTHER]: passing }, SELF, NOW + 6000)
      expect(sink.calls).toEqual([[THIRD, undefined]])
    })

    it('stays held back through a moment without own data', () => {
      const { sink, ev } = pushedOut()
      ev.evaluate(null, { [OTHER]: passing }, SELF, NOW + 4000)
      ev.evaluate(own, { [OTHER]: passing }, SELF, NOW + 6000)
      expect(sink.calls).toEqual([[THIRD, undefined]])
    })

    it('stays held back while it is missing from the data for a moment', () => {
      const { sink, ev } = pushedOut()
      ev.evaluate(own, {}, SELF, NOW + 4000)
      ev.evaluate(own, { [OTHER]: passing }, SELF, NOW + 6000)
      expect(sink.calls).toEqual([[THIRD, undefined]])
    })

    it('keeps the hold when raising another target fails', () => {
      const { sink, ev } = setup({ maxAlarms: 1 })
      ev.evaluate(own, { [OTHER]: passing }, SELF, NOW)
      const set = sink.set.bind(sink)
      sink.set = (id: string, alert: CollisionAlert | undefined) => {
        if (alert) {
          throw new Error('raise failed')
        }
        set(id, alert)
      }
      // The warning is cleared for the head-on boat, whose alarm fails.
      expect(() =>
        ev.evaluate(own, { [OTHER]: passing, [THIRD]: headOn }, SELF, NOW + 2000)
      ).toThrow('raise failed')
      sink.set = set
      sink.calls = []
      // The head-on boat, never raised, is gone; the warning stays held back.
      ev.evaluate(own, { [OTHER]: passing }, SELF, NOW + 4000)
      expect(sink.calls).toEqual([])
    })

    it('keeps the hold time of a target left raised by a failed clear', () => {
      const FIFTH = 'urn:mrn:imo:mmsi:555555555'
      const { sink, ev } = setup({ maxAlarms: 2 })
      // Two warnings, 0.4 NM to either side.
      const warnings = { [OTHER]: passing, [FOURTH]: at(0.5, -0.4) }
      ev.evaluate(own, warnings, SELF, NOW)
      const set = sink.set.bind(sink)
      let failed = false
      sink.set = (id: string, alert: CollisionAlert | undefined) => {
        if (!alert && !failed) {
          failed = true
          throw new Error('clear failed')
        }
        set(id, alert)
      }
      // Two head-on boats push both out, and the first clear fails.
      const alarms = { [THIRD]: headOn, [FIFTH]: at(1, 0.05) }
      expect(() => ev.evaluate(own, { ...warnings, ...alarms }, SELF, NOW + 2000)).toThrow(
        'clear failed'
      )
      ev.evaluate(own, { ...warnings, ...alarms }, SELF, NOW + 4000)
      sink.calls = []
      // Both holds end 2 minutes after the push-out.
      ev.evaluate(own, warnings, SELF, NOW + 122_000)
      const raised = sink.calls.filter(([, alert]) => alert).map(([id]) => id)
      expect(raised.sort()).toEqual([OTHER, FOURTH].sort())
    })

    it('lets go of the hold when raising it higher fails', () => {
      const { sink, ev } = pushedOut()
      const set = sink.set.bind(sink)
      sink.set = (id: string, alert: CollisionAlert | undefined) => {
        if (alert) {
          throw new Error('raise failed')
        }
        set(id, alert)
      }
      // It turns towards us as the head-on boat goes, and its alarm fails.
      expect(() => ev.evaluate(own, { [OTHER]: headOn }, SELF, NOW + 4000)).toThrow('raise failed')
      sink.set = set
      sink.calls = []
      // Back to a warning, it keeps its place.
      ev.evaluate(own, { [OTHER]: passing }, SELF, NOW + 6000)
      expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
    })

    it('is raised at once once it has left every zone or the range in between', () => {
      // 13 NM off, beyond the 12 NM range.
      for (const away of [wide, at(13, 0)]) {
        const { sink, ev } = pushedOut()
        ev.evaluate(own, { [OTHER]: away, [THIRD]: headOn }, SELF, NOW + 4000)
        sink.calls = []
        ev.evaluate(own, { [OTHER]: passing }, SELF, NOW + 6000)
        expect(sink.calls).toEqual([
          [THIRD, undefined],
          [OTHER, expect.objectContaining({ level: 'warn' })]
        ])
      }
    })

    it('is let go when the clock goes back, and on stop', () => {
      const back = pushedOut()
      back.ev.evaluate(own, { [OTHER]: passing }, SELF, NOW - 60_000)
      expect(back.sink.calls.at(-1)).toEqual([OTHER, expect.objectContaining({ level: 'warn' })])
      const stopped = pushedOut()
      stopped.ev.stop()
      stopped.sink.calls = []
      stopped.ev.evaluate(own, { [OTHER]: passing }, SELF, NOW + 4000)
      expect(stopped.sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'warn' })]])
    })

    it('leaves the others at a larger cap alone', () => {
      const { sink, ev } = setup({ maxAlarms: 2 })
      const sooner = at(0.5, 0.4)
      // CPA 0.4 NM in 148 s: the later of the two warnings.
      const later = at(0.8, 0.4)
      ev.evaluate(own, { [OTHER]: sooner, [THIRD]: later }, SELF, NOW)
      ev.evaluate(own, { [OTHER]: sooner, [THIRD]: later, [FOURTH]: headOn }, SELF, NOW + 2000)
      expect(sink.calls).toContainEqual([THIRD, undefined])
      sink.calls = []
      ev.evaluate(own, { [OTHER]: sooner, [THIRD]: later }, SELF, NOW + 4000)
      expect(sink.calls).toEqual([
        [FOURTH, undefined],
        [OTHER, expect.objectContaining({ level: 'warn' })]
      ])
    })
  })

  it('keeps an alarmed target over a slightly more urgent newcomer', () => {
    const { sink, ev } = setup({ maxAlarms: 1 })
    const first = vessel(50 + 0.6 / 60, 1, 180, 5)
    // Closest approach 20 s sooner: not enough to take the slot.
    const second = vessel(50 + 0.6 / 60 - 200 / 1852 / 60, 1, 180, 5)
    ev.evaluate(own, { [OTHER]: first }, SELF, NOW)
    sink.calls = []
    ev.evaluate(own, { [OTHER]: first, [THIRD]: second }, SELF, NOW)
    expect(sink.calls).toEqual([[OTHER, expect.objectContaining({ level: 'alarm' })]])
  })

  it('ranks a target that has passed below one still approaching', () => {
    const { sink, ev } = setup({ maxAlarms: 1 })
    // Head-on from 0.1 NM: closest approach in about 18 s.
    const passing = vessel(50 + 0.1 / 60, 1, 180, 5)
    ev.evaluate(own, { [OTHER]: passing }, SELF, NOW)
    // 20 s later it is 10 m astern, its alarm held just past closest approach.
    const astern = vessel(50 - 10 / 1852 / 60, 1, 180, 5)
    const approaching = vessel(50 + 0.6 / 60, 1, 180, 5)
    sink.calls = []
    ev.evaluate(own, { [OTHER]: astern, [THIRD]: approaching }, SELF, NOW)
    expect(sink.calls).toEqual([
      [OTHER, undefined],
      [THIRD, expect.objectContaining({ level: 'alarm' })]
    ])
  })
})
