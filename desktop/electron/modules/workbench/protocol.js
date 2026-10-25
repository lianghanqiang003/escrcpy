// scrcpy 4.x: a codec id, then 12-byte session/media headers.
// https://github.com/Genymobile/scrcpy/blob/master/doc/develop.md
export class VideoPacketReader {
  buffer = Buffer.alloc(0)
  metadataRead = false

  constructor(onPacket) {
    this.onPacket = onPacket
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (!this.metadataRead) {
      if (this.buffer.length < 68)
        return
      if (this.buffer.readUInt32BE(64) !== 0x68323634)
        throw new Error('Expected an H.264 scrcpy stream')
      this.metadataRead = true
      this.buffer = this.buffer.subarray(68)
    }
    while (this.buffer.length >= 12) {
      const flags = this.buffer.readBigUInt64BE(0)
      if (flags & (1n << 63n)) {
        this.onPacket({ type: 'size', width: this.buffer.readUInt32BE(4), height: this.buffer.readUInt32BE(8) })
        this.buffer = this.buffer.subarray(12)
        continue
      }
      const length = this.buffer.readUInt32BE(8)
      if (length > 8 * 1024 * 1024)
        throw new Error('Invalid scrcpy packet length')
      if (this.buffer.length < length + 12)
        return
      this.onPacket({
        type: 'frame',
        config: !!(flags & (1n << 62n)),
        key: !!(flags & (1n << 61n)),
        timestamp: Number(flags & ((1n << 61n) - 1n)),
        data: this.buffer.subarray(12, 12 + length),
      })
      this.buffer = this.buffer.subarray(12 + length)
    }
  }
}

export function encodeTouch(input, size) {
  if (![0, 1, 2, 3].includes(input.action))
    throw new Error('Invalid touch action')
  const { width, height } = size
  if (!(width > 0 && height > 0 && width <= 65535 && height <= 65535))
    throw new Error('Video is not ready')
  const x = Number(input.x)
  const y = Number(input.y)
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1)
    throw new Error('Invalid touch coordinates')
  const up = input.action === 1 || input.action === 3
  const packet = Buffer.alloc(32)
  packet[0] = 2
  packet[1] = input.action
  packet.writeBigUInt64BE(0n, 2)
  packet.writeUInt32BE(Math.min(width - 1, Math.round(x * width)), 10)
  packet.writeUInt32BE(Math.min(height - 1, Math.round(y * height)), 14)
  packet.writeUInt16BE(width, 18)
  packet.writeUInt16BE(height, 20)
  packet.writeUInt16BE(up ? 0 : 65535, 22)
  packet.writeUInt32BE(0, 24)
  packet.writeUInt32BE(up ? 0 : 1, 28)
  return packet
}

export function encodeKey(keyCode, action) {
  if (![3, 4, 24, 25, 187, 224].includes(keyCode) || ![0, 1].includes(action))
    throw new Error('Unsupported navigation key')
  const packet = Buffer.alloc(14)
  packet[0] = 0
  packet[1] = action
  packet.writeUInt32BE(keyCode, 2)
  return packet
}
