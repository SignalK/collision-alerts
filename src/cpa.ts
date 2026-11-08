export interface LatLon {
  latitude: number
  longitude: number
}

/** A point moving at constant course and speed. Angles in radians, speed in m/s. */
export interface Track {
  position: LatLon
  cog: number
  sog: number
}

export interface CpaResult {
  /** Distance between the two tracks at closest approach, metres. */
  cpa: number
  /** Seconds until closest approach; negative when it has already passed. */
  tcpa: number
  /** Current distance between the tracks, metres. */
  range: number
  /** Speed of the target relative to own ship, m/s. */
  relativeSpeed: number
  /** True bearing of the target from own ship now, radians clockwise from north. */
  bearing: number
  /**
   * How far ahead of own ship, along its course, the target is at closest
   * approach, metres; negative when it passes astern. 0 when own ship is
   * stopped and has no ahead.
   */
  ahead: number
  ownAtCpa: LatLon
  targetAtCpa: LatLon
  /**
   * True when the two tracks keep their current separation, both lying still
   * or moving in company; `tcpa` is then 0 for as long as that lasts.
   */
  keepingDistance: boolean
}

const EARTH_RADIUS = 6371008.8
const DEG = Math.PI / 180

// Relative speeds below this make TCPA numerically meaningless: the two
// tracks keep their current separation, so closest approach is "now".
const MIN_RELATIVE_SPEED_SQ = 1e-6

/**
 * Closest point of approach between two constant-velocity tracks.
 *
 * Positions are projected onto a local plane tangent at own ship. Over the
 * ranges where collision avoidance matters (a few tens of NM) the error of
 * this flat-earth approximation is far below AIS/GNSS position noise, and it
 * keeps the result exact for the relative-motion maths and cheap to compute.
 */
export function computeCpa(own: Track, target: Track): CpaResult {
  const lat0 = own.position.latitude * DEG
  const cosLat = Math.cos(lat0)

  const dLon = wrapDegrees(target.position.longitude - own.position.longitude)
  const rx = dLon * DEG * cosLat * EARTH_RADIUS
  const ry = (target.position.latitude - own.position.latitude) * DEG * EARTH_RADIUS

  const vx = target.sog * Math.sin(target.cog) - own.sog * Math.sin(own.cog)
  const vy = target.sog * Math.cos(target.cog) - own.sog * Math.cos(own.cog)

  const vSq = vx * vx + vy * vy
  const keepingDistance = vSq < MIN_RELATIVE_SPEED_SQ
  const tcpa = keepingDistance ? 0 : -(rx * vx + ry * vy) / vSq
  const cx = rx + vx * tcpa
  const cy = ry + vy * tcpa

  return {
    cpa: Math.hypot(cx, cy),
    tcpa,
    range: Math.hypot(rx, ry),
    relativeSpeed: Math.sqrt(vSq),
    bearing: (Math.atan2(rx, ry) + 2 * Math.PI) % (2 * Math.PI),
    ahead: own.sog > 0 ? cx * Math.sin(own.cog) + cy * Math.cos(own.cog) : 0,
    ownAtCpa: advance(own, tcpa),
    targetAtCpa: advance(target, tcpa),
    keepingDistance
  }
}

/** Where a track is after `seconds` at its course and speed. */
export function advance(track: Track, seconds: number): LatLon {
  const lat = track.position.latitude * DEG
  const distance = track.sog * seconds
  const dy = distance * Math.cos(track.cog)
  const dx = distance * Math.sin(track.cog)
  return {
    latitude: track.position.latitude + dy / EARTH_RADIUS / DEG,
    longitude: wrapDegrees(track.position.longitude + dx / (EARTH_RADIUS * Math.cos(lat)) / DEG)
  }
}

function wrapDegrees(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180
}
