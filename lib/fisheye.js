const { FACES, FACE_NAMES } = require('./faceRenderer')

// theta (angle from the optical axis) <-> image radius for a unit focal length
const MODELS = {
  equidistant: { project: t => t, unproject: r => r },
  equisolid: { project: t => 2 * Math.sin(t / 2), unproject: r => (r <= 2 ? 2 * Math.asin(r / 2) : NaN) },
  stereographic: { project: t => 2 * Math.tan(t / 2), unproject: r => 2 * Math.atan(r / 2) }
}

/**
 * Precomputes, for every pixel of a fisheye image, which cube face it samples and where.
 * @param {object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} opts.fov degrees, measured across `span`
 * @param {'equidistant'|'equisolid'|'stereographic'} [opts.model='equidistant']
 * @param {'diagonal'|'width'} [opts.span='diagonal']
 * @param {number} opts.faceSize edge of the faces that will be stitched
 */
function createLens ({ width, height, fov, model = 'equidistant', span = 'diagonal', faceSize }) {
  const lens = MODELS[model]
  if (!lens) throw new Error('unknown fisheye model ' + model)
  const extent = span === 'width' ? width / 2 : Math.hypot(width, height) / 2
  const focal = extent / lens.project(fov * Math.PI / 360)
  const half = faceSize / 2
  const n = width * height
  const face = new Int8Array(n).fill(-1)
  const col = new Float32Array(n)
  const row = new Float32Array(n)
  const cosFwd = new Float32Array(n)
  for (let i = 0; i < height; i++) {
    for (let j = 0; j < width; j++) {
      const u = j + 0.5 - width / 2
      const v = i + 0.5 - height / 2
      const theta = lens.unproject(Math.hypot(u, v) / focal)
      if (!(theta <= Math.PI)) continue
      const phi = Math.atan2(v, u)
      const d = [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)]
      let best = -2
      let k = -1
      FACE_NAMES.forEach((name, idx) => {
        const dot = d[0] * FACES[name][0][0] + d[1] * FACES[name][0][1] + d[2] * FACES[name][0][2]
        if (dot > best) { best = dot; k = idx }
      })
      if (-d[2] > best) throw new Error('lens reaches behind the camera; reduce fov')
      const [F, R, D] = FACES[FACE_NAMES[k]]
      const z = d[0] * F[0] + d[1] * F[1] + d[2] * F[2]
      const p = i * width + j
      face[p] = k
      cosFwd[p] = z
      col[p] = (d[0] * R[0] + d[1] * R[1] + d[2] * R[2]) / z * half + half
      row[p] = (d[0] * D[0] + d[1] * D[1] + d[2] * D[2]) / z * half + half
    }
  }
  return { width, height, faceSize, face, col, row, cosFwd }
}

/**
 * Resamples the output of renderFaces into one fisheye image.
 * RGB is bilinear; classes and depth are nearest. Depth becomes distance along the pixel's ray.
 * Pixels the lens model cannot project are rgb 0, class 255, depth 0.
 * @returns {{rgb: Uint8Array, semantic: Uint8Array, depth: Float32Array}} width*height*3, width*height, width*height
 */
function stitch (faces, lens) {
  const { width, height, faceSize: S, face, col, row, cosFwd } = lens
  const out = { rgb: new Uint8Array(width * height * 3), semantic: new Uint8Array(width * height).fill(255), depth: new Float32Array(width * height) }
  const clamp = v => Math.min(Math.max(v, 0), S - 1)
  for (let p = 0; p < width * height; p++) {
    const k = face[p]
    if (k < 0) continue
    const x = clamp(col[p] - 0.5)
    const y = clamp(row[p] - 0.5)
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const x1 = Math.min(x0 + 1, S - 1)
    const y1 = Math.min(y0 + 1, S - 1)
    const wx = x - x0
    const wy = y - y0
    const rgb = faces.rgb[k]
    for (let c = 0; c < 3; c++) {
      const at = (yy, xx) => rgb[(yy * S + xx) * 3 + c]
      out.rgb[p * 3 + c] = Math.round((1 - wy) * ((1 - wx) * at(y0, x0) + wx * at(y0, x1)) + wy * ((1 - wx) * at(y1, x0) + wx * at(y1, x1)))
    }
    const near = Math.floor(clamp(row[p])) * S + Math.floor(clamp(col[p]))
    out.semantic[p] = faces.semantic[k][near]
    out.depth[p] = faces.depth[k][near] / cosFwd[p]
  }
  return out
}

module.exports = { createLens, stitch, MODELS }
