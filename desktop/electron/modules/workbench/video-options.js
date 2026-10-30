const profiles = new Map([
  [540, { bitRate: 1500000, fps: 24 }],
  [720, { bitRate: 2500000, fps: 24 }],
  [1080, { bitRate: 4000000, fps: 30 }],
  [1920, { bitRate: 8000000, fps: 30 }],
  [0, { bitRate: 12000000, fps: 30 }],
])

// max_size limits the LONG edge. Zero deliberately preserves native resolution.
// Keep the renderer and server on the same bounded quality profiles.
export function getVideoOptions(options = {}) {
  const maxSize = profiles.has(options.maxSize) ? options.maxSize : 1920
  const profile = profiles.get(maxSize)
  const fps = [15, 24, 30].includes(options.fps) ? Math.min(options.fps, profile.fps) : profile.fps
  return { maxSize, bitRate: profile.bitRate, fps }
}
