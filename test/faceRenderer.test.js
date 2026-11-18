const test = require('node:test')
const assert = require('node:assert')
const { cameraBasis, unpackDepth, quadClasses, FACES, FACE_NAMES, DEPTH_RANGE } = require('../lib/faceRenderer')

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9)

test('unpackDepth decodes 24-bit packed metres, flips rows, sky is Infinity', () => {
  const size = 2
  const px = new Uint8Array(size * size * 4)
  const put = (row, col, n) => { // row counted from the top; GL buffer is bottom row first
    const o = ((size - 1 - row) * size + col) * 4
    px.set([n >> 16, (n >> 8) & 255, n & 255, 255], o)
  }
  put(0, 0, 65536) // 1 m
  put(0, 1, 65536 * 50 + 123)
  put(1, 0, 0)
  put(1, 1, 0xffffff)
  const d = unpackDepth(px, size)
  assert.strictEqual(d[0], 1)
  assert.ok(Math.abs(d[1] - (50 + 123 / 65536)) < 1e-6)
  assert.strictEqual(d[2], 0)
  assert.strictEqual(d[3], Infinity)
  assert.ok(Math.abs(DEPTH_RANGE / 16777216) < 2e-5) // quantisation step in metres
})

test('face frames are right-handed and front looks along the pose direction', () => {
  for (const [yaw, pitch] of [[0, 0], [1.1, 0.4], [-2, -0.7]]) {
    const { f, r, d } = cameraBasis(yaw, pitch)
    assert.ok(close(cross(r, d), f))
    for (const name of FACE_NAMES) {
      const [F, R, D] = FACES[name]
      assert.ok(close(cross(R, D), F), name)
    }
  }
  assert.ok(close(cameraBasis(0, 0).f, [0, 0, -1])) // yaw 0 = north
  assert.ok(close(cameraBasis(Math.PI / 2, 0).f, [-1, 0, 0])) // yaw +90 = west
  assert.ok(close(cameraBasis(0, 0).d, [0, -1, 0]))
  assert.ok(cameraBasis(0, 0.5).f[1] > 0) // positive pitch looks up
})

test('quadClasses looks up the block that owns each face', () => {
  // one quad on the +x face of block (5, 6, 7): x = 6 plane, normal +x; section centre (0, 0, 0)
  const g = {
    sx: 0,
    sy: 0,
    sz: 0,
    positions: new Float32Array([6, 6, 7, 6, 7, 7, 6, 6, 8, 6, 7, 8]),
    normals: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0])
  }
  const seen = []
  const ids = quadClasses(g, (x, y, z) => { seen.push([x, y, z]); return 3 })
  assert.deepStrictEqual(seen, [[5, 6, 7]])
  assert.deepStrictEqual(Array.from(ids), [3, 3, 3, 3])
})
