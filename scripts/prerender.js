// Builds the texture atlas and block states for one Minecraft version from the local minecraft-assets package.
// Output goes into prismarine-viewer/public, which is not tracked by git. Usage: npm run prerender -- 1.21.1
const fs = require('fs')
const path = require('path')
const mcAssets = require('minecraft-assets')

const viewer = path.dirname(require.resolve('prismarine-viewer/package.json'))
const { makeTextureAtlas } = require(path.join(viewer, 'viewer/lib/atlas'))
const { prepareBlocksStates } = require(path.join(viewer, 'viewer/lib/modelsBuilder'))

const version = process.argv[2] || '1.21.1'
const pub = path.join(viewer, 'public')
fs.mkdirSync(path.join(pub, 'textures'), { recursive: true })
fs.mkdirSync(path.join(pub, 'blocksStates'), { recursive: true })

const assets = mcAssets(version)
const atlas = makeTextureAtlas(assets)
fs.writeFileSync(path.join(pub, 'textures', version + '.png'), atlas.canvas.toBuffer('image/png'))
fs.writeFileSync(path.join(pub, 'blocksStates', version + '.json'), JSON.stringify(prepareBlocksStates(assets, atlas)))
fs.cpSync(assets.directory, path.join(pub, 'textures', version), { recursive: true })
console.log('done', version)
