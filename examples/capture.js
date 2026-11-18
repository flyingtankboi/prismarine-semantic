// Captures an RGB | semantic | depth view at a position, as a PNG, or as a GIF when --frames is above 1 (a full turn).
//   node examples/capture.js --world path/to/world_semantic --pos 120,-58.4,86 --projection fisheye --fov 170 --out view.png
// The bot must be allowed to run /tp, so op it on the server first.
const fs = require('fs')
const { parseArgs } = require('util')
const { PNG } = require('pngjs')
const { GIFEncoder, quantize, applyPalette } = require('gifenc')
const { connect } = require('..')

const { values: a } = parseArgs({
  options: {
    world: { type: 'string' },
    version: { type: 'string', default: '1.21.1' },
    host: { type: 'string', default: 'localhost' },
    port: { type: 'string', default: '25565' },
    pos: { type: 'string' },
    yaw: { type: 'string', default: '0' },
    pitch: { type: 'string', default: '0' },
    frames: { type: 'string', default: '1' },
    projection: { type: 'string', default: 'pinhole' },
    fov: { type: 'string' },
    lens: { type: 'string', default: 'equidistant' },
    width: { type: 'string', default: '256' },
    height: { type: 'string', default: '192' },
    out: { type: 'string' }
  }
})
if (!a.world || !a.pos) {
  console.error(`usage: node examples/capture.js --world <semantic world dir> --pos x,y,z
  [--projection pinhole|fisheye] [--fov degrees] [--lens equidistant|equisolid|stereographic] [--width 256] [--height 192]
  [--yaw deg] [--pitch deg] [--frames 1] [--version 1.21.1] [--host localhost] [--port 25565] [--out file]`)
  process.exit(1)
}
const [x, y, z] = a.pos.split(',').map(Number)
const frames = Number(a.frames)
const out = a.out ?? (frames > 1 ? 'view.gif' : 'view.png')
const W = Number(a.width)
const H = Number(a.height)
const rad = deg => Number(deg) * Math.PI / 180

const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))

// near is warm, far is cool; sky and pixels outside a fisheye circle are black
const RAMP = [[255, 221, 87], [240, 120, 60], [160, 50, 120], [60, 40, 140], [20, 70, 160]]
function depthColour (d) {
  if (d === 0 || d === Infinity) return [0, 0, 0]
  const t = Math.min(Math.sqrt(d / 60), 1) * (RAMP.length - 1)
  const i = Math.min(Math.floor(t), RAMP.length - 2)
  return RAMP[i].map((v, c) => Math.round(v + (RAMP[i + 1][c] - v) * (t - i)))
}

function panels (view, palette) {
  const rgba = new Uint8Array(3 * W * H * 4).fill(255)
  const put = (panel, p, [r, g, b]) => {
    const o = ((p / W | 0) * 3 * W + panel * W + p % W) * 4
    rgba.set([r, g, b], o)
  }
  for (let p = 0; p < W * H; p++) {
    put(0, p, view.rgb.subarray(p * 3, p * 3 + 3))
    put(1, p, palette.get(view.semantic[p]) ?? [0, 0, 0])
    put(2, p, depthColour(view.depth[p]))
  }
  return rgba
}

async function main () {
  const cap = await connect({
    host: a.host,
    port: Number(a.port),
    version: a.version,
    semanticWorldDir: a.world,
    projection: a.projection,
    fov: a.fov && Number(a.fov),
    model: a.lens,
    width: W,
    height: H
  })
  try {
    const palette = new Map(cap.legend.map(e => [e.id, hex(e.colour)]))
    await cap.teleport({ x, y, z })
    const gif = GIFEncoder()
    let png
    for (let i = 0; i < frames; i++) {
      const yaw = rad(a.yaw) + 2 * Math.PI * i / frames
      const rgba = panels(await cap.render({ x, y, z, yaw, pitch: rad(a.pitch) }), palette)
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
