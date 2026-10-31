import type { LatLon, Track } from './cpa.js'

// A boat yawing at anchor in gusts reports up to a knot over ground, with a
// course all round the compass, while its position stays within a few metres.
// Between half a knot and a knot, the reported speed is taken only when the
// position has moved the way the reports since an earlier position, averaged,
// point, and about as far as they would have carried the boat. Averaged, the
// reports of a boat yawing at anchor, their courses all round the compass,
// come to little; an AIS boat at anchor reports only every 3 minutes, so for
// one the movement since its previous report must bear out its latest.

/** From this speed (m/s, about 1 kn) on, the reported motion is taken as it is. */
const CONFIRMED_SPEED = 0.51
/** How far back positions are kept, ms: two reports of an AIS boat at anchor (3 min apart). */
const WINDOW = 7 * 60_000
/** Positions closer together in time than this are skipped, ms. */
const SAMPLE_SPACING = 10_000
/**
 * A reported speed is checked against a position at least this old, ms: long
 * enough that a boat sheering back and forth on its rode has come back.
 */
const MIN_INTERVAL = 150_000
/** Share of the distance the averaged reports imply that the position must have moved. */
const CONFIRM_SHARE = 0.7
/** Speed (m/s) the averaged reports must reach, a little below the half knot they start from. */
const MIN_AVERAGE_SPEED = 0.18

const EARTH_RADIUS = 6371008.8
const DEG = Math.PI / 180

interface Sample {
  time: number
  position: LatLon
  /** Reported velocity east and north, m/s. */
  east: number
  north: number
}

/**
 * Remembers each boat's recent positions and sets a reported speed between
 * half a knot and a knot to 0 unless the positions bear it out.
 */
export class MotionCheck {
  private readonly history = new Map<string, Sample[]>()
  /** Each boat's latest report, which falls between the recorded positions. */
  private readonly latest = new Map<string, Sample>()

  /**
   * @param track the boat as reported, `sog` 0 when it reports being stopped
   * @param positionTime when the position was reported, ms since the epoch
   */
  apply(id: string, track: Track, positionTime: number): Track {
    const sample = {
      time: positionTime,
      position: track.position,
      east: track.sog * Math.sin(track.cog),
      north: track.sog * Math.cos(track.cog)
    }
    this.record(id, sample)
    if (track.sog === 0 || track.sog >= CONFIRMED_SPEED) {
      return track
    }
    const earlier = this.earlier(id, positionTime)
    return earlier && bearsOut(earlier, this.since(id, earlier.time))
      ? track
      : { position: track.position, sog: 0, cog: 0 }
  }

  /** Forgets every boat not in `ids`. */
  retain(ids: Set<string>): void {
    for (const id of this.history.keys()) {
      if (!ids.has(id)) {
        this.history.delete(id)
        this.latest.delete(id)
      }
    }
  }

  clear(): void {
    this.history.clear()
    this.latest.clear()
  }

  /** The newest position at least MIN_INTERVAL older than `time`. */
  private earlier(id: string, time: number): Sample | undefined {
    const samples = this.history.get(id) ?? []
    for (let i = samples.length - 1; i >= 0; i--) {
      if (samples[i].time <= time - MIN_INTERVAL) {
        return samples[i].time >= time - WINDOW ? samples[i] : undefined
      }
    }
    return undefined
  }

  /** The positions recorded after `time`, and the latest report. */
  private since(id: string, time: number): Sample[] {
    const samples = (this.history.get(id) ?? []).filter((s) => s.time > time)
    const latest = this.latest.get(id)
    const newer = latest && latest.time > Math.max(time, samples.at(-1)?.time ?? -Infinity)
    return latest && newer ? [...samples, latest] : samples
  }

  private record(id: string, sample: Sample): void {
    const samples = this.history.get(id) ?? []
    const last = samples.at(-1)
    if (!last || sample.time >= last.time + SAMPLE_SPACING) {
      samples.push(sample)
    }
    this.latest.set(id, sample)
    while (samples[0].time < sample.time - WINDOW) {
      samples.shift()
    }
    this.history.set(id, samples)
  }
}

/** Whether the boat has moved from `earlier` as its reports since then, averaged, say. */
function bearsOut(earlier: Sample, reports: Sample[]): boolean {
  if (reports.length === 0) {
    return false
  }
  const east = reports.reduce((sum, s) => sum + s.east, 0) / reports.length
  const north = reports.reduce((sum, s) => sum + s.north, 0) / reports.length
  const speed = Math.hypot(east, north)
  if (speed < MIN_AVERAGE_SPEED) {
    return false
  }
  const last = reports[reports.length - 1]
  const seconds = (last.time - earlier.time) / 1000
  return (
    along(earlier.position, last.position, east / speed, north / speed) >=
    CONFIRM_SHARE * speed * seconds
  )
}

/** How far `to` lies from `from` along the unit vector (east, north), metres. */
function along(from: LatLon, to: LatLon, east: number, north: number): number {
  const cosLat = Math.cos(from.latitude * DEG)
  const dLon = ((((to.longitude - from.longitude + 180) % 360) + 360) % 360) - 180
  return (
    dLon * DEG * cosLat * EARTH_RADIUS * east +
    (to.latitude - from.latitude) * DEG * EARTH_RADIUS * north
  )
}
