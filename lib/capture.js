const mineflayer = require('mineflayer')
const { createFaceRenderer } = require('./faceRenderer')
const { createSemanticWorld } = require('./semanticWorld')

/**
 * Joins a server with an offline-mode bot and returns a face renderer for the world it is in.
 * @param {object} opts
 * @param {string} [opts.host='localhost']
 * @param {number} [opts.port=25565]
 * @param {string} [opts.username='capture']
 * @param {string} opts.version Minecraft version of the server, e.g. '1.21.1'
 * @param {string} opts.semanticWorldDir folder of the semantic twin world (region/ and semantic_legend.json)
 * @param {number} [opts.viewDistance=5] see createFaceRenderer
 * @param {number} [opts.faceSize=256]
 * @returns {Promise<{bot: object, legend: Array, renderFaces: Function, teleport: Function, close: Function}>}
 */
async function connect ({ host = 'localhost', port = 25565, username = 'capture', version, semanticWorldDir, viewDistance = 5, ...renderOpts }) {
  const semantic = createSemanticWorld(semanticWorldDir)
  const bot = mineflayer.createBot({ host, port, username, version, auth: 'offline', viewDistance: viewDistance + 1 })
  await new Promise((resolve, reject) => {
    bot.once('spawn', resolve)
    bot.once('kicked', reason => reject(new Error('kicked ' + JSON.stringify(reason))))
    bot.once('error', reject)
    bot.once('end', () => reject(new Error('connection ended')))
  })
  bot.physicsEnabled = false
  const renderer = createFaceRenderer(bot, semantic, { viewDistance, ...renderOpts })
  return {
    bot,
    legend: semantic.legend,
    renderFaces: renderer.renderFaces,
    teleport: renderer.teleport,
    close () {
      renderer.close()
      bot.end()
    }
  }
}

module.exports = { connect }
