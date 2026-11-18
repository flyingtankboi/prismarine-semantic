const test = require('node:test')
const assert = require('node:assert')
const { verticalFov, zToRange } = require('../lib/projection')
const { createLens, stitch } = require('../lib/fisheye')

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

test('verticalFov follows the aspect ratio', () => {
  assert.ok(near(verticalFov(90, 4, 4), 90))
  assert.ok(near(verticalFov(90, 4, 3), 2 * Math.atan(0.75) * 180 / Math.PI))
})

test('zToRange keeps the centre depth and lengthens rays towards the edge', () => {
  const width = 4
  const height = 4
  const out = zToRange(new Float32Array(width * height).fill(1), width, height, 90)
  assert.strictEqual(out.length, width * height)
  assert.ok(near(out[1 * width + 1], Math.sqrt(1 + 2 * 0.25 ** 2), 1e-5)) // pixel just off the centre
  assert.ok(near(out[0], Math.sqrt(1 + 2 * 0.75 ** 2), 1e-5)) // corner
  assert.ok(zToRange(new Float32Array([Infinity]), 1, 1, 90)[0] === Infinity)
})

// flat faces: class id k on face k, planar depth 1
const faceSize = 8
const faces = {
  rgb: Array.from({ length: 5 }, () => new Uint8Array(faceSize * faceSize * 3)),
  semantic: Array.from({ length: 5 }, (_, k) => new Uint8Array(faceSize * faceSize).fill(k)),
  depth: Array.from({ length: 5 }, () => new Float32Array(faceSize * faceSize).fill(1))
}

test('fisheye output has the requested size and the fov decides which faces are seen', () => {
  const width = 41
  const height = 31
  const wide = stitch(faces, createLens({ width, height, fov: 180, faceSize }))
  const narrow = stitch(faces, createLens({ width, height, fov: 60, faceSize }))
  for (const out of [wide, narrow]) {
    assert.strictEqual(out.rgb.length, width * height * 3)
    assert.strictEqual(out.semantic.length, width * height)
    assert.strictEqual(out.depth.length, width * height)
  }
  const row = Math.floor(height / 2) * width
  assert.strictEqual(wide.semantic[row + 20 - 14], 1) // 14 of the 15 px radius: about 84 degrees off axis, left face
  assert.strictEqual(narrow.semantic[row + 20 - 14], 0)
  assert.ok(narrow.semantic.every(c => c === 0 || c === 255))
})

test('with the circle span, corners outside the image circle stay empty', () => {
  const out = stitch(faces, createLens({ width: 40, height: 30, fov: 170, faceSize }))
  assert.strictEqual(out.semantic[0], 255)
  assert.strictEqual(out.depth[0], 0)
  assert.notStrictEqual(out.semantic[15 * 40 + 20], 255)
})
