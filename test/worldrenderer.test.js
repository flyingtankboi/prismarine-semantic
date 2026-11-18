const test = require('node:test')
const assert = require('node:assert')
const { WorldRenderer } = require('prismarine-viewer/viewer/lib/worldrenderer')

test('waitForChunksToRender times out without leaving a listener, and later waits still resolve', async () => {
  const r = new WorldRenderer({}, 0)
  r.sectionsOutstanding.set('0,0,0', 1)
  await assert.rejects(r.waitForChunksToRender(20), /timeout/)
  assert.strictEqual(r.renderUpdateEmitter.listenerCount('update'), 0)
  const later = r.waitForChunksToRender(1000)
  r.sectionsOutstanding.delete('0,0,0')
  r.renderUpdateEmitter.emit('update')
  await later
  await r.waitForChunksToRender(20)
  assert.strictEqual(r.renderUpdateEmitter.listenerCount('update'), 0)
})
