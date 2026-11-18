const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const nbt = require('prismarine-nbt')

const UNLABELLED = 255
const SKY_FALLBACK = 7

/** Maps block names to class ids using the legend's `{ block, id }` entries; blocks not in the legend map to 255. */
function legendMapper (legend) {
  const ids = new Map(legend.map(e => [e.block, e.id]))
  return name => ids.get(name) ?? UNLABELLED
}

/**
 * Unpacks a 1.16+ paletted container (entries never span two longs).
 * @param {Array<[number, number]>} longs [hi, lo] int32 pairs, as simplified by prismarine-nbt
 * @param {number} bits bits per entry
 * @param {number} count number of entries
 * @returns {Uint16Array} palette indices
 */
function unpackIndices (longs, bits, count) {
  const out = new Uint16Array(count)
  const perLong = Math.floor(64 / bits)
  const mask = (1 << bits) - 1
  for (let i = 0; i < count; i++) {
    const [hi, lo] = longs[Math.floor(i / perLong)]
    const off = (i % perLong) * bits
    out[i] = off === 0 ? lo & mask : off >= 32 ? (hi >>> (off - 32)) & mask : ((lo >>> off) | (hi << (32 - off))) & mask
  }
  return out
}

/** Reads one chunk out of a region file. Returns the decompressed chunk NBT, or null if the chunk is not stored. */
function readChunkBytes (file, cx, cz) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(4)
    fs.readSync(fd, head, 0, 4, 4 * ((cx & 31) + (cz & 31) * 32))
    const sector = head.readUIntBE(0, 3)
    if (sector === 0) return null
    const hdr = Buffer.alloc(5)
    fs.readSync(fd, hdr, 0, 5, sector * 4096)
    const len = hdr.readUInt32BE(0) - 1
    const body = Buffer.alloc(len)
    fs.readSync(fd, body, 0, len, sector * 4096 + 5)
    if (hdr[4] === 2) return zlib.inflateSync(body)
    if (hdr[4] === 1) return zlib.gunzipSync(body)
    if (hdr[4] === 3) return body
    throw new Error(`unsupported chunk compression ${hdr[4]} in ${file}`)
  } finally {
    fs.closeSync(fd)
  }
}

/** Decodes chunk NBT into a Map of section Y -> one class id (uniform section) or 4096 ids indexed y*256+z*16+x. */
function decodeChunk (bytes, classOf) {
  const root = nbt.simplify(nbt.parseUncompressed(bytes))
  const sections = new Map()
  for (const s of root.sections ?? []) {
    const palette = s.block_states.palette.map(p => classOf(p.Name))
    if (palette.length === 1 || !s.block_states.data) { sections.set(s.Y, palette[0]); continue }
    const bits = Math.max(4, Math.ceil(Math.log2(palette.length)))
    const idx = unpackIndices(s.block_states.data, bits, 4096)
    const ids = new Uint8Array(4096)
    for (let i = 0; i < 4096; i++) ids[i] = palette[idx[i]]
    sections.set(s.Y, ids)
  }
  return sections
}

/**
 * Lazy block -> class lookup over the region files of a semantic world, keeping at most `maxChunks` decoded chunks.
 * `classAt(x, y, z)` gives 255 for blocks outside the legend and for chunks that are not stored, and the sky class for
 * missing sections. `trim(cx, cz, radius)` drops chunks more than `radius` chunks (Chebyshev) from chunk cx, cz.
 * @param {string} dir world folder holding region/ and semantic_legend.json
 */
function createSemanticWorld (dir, { maxChunks = 512 } = {}) {
  const legend = JSON.parse(fs.readFileSync(path.join(dir, 'semantic_legend.json'), 'utf8'))
  const classOf = legendMapper(legend)
  const skyId = legend.find(e => e.block === 'minecraft:air')?.id ?? SKY_FALLBACK
  const chunks = new Map() // "cx,cz" -> sections, or null when the chunk is not stored

  function chunk (cx, cz) {
    const key = cx + ',' + cz
    let c = chunks.get(key)
    if (c !== undefined) {
      chunks.delete(key) // re-inserted below to keep LRU order
    } else {
      const file = path.join(dir, 'region', `r.${cx >> 5}.${cz >> 5}.mca`)
      const bytes = fs.existsSync(file) ? readChunkBytes(file, cx, cz) : null
      c = bytes ? decodeChunk(bytes, classOf) : null
      if (chunks.size >= maxChunks) chunks.delete(chunks.keys().next().value)
    }
    chunks.set(key, c)
    return c
  }

  return {
    legend,
    skyId,
    classAt (x, y, z) {
      const c = chunk(x >> 4, z >> 4)
      if (!c) return UNLABELLED
      const s = c.get(y >> 4)
      if (s === undefined) return skyId
      return typeof s === 'number' ? s : s[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)]
    },
    trim (cx, cz, radius) {
      for (const key of chunks.keys()) {
        const [x, z] = key.split(',').map(Number)
        if (Math.max(Math.abs(x - cx), Math.abs(z - cz)) > radius) chunks.delete(key)
      }
    },
    size: () => chunks.size
  }
}

module.exports = { createSemanticWorld, legendMapper, unpackIndices, readChunkBytes, decodeChunk, UNLABELLED }
