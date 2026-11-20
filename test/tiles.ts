import { PbfWriter } from 'pbf'

const EXTENT = 4096
const BUFFER = 64
const DEG = Math.PI / 180

/** [x, y] in tile units. */
type Ring = [number, number][]

function zigzag(n: number): number {
  return n < 0 ? -2 * n - 1 : 2 * n
}

/** MVT geometry commands for polygon rings, each given without its closing vertex. */
function geometry(rings: Ring[]): number[] {
  const commands: number[] = []
  let x = 0
  let y = 0
  for (const ring of rings) {
    ring.forEach(([px, py], i) => {
      if (i === 0) commands.push((1 << 3) | 1)
      else if (i === 1) commands.push(((ring.length - 1) << 3) | 2)
      commands.push(zigzag(px - x), zigzag(py - y))
      x = px
      y = py
    })
    commands.push((1 << 3) | 7)
  }
  return commands
}

/** A vector tile with polygon features, each a list of rings, by layer name. */
export function encodeTile(layers: Record<string, Ring[][]>, extent = EXTENT): Uint8Array {
  const tile = new PbfWriter()
  for (const [name, polygons] of Object.entries(layers)) {
    tile.writeMessage(
      3,
      (_: undefined, layer: PbfWriter) => {
        layer.writeVarintField(15, 2)
        layer.writeStringField(1, name)
        for (const rings of polygons) {
          layer.writeMessage(
            2,
            (__: undefined, feature: PbfWriter) => {
              feature.writeVarintField(3, 3)
              feature.writePackedVarint(4, geometry(rings))
            },
            undefined
          )
        }
        layer.writeVarintField(5, extent)
      },
      undefined
    )
  }
  return tile.finish()
}

/** The y in tile units, within tile row `y` at `z`, of a latitude. */
function tileUnitY(latitude: number, z: number, y: number): number {
  const lat = latitude * DEG
  const row = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * 2 ** z
  return Math.round((row - y) * EXTENT)
}

/** A rectangle across the tile and its buffer, from tile unit `top` down to `bottom`. */
function strip(top: number, bottom: number): Ring[][] {
  const north = Math.max(-BUFFER, top)
  const south = Math.min(EXTENT + BUFFER, bottom)
  if (north >= south) return []
  return [
    [
      [
        [-BUFFER, north],
        [EXTENT + BUFFER, north],
        [EXTENT + BUFFER, south],
        [-BUFFER, south]
      ]
    ]
  ]
}

/**
 * Tile z/x/y of a chart with land (`LNDARE`) from `south` to `north` right
 * across it, and, with `water`, a depth area (`DEPARE`) everywhere else.
 */
export function bandTile(
  z: number,
  y: number,
  south: number,
  north: number,
  { water = true, layer = 'LNDARE' } = {}
): Uint8Array {
  const top = tileUnitY(north, z, y)
  const bottom = tileUnitY(south, z, y)
  const layers: Record<string, Ring[][]> = { [layer]: strip(top, bottom) }
  if (water) {
    layers.DEPARE = [...strip(-BUFFER, top), ...strip(bottom, EXTENT + BUFFER)]
  }
  return encodeTile(layers)
}

/**
 * Tile z/x/y of a chart with strips right across it, each from a south to a
 * north latitude, by layer name.
 */
export function stripsTile(
  z: number,
  y: number,
  layers: Record<string, [number, number][]>
): Uint8Array {
  return encodeTile(
    Object.fromEntries(
      Object.entries(layers).map(([name, strips]) => [
        name,
        strips.flatMap(([south, north]) => strip(tileUnitY(north, z, y), tileUnitY(south, z, y)))
      ])
    )
  )
}
