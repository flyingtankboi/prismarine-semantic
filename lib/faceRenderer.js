const THREE = require('three')
const { Vec3 } = require('vec3')

// prismarine-viewer expects these globals
global.THREE = global.THREE || THREE
global.Worker = global.Worker || require('worker_threads').Worker
const { createCanvas } = require('node-canvas-webgl/lib')
const { WorldView, Viewer } = require('prismarine-viewer/viewer')

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
 * @param {number} size face edge in pixels
 * @returns {Float32Array} top row first, Infinity where nothing was drawn
 */
function unpackDepth (px, size) {
  const out = new Float32Array(size * size)
  for (let row = 0; row < size; row++) {
    const src = (size - 1 - row) * size * 4
    for (let col = 0; col < size; col++) {
      const n = (px[src + col * 4] << 16) | (px[src + col * 4 + 1] << 8) | px[src + col * 4 + 2]
      out[row * size + col] = n === DEPTH_SKY ? Infinity : n / (16777216 / DEPTH_RANGE)
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
 * Renders the five 90 degree cube faces (front, left, right, up, down) of the world a bot is standing in.
 * Only the chunks the bot has loaded are drawn.
 *
 * Poses are `{ x, y, z, yaw, pitch }` with the eye at x, y, z in block coordinates and yaw/pitch in radians (see cameraBasis).
 *
 * @param {object} bot a spawned mineflayer bot
 * @param {object} semantic a world from createSemanticWorld
 * @param {object} [opts]
 * @param {number} [opts.viewDistance=5] chunks meshed around the eye; terrain is guaranteed to (viewDistance - 1) * 16 m
 * @param {number} [opts.faceSize=256] face edge in pixels
 * @param {number} [opts.workers=1] mesher threads
 * @param {number} [opts.timeoutMs=60000] limit for chunk loading and meshing per pose
 * @returns {{renderFaces: Function, teleport: Function, close: Function}}
 *   renderFaces(pose) resolves to `{ rgb, semantic, depth }`, each an array of 5 buffers in FACE_NAMES order:
 *   Uint8Array size*size*3, Uint8Array size*size (class ids) and Float32Array size*size (planar metres, Infinity for sky);
 *   teleport(pose) runs `/tp` as the bot (it needs op), freezes its physics and resolves once the chunks around it are loaded
 */
function createFaceRenderer (bot, semantic, { viewDistance = 5, faceSize = 256, workers = 1, timeoutMs = 60000 } = {}) {
  const S = faceSize
  const canvas = createCanvas(S, S)
  const renderer = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true })
  const gl = renderer.getContext()
  const viewer = new Viewer(renderer, { numWorkers: workers })
  if (!viewer.setVersion(bot.version)) throw new Error('unsupported version ' + bot.version)
  const camera = viewer.camera
  camera.fov = 90
  camera.aspect = 1
  camera.near = 0.1
  camera.far = DEPTH_RANGE
  camera.updateProjectionMatrix()

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
  const px = new Uint8Array(S * S * 4)

  // top-row-first copy of the first n channels of the last readback
  const channels = n => {
    const out = new Uint8Array(S * S * n)
    for (let row = 0; row < S; row++) {
      for (let col = 0; col < S; col++) {
        const src = ((S - 1 - row) * S + col) * 4
        for (let c = 0; c < n; c++) out[(row * S + col) * n + c] = px[src + c]
      }
    }
    return out
  }
  const pass = (material, background) => {
    viewer.scene.overrideMaterial = material
    viewer.scene.background = background
    renderer.render(viewer.scene, camera)
    gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px)
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

  return {
    async teleport ({ x, y, z }) {
      bot.physicsEnabled = false
      bot.chat(`/tp ${x} ${y} ${z}`)
      await waitForColumns(x, z)
    },
    async renderFaces ({ x, y, z, yaw = 0, pitch = 0 }) {
      await prepare(x, z)
      const { f, r, d } = cameraBasis(yaw, pitch)
      const toWorld = v => [0, 1, 2].map(i => v[0] * r[i] + v[1] * d[i] + v[2] * f[i])
      const out = { rgb: [], semantic: [], depth: [] }
      camera.position.set(x, y, z)
      for (const name of FACE_NAMES) {
        const [F, R, D] = FACES[name].map(toWorld)
        camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
          new THREE.Vector3(...R), new THREE.Vector3(-D[0], -D[1], -D[2]), new THREE.Vector3(-F[0], -F[1], -F[2])))
        camera.updateMatrixWorld(true)
        try {
          pass(null, rgbBackground)
          out.rgb.push(channels(3))
          pass(semMat, semBackground)
          out.semantic.push(channels(1))
          pass(depthMat, depthBackground)
          out.depth.push(unpackDepth(px, S))
        } finally {
          viewer.scene.overrideMaterial = null
          viewer.scene.background = rgbBackground
        }
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
