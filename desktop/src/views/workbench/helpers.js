export function selectOnlineDevices(devices) {
  const rank = item => item.id === item.serialNo ? 0 : item.id.includes('_adb-tls-') ? 2 : 1
  const result = new Map()
  for (const device of devices) {
    if (!['device', 'emulator'].includes(device.status))
      continue
    const identity = device.serialNo || device.id
    if (!result.has(identity) || rank(device) < rank(result.get(identity)))
      result.set(identity, device)
  }
  return [...result.values()].sort((a, b) => (a.serialNo || a.id).localeCompare(b.serialNo || b.id))
}

export function getVideoPoint(event, element, width, height, clamp = true) {
  if (!width || !height)
    return null
  const bounds = element.getBoundingClientRect()
  const scale = Math.min(bounds.width / width, bounds.height / height)
  const left = bounds.left + (bounds.width - width * scale) / 2
  const top = bounds.top + (bounds.height - height * scale) / 2
  const x = (event.clientX - left) / (width * scale)
  const y = (event.clientY - top) / (height * scale)
  if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1))
    return null
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
}

// Keep a stable device order across polling and USB / wireless endpoint changes.
export function orderDevices(devices, savedOrder) {
  const order = new Map(savedOrder.map((id, index) => [id, index]))
  return [...devices].sort((a, b) => (order.get(a.serialNo || a.id) ?? Infinity) - (order.get(b.serialNo || b.id) ?? Infinity))
}

export function getScreenLayout({ count, width, height, tileWidth = 180, columns = 0, focusedIndex = -1, focusedRatio = 0.45 }) {
  const gap = 12
  const available = Math.max(1, width)
  const preferred = Math.max(140, Math.min(320, tileWidth))
  const maxColumns = Math.max(1, Math.floor((available + gap) / (140 + gap)))
  const columnCount = columns > 0 ? Math.min(columns, maxColumns) : Math.max(1, Math.floor((available + gap) / (preferred + gap)))
  const smallWidth = Math.min(columns > 0 ? 320 : preferred, (available - gap * (columnCount - 1)) / columnCount)
  const normal = { gridTemplateColumns: `repeat(${columnCount}, ${smallWidth}px)` }
  if (focusedIndex < 0 || focusedIndex >= count)
    return { grid: normal, cards: [] }

  const largeWidth = Math.min(available, Math.max(smallWidth, Math.min(380, (height - 112) * focusedRatio)))
  const remaining = available - largeWidth - gap
  const beside = count > 1 && remaining >= 140
  const previewColumns = beside ? Math.max(1, Math.floor((remaining + gap) / (smallWidth + gap))) : columnCount
  const rows = Math.max(1, Math.ceil((count - 1) / previewColumns))
  const previewWidth = beside ? Math.min(smallWidth, (remaining - gap * (previewColumns - 1)) / previewColumns) : smallWidth
  let previewIndex = 0
  const cards = Array.from({ length: count }, (_, index) => {
    if (index === focusedIndex)
      return { gridColumn: beside ? '1' : `1 / -1`, gridRow: beside ? `1 / span ${rows}` : '1', width: `${largeWidth}px` }
    const position = previewIndex++
    return { gridColumn: `${position % previewColumns + (beside ? 2 : 1)}`, gridRow: `${Math.floor(position / previewColumns) + (beside ? 1 : 2)}` }
  })
  return {
    grid: { gridTemplateColumns: beside ? `${largeWidth}px repeat(${previewColumns}, ${previewWidth}px)` : normal.gridTemplateColumns },
    cards,
  }
}
