import { describe, expect, it } from 'vitest'
import { inAnyPolygon, inPolygon, quietPolygons, type Polygon } from '../src/regions.js'

// A 1 x 1 km square around 42.275 N, 8.736 W with a 200 m hole in the middle.
const square: Polygon = [
  [
    [-8.742, 42.27],
    [-8.73, 42.27],
    [-8.73, 42.28],
    [-8.742, 42.28],
    [-8.742, 42.27]
  ],
  [
    [-8.7372, 42.2745],
    [-8.7348, 42.2745],
    [-8.7348, 42.2755],
    [-8.7372, 42.2755],
    [-8.7372, 42.2745]
  ]
]

function region(zoneType: unknown, geometry: unknown = { type: 'Polygon', coordinates: square }) {
  return { name: 'x', feature: { type: 'Feature', geometry, properties: { zoneType } } }
}

describe('inPolygon', () => {
  it('finds a point inside the outer ring', () => {
    expect(inPolygon({ latitude: 42.272, longitude: -8.735 }, square)).toBe(true)
  })

  it('leaves out a point in a hole', () => {
    expect(inPolygon({ latitude: 42.275, longitude: -8.736 }, square)).toBe(false)
  })

  it('leaves out a point outside', () => {
    expect(inPolygon({ latitude: 42.29, longitude: -8.735 }, square)).toBe(false)
  })
})

describe('quietPolygons', () => {
  it('keeps harbour, berth and mooring field regions', () => {
    const polygons = quietPolygons({
      a: region('harbour'),
      b: region('berth'),
      c: region('mooringField')
    })
    expect(polygons).toHaveLength(3)
  })

  it('leaves out regions of other kinds or without a zone type', () => {
    expect(
      quietPolygons({ a: region('anchorage'), b: region(undefined), c: { name: 'bare' } })
    ).toEqual([])
  })

  it('reads every polygon of a MultiPolygon', () => {
    const polygons = quietPolygons({
      a: region('harbour', { type: 'MultiPolygon', coordinates: [square, square] })
    })
    expect(polygons).toHaveLength(2)
  })

  it('skips malformed geometry instead of failing', () => {
    const polygons = quietPolygons({
      a: region('harbour', { type: 'Polygon', coordinates: [[[1, 2]]] }),
      b: region('harbour', { type: 'Polygon', coordinates: 'nope' }),
      c: region('harbour', null),
      d: null
    })
    expect(polygons).toEqual([])
  })

  it('accepts a missing resource list', () => {
    expect(quietPolygons(undefined)).toEqual([])
    expect(inAnyPolygon({ latitude: 42.272, longitude: -8.735 }, [])).toBe(false)
  })
})
