// Decode every H.264 reference, but upload only the newest decoded picture at
// each display refresh. VideoFrame.clone() shares the backing image data.
export function createFramePresenter({
  draw,
  onError,
  requestFrame = requestAnimationFrame,
  cancelFrame = cancelAnimationFrame,
}) {
  let pending
  let scheduled = null
  let generation = 0

  function close() {
    generation++
    if (scheduled !== null)
      cancelFrame(scheduled)
    scheduled = null
    pending?.close()
    pending = null
  }

  function present(frame) {
    const next = frame.clone()
    pending?.close()
    pending = next
    if (scheduled !== null)
      return
    const currentGeneration = generation
    scheduled = requestFrame(() => {
      if (currentGeneration !== generation)
        return
      scheduled = null
      const latest = pending
      pending = null
      try {
        if (latest)
          draw(latest)
      }
      catch (error) {
        close()
        onError(error)
      }
      finally {
        latest?.close()
      }
    })
  }

  return { present, close }
}
