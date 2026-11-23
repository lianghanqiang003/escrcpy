export function findAvcCodec(data) {
  for (let i = 0; i + 7 < data.length; i++) {
    let start = -1
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1)
      start = i + 3
    else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1)
      start = i + 4
    if (start >= 0 && (data[start] & 31) === 7)
      return `avc1.${Array.from(data.subarray(start + 1, start + 4), x => x.toString(16).padStart(2, '0')).join('')}`
  }
  throw new Error('Invalid H.264 configuration')
}

/** ACK decoded frames, never just received messages, so H.264 references survive. */
export function createVideoDecoder({
  createDecoder = callbacks => new VideoDecoder(callbacks),
  createChunk = options => new EncodedVideoChunk(options),
  draw,
  acknowledge,
  onError,
  now = Date.now,
}) {
  let decoder
  let configuration
  let generation = 0
  let needsKey = true
  const pending = new Map()

  function close() {
    generation++
    for (const entries of pending.values()) {
      for (const entry of entries)
        acknowledge(entry.packet)
    }
    pending.clear()
    if (decoder && decoder.state !== 'closed')
      decoder.close()
    decoder = null
    configuration = null
    needsKey = true
  }

  function fail(error) {
    close()
    onError(error)
  }

  function configure(data) {
    const codec = findAvcCodec(data)
    if (decoder?.state === 'configured' && configuration?.length === data.length
      && configuration.every((byte, index) => byte === data[index])) {
      return
    }
    close()
    configuration = new Uint8Array(data)
    const currentGeneration = generation
    decoder = createDecoder({
      output(frame) {
        let entry
        try {
          if (currentGeneration !== generation)
            return
          const entries = pending.get(frame.timestamp)
          entry = entries?.shift()
          if (!entries?.length)
            pending.delete(frame.timestamp)
          draw(frame)
        }
        catch (error) {
          fail(error)
        }
        finally {
          frame.close()
          if (entry)
            acknowledge(entry.packet)
        }
      },
      error(error) {
        if (currentGeneration === generation)
          fail(error)
      },
    })
    decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' })
  }

  function decode(packet) {
    if (decoder?.state !== 'configured' || (needsKey && !packet.key)) {
      acknowledge(packet)
      return
    }
    const entries = pending.get(packet.timestamp) || []
    entries.push({ packet, at: now() })
    pending.set(packet.timestamp, entries)
    try {
      const data = new Uint8Array(packet.data)
      let bytes = data
      if (packet.key && configuration) {
        bytes = new Uint8Array(configuration.length + data.length)
        bytes.set(configuration)
        bytes.set(data, configuration.length)
      }
      decoder.decode(createChunk({ type: packet.key ? 'key' : 'delta', timestamp: packet.timestamp, data: bytes }))
      needsKey = false
    }
    catch (error) {
      fail(error)
    }
  }

  function isStalled(timeout = 5000) {
    return [...pending.values()].some(entries => entries.some(entry => now() - entry.at > timeout))
  }

  return { configure, decode, close, isStalled }
}
