const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const nbt = require('prismarine-nbt')
const { createSemanticWorld, legendMapper, unpackIndices, readChunkBytes, decodeChunk } = require('../lib/semanticWorld')

const LEGEND = [
  { block: 'minecraft:red_concrete', id: 0, name: 'Building' },
  { block: 'minecraft:light_gray_concrete', id: 1, name: 'Road' },
  { block: 'minecraft:air', id: 7, name: 'Sky' }
]

const section = (y, names, data) => ({
  Y: nbt.byte(y),
  block_states: nbt.comp({
    palette: nbt.list(nbt.comp(names.map(n => ({ Name: nbt.string(n) })))),
    ...(data && { data: nbt.longArray(data) })
  })
})

function packFourBit (values) {
  const longs = []
  for (let l = 0; l < 4096 / 16; l++) {
    let v = 0n
    for (let k = 0; k < 16; k++) v |= BigInt(values[l * 16 + k]) << BigInt(k * 4)
    longs.push([Number(BigInt.asIntN(32, v >> 32n)), Number(BigInt.asIntN(32, v & 0xffffffffn))])
  }
  return longs
}

// One stored chunk (0, 0): section 0 is road for x < 8 and building elsewhere, section 1 is all building.
function makeWorld () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semworld-'))
  fs.mkdirSync(path.join(dir, 'region'))
  fs.writeFileSync(path.join(dir, 'semantic_legend.json'), JSON.stringify(LEGEND))
  const idx = Array.from({ length: 4096 }, (_, i) => ((i & 15) < 8 ? 1 : 0))
  const chunk = nbt.writeUncompressed(nbt.comp({
    sections: nbt.list(nbt.comp([
      section(0, ['minecraft:red_concrete', 'minecraft:light_gray_concrete'], packFourBit(idx)),
      section(1, ['minecraft:red_concrete'])
    ]))
  }))
  const body = zlib.deflateSync(chunk)
  const file = Buffer.alloc(8192 + 4096 * Math.ceil((body.length + 5) / 4096))
  file.writeUIntBE(2, 0, 3)
  file.writeUInt32BE(body.length + 1, 8192)
  file[8192 + 4] = 2
  body.copy(file, 8192 + 5)
  fs.writeFileSync(path.join(dir, 'region', 'r.0.0.mca'), file)
  return dir
}

test('legendMapper maps legend blocks and sends unknown blocks to 255', () => {
  const classOf = legendMapper(LEGEND)
  assert.strictEqual(classOf('minecraft:light_gray_concrete'), 1)
  assert.strictEqual(classOf('minecraft:air'), 7)
  assert.strictEqual(classOf('minecraft:coal_block'), 255)
})

test('unpackIndices round-trips values packed the 1.16+ way (no entry spans two longs)', () => {
  for (const bits of [4, 5, 6, 7, 9]) {
    const count = 4096
    const perLong = Math.floor(64 / bits)
    const values = Array.from({ length: count }, (_, i) => (i * 7 + 3) % (1 << bits))
    const longs = []
    for (let l = 0; l < Math.ceil(count / perLong); l++) {
      let v = 0n
      for (let k = 0; k < perLong && l * perLong + k < count; k++) v |= BigInt(values[l * perLong + k]) << BigInt(k * bits)
      longs.push([Number(BigInt.asIntN(32, v >> 32n)), Number(BigInt.asIntN(32, v & 0xffffffffn))])
    }
    assert.deepStrictEqual(Array.from(unpackIndices(longs, bits, count)), values, `bits=${bits}`)
  }
})

test('classAt reads paletted and uniform sections from a region file', () => {
  const w = createSemanticWorld(makeWorld())
  assert.strictEqual(w.classAt(3, 2, 5), 1)
  assert.strictEqual(w.classAt(12, 2, 5), 0)
  assert.strictEqual(w.classAt(0, 20, 0), 0) // uniform section
  assert.strictEqual(w.classAt(0, 40, 0), 7) // no such section: sky
  assert.strictEqual(w.classAt(100, 0, 0), 255) // chunk not stored
  assert.strictEqual(w.classAt(5000, 0, 5), 255) // no region file
  assert.strictEqual(w.classAt(-1, 0, -1), 255) // negative coordinates
})

test('decodeChunk treats single-entry palettes as uniform sections', () => {
  const bytes = nbt.writeUncompressed(nbt.comp({ sections: nbt.list(nbt.comp([section(0, ['minecraft:red_concrete'])])) }))
  assert.strictEqual(decodeChunk(bytes, legendMapper(LEGEND)).get(0), 0)
})

test('memory stays bounded: LRU cap and trim', () => {
  const w = createSemanticWorld(makeWorld(), { maxChunks: 8 })
  for (let cx = 0; cx < 20; cx++) for (let cz = 0; cz < 20; cz++) w.classAt(cx * 16, 0, cz * 16)
  assert.ok(w.size() <= 8)
  w.trim(19, 19, 0)
  assert.ok(w.size() <= 1)
})

test('readChunkBytes rejects unknown compression', () => {
  const tmp = path.join(os.tmpdir(), 'bad.mca')
  const file = Buffer.alloc(8192 + 8)
  file.writeUIntBE(2, 0, 3)
  file.writeUInt32BE(2, 8192)
  file[8192 + 4] = 9
  fs.writeFileSync(tmp, file)
  assert.throws(() => readChunkBytes(tmp, 0, 0), /unsupported chunk compression 9/)
  fs.unlinkSync(tmp)
})
