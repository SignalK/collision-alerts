import type { Track } from './cpa.js'
import type { Evaluation } from './evaluator.js'

/** The `navigation.closestApproach` value: metres, and seconds to it. */
export interface ClosestApproach {
  distance: number
  timeTo: number
}

// With no new data on a target and own course and speed unchanged, its
// closest approach stays where it was and only the time to it runs down. It
// is sent again at the first evaluation this long (ms) after the last, for a
// display that does not count it down.
const REFRESH_MS = 10_000

// A change in own velocity (m/s, as a vector) taken as a change of course or
// speed: about 0.2 kn, or 2° at 6 kn. Moves a closest approach 10 min off by
// up to 60 m; smaller changes wait for the refresh.
const OWN_VELOCITY_CHANGE = 0.1

interface Sent {
  target: Track
  reportedAt: number
  ownEast: number
  ownNorth: number
  at: number
}

function velocity(track: Track | null): { east: number; north: number } {
  return track
    ? { east: track.sog * Math.sin(track.cog), north: track.sog * Math.cos(track.cog) }
    : { east: 0, north: 0 }
}

function sameTrack(a: Track, b: Track): boolean {
  return (
    a.position.latitude === b.position.latitude &&
    a.position.longitude === b.position.longitude &&
    a.cog === b.cog &&
    a.sog === b.sog
  )
}

/**
 * Publishes each target's closest approach when it carries something new: new
 * data on the target, a change in own course or speed, or the refresh.
 */
export class ClosestApproachPublisher {
  private readonly sent = new Map<string, Sent>()

  constructor(private readonly send: (context: string, value: ClosestApproach | null) => void) {}

  publish(evaluations: Evaluation[], own: Track | null, nowMs: number): void {
    // A target the server stopped reporting has no evaluation at all, so
    // clear what we published for it as if it had gone out of range.
    const current = new Set(evaluations.map((e) => e.context))
    for (const context of this.sent.keys()) {
      if (!current.has(context)) {
        this.clear(context)
      }
    }
    const { east, north } = velocity(own)
    for (const e of evaluations) {
      if (!e.result) {
        this.clear(e.context)
        continue
      }
      const last = this.sent.get(e.context)
      if (
        last &&
        nowMs >= last.at &&
        nowMs - last.at < REFRESH_MS &&
        last.reportedAt === e.reportedAt &&
        sameTrack(last.target, e.target) &&
        Math.hypot(east - last.ownEast, north - last.ownNorth) <= OWN_VELOCITY_CHANGE
      ) {
        continue
      }
      this.send(e.context, { distance: e.result.cpa, timeTo: e.result.tcpa })
      this.sent.set(e.context, {
        target: e.target,
        reportedAt: e.reportedAt,
        ownEast: east,
        ownNorth: north,
        at: nowMs
      })
    }
  }

  clearAll(): void {
    for (const context of this.sent.keys()) {
      this.clear(context)
    }
  }

  private clear(context: string): void {
    if (this.sent.has(context)) {
      this.send(context, null)
      this.sent.delete(context)
    }
  }
}
