import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { createVideoDecoder } from './video-decoder.js'

const config = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0x80, 0x1E, 4])
const packet = (sequence, key = sequence === 1) => ({ deviceId: 'phone', sessionId: 'session', sequence, key, timestamp: sequence * 33333, data: new Uint8Array([0, 0, 1, key ? 0x65 : 0x41, sequence]) })

function fixture() {
  const state = { decoders: [], acks: [], drawn: [], errors: [], time: 0 }
  const video = createVideoDecoder({
    createDecoder(callbacks) {
      const decoder = {
        state: 'unconfigured', chunks: [], callbacks, decodeQueueSize: 8,
        configure() { this.state = 'configured' },
        decode(chunk) { this.chunks.push(chunk) },
        close() { this.state = 'closed' },
        reset() { assert.fail('Resetting a live H.264 reference chain is forbidden') },
      }
      state.decoders.push(decoder)
      return decoder
    },
    createChunk: options => options,
    draw: frame => state.drawn.push(frame.timestamp),
    acknowledge: item => state.acks.push(item.sequence),
    onError: error => state.errors.push(error.message),
    now: () => state.time,
  })
  const output = (index, sequence) => {
    const frame = {
      timestamp: sequence * 33333,
      closed: false,
      close() { this.closed = true },
    }
    state.decoders[index].callbacks.output(frame)
    assert.equal(frame.closed, true)
  }
  video.configure(config)
  return { state, video, output }
}

test('ACK is deferred until decoded output; a busy decoder never drops delta references', () => {
  const f = fixture()
  for (let i = 1; i <= 8; i++)
    f.video.decode(packet(i))
  assert.deepEqual(f.state.acks, [])
  assert.equal(f.state.decoders[0].chunks.length, 8)
  for (let i = 1; i <= 8; i++)
    f.output(0, i)
  assert.deepEqual(f.state.acks, [1, 2, 3, 4, 5, 6, 7, 8])
})

test('repeated parameter sets keep reference pictures; changed parameter sets reset safely', () => {
  const f = fixture()
  f.video.decode(packet(1))
  f.video.configure(new Uint8Array(config))
  assert.equal(f.state.decoders.length, 1)
  assert.deepEqual(f.state.acks, [])
  const changed = new Uint8Array(config)
  changed[8] = 5
  f.video.configure(changed)
  assert.equal(f.state.decoders.length, 2)
  assert.deepEqual(f.state.acks, [1])
  f.output(0, 1)
  assert.deepEqual(f.state.drawn, [], 'late output from the old decoder must not overwrite the new screen')
  assert.deepEqual(f.state.acks, [1])
})

test('a new decoder waits for a keyframe and includes the parameter sets with it', () => {
  const f = fixture()
  f.video.decode(packet(2, false))
  assert.deepEqual(f.state.acks, [2])
  assert.equal(f.state.decoders[0].chunks.length, 0)
  f.video.decode(packet(3, true))
  const chunk = f.state.decoders[0].chunks[0]
  assert.equal(chunk.type, 'key')
  assert.deepEqual([...chunk.data.subarray(0, config.length)], [...config])
})

test('decoder failure releases pending ACKs once and signals a stream retry', () => {
  const f = fixture()
  f.video.decode(packet(1))
  f.video.decode(packet(2))
  f.state.decoders[0].callbacks.error(new Error('decoder failed'))
  f.output(0, 1)
  assert.deepEqual(f.state.acks, [1, 2])
  assert.deepEqual(f.state.errors, ['decoder failed'])
  assert.deepEqual(f.state.drawn, [])
})

test('static screens stay healthy while a hung decoder is detected and can be closed', () => {
  const f = fixture()
  f.state.time = 6000
  assert.equal(f.video.isStalled(), false)
  f.video.decode(packet(1))
  f.state.time = 12000
  assert.equal(f.video.isStalled(), true)
  f.video.close()
  assert.equal(f.video.isStalled(), false)
  assert.deepEqual(f.state.acks, [1])
})
