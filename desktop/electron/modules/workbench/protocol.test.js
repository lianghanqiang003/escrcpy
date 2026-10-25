import assert from 'node:assert/strict'
// These protocol checks intentionally run without an Electron or Vitest runtime.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { encodeKey, encodeTouch, VideoPacketReader } from './protocol.js'

function metadata() {
  const data = Buffer.alloc(68)
  data.write('Android phone')
  data.writeUInt32BE(0x68323634, 64)
  return data
}

function size(width, height) {
  const header = Buffer.alloc(12)
  header.writeUInt32BE(0x80000000, 0)
  header.writeUInt32BE(width, 4)
  header.writeUInt32BE(height, 8)
  return header
}

function frame(flags, data) {
  const header = Buffer.alloc(12)
  header.writeBigUInt64BE(flags)
  header.writeUInt32BE(data.length, 8)
  return Buffer.concat([header, data])
}

test('fragmented metadata, session headers and H.264 packets retain boundaries and flags', () => {
  const received = []
  const reader = new VideoPacketReader(packet => received.push(packet))
  const bytes = Buffer.concat([
    metadata(), size(324, 720),
    frame(1n << 62n, Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0x80, 0x1E])),
    frame((1n << 61n) | 1234567n, Buffer.from([0, 0, 1, 0x65, 8])),
    size(720, 324), frame(2234567n, Buffer.from([0, 0, 1, 0x41, 9])),
  ])
  for (let i = 0; i < bytes.length; i += 3)
    reader.push(bytes.subarray(i, i + 3))
  assert.equal(received.length, 5)
  assert.deepEqual(received[0], { type: 'size', width: 324, height: 720 })
  assert.equal(received[1].config, true)
  assert.equal(received[2].key, true)
  assert.equal(received[2].timestamp, 1234567)
  assert.deepEqual(received[3], { type: 'size', width: 720, height: 324 })
  assert.equal(received[4].key, false)
  assert.equal(reader.buffer.length, 0)
})

test('malformed media length cannot grow an unbounded receive buffer', () => {
  const header = Buffer.alloc(12)
  header.writeUInt32BE(9 * 1024 * 1024, 8)
  const reader = new VideoPacketReader(() => {})
  assert.throws(() => reader.push(Buffer.concat([metadata(), header])), /length/)
})

test('touch is scaled independently for each phone and releases pressure on up/cancel', () => {
  const a = encodeTouch({ action: 0, x: 0.5, y: 1 }, { width: 324, height: 720 })
  const b = encodeTouch({ action: 1, x: 0.5, y: 1 }, { width: 720, height: 1600 })
  assert.equal(a.length, 32)
  assert.equal(a[0], 2)
  assert.equal(a.readUInt32BE(10), 162)
  assert.equal(a.readUInt32BE(14), 719)
  assert.equal(a.readUInt16BE(22), 65535)
  assert.equal(b.readUInt32BE(10), 360)
  assert.equal(b.readUInt32BE(14), 1599)
  assert.equal(b.readUInt16BE(22), 0)
  assert.equal(b.readUInt32BE(28), 0)
  assert.equal(encodeTouch({ action: 3, x: 0, y: 0 }, { width: 324, height: 720 }).readUInt16BE(22), 0)
})

test('invalid coordinates, actions and unsupported keys are rejected before control injection', () => {
  for (const input of [{ action: 7, x: 0, y: 0 }, { action: 0, x: Number.NaN, y: 0 }, { action: 0, x: -1, y: 0 }])
    assert.throws(() => encodeTouch(input, { width: 324, height: 720 }))
  assert.throws(() => encodeKey(26, 0))
  assert.throws(() => encodeKey(3, 8))
  const key = encodeKey(3, 1)
  assert.equal(key.length, 14)
  assert.equal(key[1], 1)
  assert.equal(key.readUInt32BE(2), 3)
})
