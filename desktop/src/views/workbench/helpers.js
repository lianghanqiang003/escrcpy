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
