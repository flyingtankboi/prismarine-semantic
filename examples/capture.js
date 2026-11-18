// Captures a fisheye RGB | semantic | depth view at a position, as a PNG, or as a GIF when --frames is above 1 (a full turn).
//   node examples/capture.js --world path/to/world_semantic --version 1.21.1 --port 25566 --pos 120,-58,86 [--frames 24] [--out view.png]
// The bot must be allowed to run /tp, so op it on the server first.
const fs = require('fs')
const { parseArgs } = require('util')
const { PNG } = require('pngjs')
const { GIFEncoder, quantize, applyPalette } = require('gifenc')
const { connect, createLens, stitch } = require('..')

const { values: a } = parseArgs({
  options: {
    world: { type: 'string' },
    version: { type: 'string', default: '1.21.1' },
    host: { type: 'string', default: 'localhost' },
    port: { type: 'string', default: '25565' },
    pos: { type: 'string' },
    yaw: { type: 'string', default: '0' },
    frames: { type: 'string', default: '1' },
    out: { type: 'string' }
  }
})
if (!a.world || !a.pos) {
  console.error('usage: node examples/capture.js --world <semantic world dir> --pos x,y,z [--version 1.21.1] [--host localhost] [--port 25565] [--yaw deg] [--frames 1] [--out file]')
  process.exit(1)
}
const [x, y, z] = a.pos.split(',').map(Number)
const frames = Number(a.frames)
const out = a.out ?? (frames > 1 ? 'view.gif' : 'view.png')
const W = 256
const H = 192

const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))

function panels (view, palette) {
  const rgba = new Uint8Array(3 * W * H * 4).fill(255)
  const put = (panel, p, [r, g, b]) => {
    const o = ((p / W | 0) * 3 * W + panel * W + p % W) * 4
    rgba.set([r, g, b], o)
  }
  for (let p = 0; p < W * H; p++) {
    put(0, p, view.rgb.subarray(p * 3, p * 3 + 3))
    put(1, p, palette.get(view.semantic[p]) ?? [0, 0, 0])
    const d = view.depth[p]
    const g = d === 0 ? 0 : Math.round(255 * (1 - Math.min(d, 50) / 50))
    put(2, p, [g, g, g])
  }
  return rgba
}

async function main () {
  const cap = await connect({ host: a.host, port: Number(a.port), version: a.version, semanticWorldDir: a.world })
  try {
    const palette = new Map(cap.legend.map(e => [e.id, hex(e.colour)]))
    const lens = createLens({ width: W, height: H, fov: 170, faceSize: 256 })
    await cap.teleport({ x, y, z })
    const gif = GIFEncoder()
    let png
    for (let i = 0; i < frames; i++) {
      const yaw = Number(a.yaw) * Math.PI / 180 + 2 * Math.PI * i / frames
      const rgba = panels(stitch(await cap.renderFaces({ x, y, z, yaw }), lens), palette)
      if (frames === 1) {
        png = new PNG({ width: 3 * W, height: H })
        png.data = Buffer.from(rgba)
      } else {
        const colours = quantize(rgba, 256)
        gif.writeFrame(applyPalette(rgba, colours), 3 * W, H, { palette: colours, delay: 100 })
      }
    }
    if (frames === 1) fs.writeFileSync(out, PNG.sync.write(png))
    else { gif.finish(); fs.writeFileSync(out, gif.bytes()) }
    console.log('wrote', out)
  } finally {
    cap.close()
  }
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
