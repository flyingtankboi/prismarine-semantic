const THREE = require('three')
const { Vec3 } = require('vec3')

// prismarine-viewer expects these globals
global.THREE = global.THREE || THREE
global.Worker = global.Worker || require('worker_threads').Worker
const { createCanvas } = require('node-canvas-webgl/lib')
const { WorldView, Viewer } = require('prismarine-viewer/viewer')
const { verticalFov } = require('./projection')

const ALPHA_TEST = 0.1 // the viewer's own cutoff for textured materials
const DEPTH_RANGE = 256 // metres packed into 24 bits (15 um steps); also the camera far plane
const DEPTH_SKY = 0xffffff

// Cube faces in the camera frame (x right, y down, z forward): name -> [forward, right, down]
const FACES = {
  front: [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  left: [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  right: [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
  up: [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  down: [[0, 1, 0], [1, 0, 0], [0, 0, -1]]
}
const FACE_NAMES = Object.keys(FACES)

const VERT = `
attribute float semId;
varying vec2 vUv;
varying float vId;
varying float vDepth;
void main() {
  vUv = uv;
  vId = semId;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`
const FRAG_HEAD = `
precision highp float;
uniform sampler2D map;
varying vec2 vUv;
varying float vId;
varying float vDepth;
void main() {
  if (texture2D(map, vUv).a < ${ALPHA_TEST.toFixed(2)}) discard;`
const FRAG_SEM = FRAG_HEAD + `
  gl_FragColor = vec4(floor(vId + 0.5) / 255.0, 0.0, 0.0, 1.0);
}`
const FRAG_DEPTH = FRAG_HEAD + `
  float n = min(floor(vDepth / ${DEPTH_RANGE}.0 * 16777216.0), ${DEPTH_SKY - 1}.0);
  float r = floor(n / 65536.0);
  n -= r * 65536.0;
  float g = floor(n / 256.0);
  float b = n - g * 256.0;
  gl_FragColor = vec4(r, g, b, 255.0) / 255.0;
}`

/**
 * World-space forward, right and down unit vectors of the front camera for a mineflayer yaw and pitch.
 * Yaw 0 looks along -z (north) and increases towards -x (west); positive pitch looks up.
 */
function cameraBasis (yaw, pitch) {
  const cp = Math.cos(pitch)
  const f = [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp]
  const r = [Math.cos(yaw), 0, -Math.sin(yaw)]
  const d = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]]
  return { f, r, d }
}

/**
 * Decodes a GL readback of 24-bit packed planar depth (R is the high byte) into metres.
 * @param {Uint8Array} px RGBA pixels, bottom row first
 * @param {number} width image width in pixels
 * @param {number} [height=width] image height in pixels
 * @returns {Float32Array} top row first, Infinity where nothing was drawn
 */
function unpackDepth (px, width, height = width) {
  const out = new Float32Array(width * height)
  for (let row = 0; row < height; row++) {
    const src = (height - 1 - row) * width * 4
    for (let col = 0; col < width; col++) {
      const n = (px[src + col * 4] << 16) | (px[src + col * 4 + 1] << 8) | px[src + col * 4 + 2]
      out[row * width + col] = n === DEPTH_SKY ? Infinity : n / (16777216 / DEPTH_RANGE)
    }
  }
  return out
}

/**
 * Class id per vertex of a section mesh: one class per quad, read at the block that owns the quad.
 * @param {{positions: Float32Array, normals: Float32Array, sx: number, sy: number, sz: number}} g mesher geometry; positions
 *   are relative to the section origin sx, sy, sz
 * @param {(x: number, y: number, z: number) => number} classAt
 */
function quadClasses (g, classAt) {
  const p = g.positions
  const n = g.normals
  const ids = new Uint8Array(p.length / 3)
  for (let q = 0; q < p.length / 12; q++) {
    const o = q * 12
    // quad centre pushed 1 cm back against the normal, so it falls inside the block the face belongs to
    const x = (p[o] + p[o + 3] + p[o + 6] + p[o + 9]) / 4 + g.sx - n[o] * 0.01
    const y = (p[o + 1] + p[o + 4] + p[o + 7] + p[o + 10]) / 4 + g.sy - n[o + 1] * 0.01
    const z = (p[o + 2] + p[o + 5] + p[o + 8] + p[o + 11]) / 4 + g.sz - n[o + 2] * 0.01
    ids.fill(classAt(Math.floor(x), Math.floor(y), Math.floor(z)), q * 4, q * 4 + 4)
  }
  return ids
}

const withTimeout = (promise, ms, what) => Promise.race([promise,
  new Promise((resolve, reject) => setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), ms).unref())])

/**
 * Renders the world a bot is standing in, either as one perspective view (renderView) or as the five 90 degree cube faces
 * (front, left, right, up, down) that fisheye stitching samples (renderFaces). Only the chunks the bot has loaded are drawn.
 *
 * Poses are `{ x, y, z, yaw, pitch }` with the eye at x, y, z in block coordinates and yaw/pitch in radians (see cameraBasis).
 *
 * @param {object} bot a spawned mineflayer bot
 * @param {object} semantic a world from createSemanticWorld
 * @param {object} [opts]
 * @param {number} [opts.viewDistance=5] chunks meshed around the eye; terrain is guaranteed to (viewDistance - 1) * 16 m
 * @param {number} [opts.faceSize=256] face edge in pixels
 * @param {number} [opts.width=faceSize] image width of renderView, in pixels
 * @param {number} [opts.height=faceSize] image height of renderView; renderFaces needs width and height equal
 * @param {number} [opts.workers=1] mesher threads
 * @param {number} [opts.timeoutMs=60000] limit for chunk loading and meshing per pose
 * @returns {{renderView: Function, renderFaces: Function, teleport: Function, close: Function}}
 *   renderView(pose, hfov) resolves to `{ rgb, semantic, depth }` of one pinhole image with the given horizontal fov in
 *   degrees: Uint8Array width*height*3, Uint8Array width*height and Float32Array width*height (planar metres);
 *   renderFaces(pose) resolves to `{ rgb, semantic, depth }`, each an array of 5 buffers in FACE_NAMES order:
 *   Uint8Array size*size*3, Uint8Array size*size (class ids) and Float32Array size*size (planar metres, Infinity for sky);
 *   teleport(pose) runs `/tp` as the bot (it needs op), freezes its physics and resolves once the chunks around it are loaded
 */
function createFaceRenderer (bot, semantic, { viewDistance = 5, faceSize = 256, width = faceSize, height = faceSize, workers = 1, timeoutMs = 60000 } = {}) {
  const canvas = createCanvas(width, height)
  const renderer = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true })
  const gl = renderer.getContext()
  const viewer = new Viewer(renderer, { numWorkers: workers })
  if (!viewer.setVersion(bot.version)) throw new Error('unsupported version ' + bot.version)
  const camera = viewer.camera
  camera.near = 0.1
  camera.far = DEPTH_RANGE
  const setFov = (fov, aspect) => {
    camera.fov = fov
    camera.aspect = aspect
    camera.updateProjectionMatrix()
  }

  viewer.world.geometryHook = (geometry, g) => {
    geometry.setAttribute('semId', new THREE.BufferAttribute(quadClasses(g, semantic.classAt), 1))
  }
  const worldView = new WorldView(bot.world, viewDistance, new Vec3(0, 0, 0))
  viewer.listen(worldView)

  const mkMat = frag => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms: { map: { value: null } } })
  const semMat = mkMat(FRAG_SEM)
  const depthMat = mkMat(FRAG_DEPTH)
  const rgbBackground = viewer.scene.background
  const semBackground = new THREE.Color(semantic.skyId / 255, 0, 0)
  const depthBackground = new THREE.Color(1, 1, 1)
  const px = new Uint8Array(width * height * 4)

  // top-row-first copy of the first n channels of the last readback
  const channels = n => {
    const out = new Uint8Array(width * height * n)
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const src = ((height - 1 - row) * width + col) * 4
        for (let c = 0; c < n; c++) out[(row * width + col) * n + c] = px[src + c]
      }
    }
    return out
  }
  const pass = (material, background) => {
    viewer.scene.overrideMaterial = material
    viewer.scene.background = background
    renderer.render(viewer.scene, camera)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px)
  }

  const missing = (x, z) => {
    const cx = Math.floor(x / 16)
    const cz = Math.floor(z / 16)
    const out = []
    for (let dx = 1 - viewDistance; dx < viewDistance; dx++) {
      for (let dz = 1 - viewDistance; dz < viewDistance; dz++) {
        if (!bot.world.getColumn(cx + dx, cz + dz)) out.push([cx + dx, cz + dz])
      }
    }
    return out
  }

  function waitForColumns (x, z) {
    let check
    return withTimeout(new Promise(resolve => {
      check = () => { if (!missing(x, z).length) resolve() }
      bot.world.on('chunkColumnLoad', check)
      check()
    }), timeoutMs, 'chunks around the eye').finally(() => bot.world.off('chunkColumnLoad', check))
  }

  async function prepare (x, z) {
    await waitForColumns(x, z)
    await worldView.updatePosition({ x, y: 0, z }, true)
    semantic.trim(Math.floor(x / 16), Math.floor(z / 16), viewDistance + 1)
    await viewer.waitForChunksToRender(timeoutMs)
    const map = viewer.world.material.map
    if (!map) throw new Error('texture atlas not loaded, run `npm run prerender`')
    semMat.uniforms.map.value = map
    depthMat.uniforms.map.value = map
  }

  // rgb, class and depth passes of the current camera
  function snapshot () {
    try {
      pass(null, rgbBackground)
      const rgb = channels(3)
      pass(semMat, semBackground)
      const semantic = channels(1)
      pass(depthMat, depthBackground)
      return { rgb, semantic, depth: unpackDepth(px, width, height) }
    } finally {
      viewer.scene.overrideMaterial = null
      viewer.scene.background = rgbBackground
    }
  }

  const aim = (x, y, z, F, R, D) => {
    camera.position.set(x, y, z)
    camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...R), new THREE.Vector3(-D[0], -D[1], -D[2]), new THREE.Vector3(-F[0], -F[1], -F[2])))
    camera.updateMatrixWorld(true)
  }

  return {
    async teleport ({ x, y, z }) {
      bot.physicsEnabled = false
      bot.chat(`/tp ${x} ${y} ${z}`)
      await waitForColumns(x, z)
    },
    async renderView ({ x, y, z, yaw = 0, pitch = 0 }, hfov) {
      await prepare(x, z)
      const { f, r, d } = cameraBasis(yaw, pitch)
      setFov(verticalFov(hfov, width, height), width / height)
      aim(x, y, z, f, r, d)
      return snapshot()
    },
    async renderFaces ({ x, y, z, yaw = 0, pitch = 0 }) {
      if (width !== height) throw new Error('renderFaces needs a square image, got ' + width + 'x' + height)
      await prepare(x, z)
      const { f, r, d } = cameraBasis(yaw, pitch)
      const toWorld = v => [0, 1, 2].map(i => v[0] * r[i] + v[1] * d[i] + v[2] * f[i])
      const out = { rgb: [], semantic: [], depth: [] }
      setFov(90, 1)
      for (const name of FACE_NAMES) {
        aim(x, y, z, ...FACES[name].map(toWorld))
        const shot = snapshot()
        for (const k of Object.keys(out)) out[k].push(shot[k])
      }
      return out
    },
    close () {
      for (const w of viewer.world.workers) w.terminate()
      semMat.dispose()
      depthMat.dispose()
      gl.getExtension('STACKGL_destroy_context')?.destroy()
    }
  }
}

module.exports = { createFaceRenderer, cameraBasis, unpackDepth, quadClasses, FACES, FACE_NAMES, DEPTH_RANGE }
