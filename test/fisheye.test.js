const test = require('node:test')
const assert = require('node:assert')
const { createLens, stitch } = require('../lib/fisheye')

// Each face is a flat colour, class id and depth, so a pixel tells which face it was sampled from.
const faceSize = 8
const faces = {
  rgb: Array.from({ length: 5 }, (_, k) => new Uint8Array(faceSize * faceSize * 3).fill(10 * (k + 1))),
  semantic: Array.from({ length: 5 }, (_, k) => new Uint8Array(faceSize * faceSize).fill(k)),
  depth: Array.from({ length: 5 }, () => new Float32Array(faceSize * faceSize).fill(2))
}

test('centre pixel comes from the front face and keeps its planar depth', () => {
  const out = stitch(faces, createLens({ width: 41, height: 41, fov: 120, faceSize }))
  const c = 20 * 41 + 20
  assert.strictEqual(out.semantic[c], 0)
  assert.deepStrictEqual(Array.from(out.rgb.subarray(c * 3, c * 3 + 3)), [10, 10, 10])
  assert.ok(Math.abs(out.depth[c] - 2) < 1e-3)
})

test('edge pixels sample the side faces, with ray length above planar depth', () => {
  const out = stitch(faces, createLens({ width: 41, height: 41, fov: 170, span: 'width', faceSize }))
  assert.strictEqual(out.semantic[20 * 41 + 1], 1) // left
  assert.strictEqual(out.semantic[20 * 41 + 39], 2) // right
  assert.strictEqual(out.semantic[1 * 41 + 20], 3) // up
  assert.strictEqual(out.semantic[39 * 41 + 20], 4) // down
  assert.ok(out.depth[20 * 41 + 1] > 2)
})

test('a pinhole lens of 90 degrees across the width only needs the front face', () => {
  const lens = createLens({ width: 40, height: 30, fov: 90, model: 'pinhole', span: 'width', faceSize })
  assert.ok(stitch(faces, lens).semantic.every(s => s === 0))
})

test('a lens that sees behind the camera is rejected', () => {
  assert.throws(() => createLens({ width: 40, height: 40, fov: 300, span: 'width', faceSize }), /behind/)
})
