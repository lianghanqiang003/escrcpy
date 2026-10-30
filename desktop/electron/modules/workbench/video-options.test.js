import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { getVideoOptions } from './video-options.js'

test('native resolution zero survives validation instead of falling back to a thumbnail', () => {
  assert.deepEqual(getVideoOptions({ maxSize: 0 }), { maxSize: 0, bitRate: 12000000, fps: 30 })
})

test('higher resolution receives an appropriate bitrate and the default is readable on Retina', () => {
  assert.deepEqual(getVideoOptions(), { maxSize: 1920, bitRate: 8000000, fps: 30 })
  const sizes = [540, 720, 1080, 1920, 0]
  const rates = sizes.map(maxSize => getVideoOptions({ maxSize }).bitRate)
  assert.ok(rates.every((rate, index) => index === 0 || rate > rates[index - 1]))
  assert.equal(getVideoOptions({ maxSize: 1080 }).bitRate, 4000000)
})

test('unsupported sizes and frame rates use bounded defaults; lower requested FPS is preserved', () => {
  for (const maxSize of [-1, 99999, '0', null, Number.NaN])
    assert.equal(getVideoOptions({ maxSize, fps: 99999 }).maxSize, 1920)
  assert.equal(getVideoOptions({ maxSize: 540, fps: 30 }).fps, 24)
  assert.equal(getVideoOptions({ maxSize: 0, fps: 15 }).fps, 15)
  assert.equal(getVideoOptions({ maxSize: 720, fps: -1 }).fps, 24)
})
