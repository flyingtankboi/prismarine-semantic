/** Vertical field of view in degrees of a pinhole camera with the given horizontal fov and image size. */
function verticalFov (hfov, width, height) {
  return 2 * Math.atan(Math.tan(hfov * Math.PI / 360) * height / width) * 180 / Math.PI
}

/**
 * Converts planar depth (distance along the optical axis) of a pinhole image into distance along each pixel's ray.
 * @param {Float32Array} depth width*height planar depths
 * @param {number} hfov horizontal field of view in degrees
 * @returns {Float32Array} width*height ranges, Infinity stays Infinity
 */
function zToRange (depth, width, height, hfov) {
  const f = (width / 2) / Math.tan(hfov * Math.PI / 360)
  const out = new Float32Array(depth.length)
  for (let row = 0; row < height; row++) {
    const v = (row + 0.5 - height / 2) / f
    for (let col = 0; col < width; col++) {
      const u = (col + 0.5 - width / 2) / f
      out[row * width + col] = depth[row * width + col] * Math.sqrt(1 + u * u + v * v)
    }
  }
  return out
}

module.exports = { verticalFov, zToRange }
