const mineflayer = require('mineflayer')
const { createFaceRenderer } = require('./faceRenderer')
const { createLens, stitch } = require('./fisheye')
const { zToRange } = require('./projection')
const { createSemanticWorld } = require('./semanticWorld')

/**
 * Joins a server with an offline-mode bot and returns a camera on the world it is in.
 * @param {object} opts
 * @param {string} [opts.host='localhost']
 * @param {number} [opts.port=25565]
 * @param {string} [opts.username='capture']
 * @param {string} opts.version Minecraft version of the server, e.g. '1.21.1'
 * @param {string} opts.semanticWorldDir folder of the semantic twin world (region/ and semantic_legend.json)
 * @param {'pinhole'|'fisheye'} [opts.projection='pinhole']
 * @param {number} [opts.fov] degrees: horizontal for pinhole (default 90, below 180), across the image circle for fisheye
 *   (default 170, up to 270)
 * @param {number} [opts.width=320]
 * @param {number} [opts.height=240]
 * @param {'equidistant'|'equisolid'|'stereographic'} [opts.model='equidistant'] fisheye lens model
 * @param {'circle'|'diagonal'|'width'} [opts.span='circle'] image extent that the fisheye fov spans
 * @param {number} [opts.faceSize=256] cube face edge in pixels, fisheye only
 * @param {number} [opts.viewDistance=5] chunks meshed around the eye
 * @param {number} [opts.workers=1] mesher threads
 * @param {number} [opts.timeoutMs=60000] limit for chunk loading and meshing per pose
 * @param {number} [opts.settleMs=1500] quiet time after which a world edge is assumed when part of the chunk disc never arrives
 * @returns {Promise<{bot: object, legend: Array, width: number, height: number, render: Function, renderFaces: Function, teleport: Function, close: Function}>}
 *   render(pose) resolves to `{ rgb, semantic, depth }` for a pose `{ x, y, z, yaw, pitch }` (eye position in blocks, radians):
 *   Uint8Array width*height*3, Uint8Array width*height (class ids) and Float32Array width*height, distance in metres along
 *   each pixel's ray (Infinity for sky; 0 outside a fisheye image circle)
 */
async function connect ({
  host = 'localhost', port = 25565, username = 'capture', version, semanticWorldDir,
  projection = 'pinhole', fov, width = 320, height = 240, model, span, faceSize = 256, viewDistance = 5, workers, timeoutMs, settleMs
}) {
  if (projection !== 'pinhole' && projection !== 'fisheye') throw new Error('projection must be pinhole or fisheye, got ' + projection)
  fov ??= projection === 'fisheye' ? 170 : 90
  if (projection === 'pinhole' && !(fov > 0 && fov < 180)) throw new Error('pinhole fov must be between 0 and 180 degrees, got ' + fov)
  const lens = projection === 'fisheye' ? createLens({ width, height, fov, model, span, faceSize }) : null

  const semantic = createSemanticWorld(semanticWorldDir)
  const bot = mineflayer.createBot({ host, port, username, version, auth: 'offline', viewDistance: viewDistance + 1 })
  await new Promise((resolve, reject) => {
    bot.once('spawn', resolve)
    bot.once('kicked', reason => reject(new Error('kicked ' + JSON.stringify(reason))))
    bot.once('error', reject)
    bot.once('end', () => reject(new Error('connection ended')))
  })
  bot.physicsEnabled = false
  const size = lens ? { faceSize } : { width, height }
  const renderer = createFaceRenderer(bot, semantic, { viewDistance, workers, timeoutMs, settleMs, ...size })

  return {
    bot,
    legend: semantic.legend,
    width,
    height,
    async render (pose) {
      if (lens) return stitch(await renderer.renderFaces(pose), lens)
      const view = await renderer.renderView(pose, fov)
      return { ...view, depth: zToRange(view.depth, width, height, fov) }
    },
    renderFaces: renderer.renderFaces,
    teleport: renderer.teleport,
    close () {
      renderer.close()
      bot.end()
    }
  }
}

module.exports = { connect }
