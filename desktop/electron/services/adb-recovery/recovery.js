import { isIP } from 'node:net'

export function parseWirelessAddress(id) {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(String(id || ''))
  if (!match)
    return null
  const host = match[1] || match[2]
  const port = Number(match[3])
  if (!isIP(host) || port < 1 || port > 65535)
    return null
  return { id: String(id), host, port }
}

export function wirelessTargets(history = {}) {
  return Object.values(history).flatMap((device) => {
    const address = parseWirelessAddress(device.id)
    return address && device.wifi !== false ? [{ ...address, serialNo: device.serialNo }] : []
  })
}

export function parseAdbDevices(output = '') {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^(\S+)\s+(device|offline|unauthorized|recovery|sideload|bootloader)\b/.exec(line)
    return match ? [{ id: match[1], status: match[2] }] : []
  })
}

function matchesDevice(target, device) {
  return target.id === device.id || (target.serialNo && target.serialNo !== target.id
    && (device.id === target.serialNo || device.id.startsWith(`adb-${target.serialNo}-`)))
}

const outputOf = result => `${result?.stdout || ''}\n${result?.stderr || ''}`.trim()
const errorOf = error => [error?.stdout, error?.stderr, error?.message || error].filter(Boolean).join('\n')

/** One main-process coordinator; an open TCP port alone never justifies a restart. */
export function createAdbRecovery({ runAdb, probe, getHistory, enabled = () => true, now = Date.now, log = () => {}, cooldown = 120000 }) {
  const retryAt = new Map()
  const failures = new Map()
  const suppressed = new Set()
  let stopped = false
  let pending
  let emptyChecks = 0
  let lastRestart = -Infinity

  const allowed = target => !stopped && enabled() && !suppressed.has(target.id)
    && wirelessTargets(getHistory()).some(item => item.id === target.id)

  function setSuppressed(id, value) {
    const targets = wirelessTargets(getHistory()).filter(target => matchesDevice(target, { id }))
    for (const address of new Set([id, ...targets.map(target => target.id)])) {
      if (value)
        suppressed.add(address)
      else
        suppressed.delete(address)
      retryAt.delete(address)
    }
  }

  async function connect(target) {
    if (!allowed(target))
      return { target, skipped: true }
    try {
      const output = outputOf(await runAdb(['connect', target.id]))
      if (!/^(?:already )?connected to\b/im.test(output))
        throw new Error(output || 'ADB did not confirm the connection')
      retryAt.delete(target.id)
      failures.delete(target.id)
      log('connected', target.id)
      return { target, connected: true }
    }
    catch (error) {
      const message = errorOf(error)
      const attempts = (failures.get(target.id) || 0) + 1
      failures.set(target.id, attempts)
      retryAt.set(target.id, now() + Math.min(300000, 15000 * 2 ** Math.min(attempts - 1, 5)))
      log('connect-failed', target.id, message)
      return { target, message }
    }
  }

  async function recover() {
    if (stopped || !enabled())
      return
    const targets = wirelessTargets(getHistory())
    if (!targets.length)
      return

    const devices = parseAdbDevices(outputOf(await runAdb(['devices', '-l'])))
    // Also protect unauthorized, bootloader and recovery transports from a restart.
    const occupied = devices.some(device => device.status !== 'offline')
    emptyChecks = occupied ? 0 : emptyChecks + 1
    const activeIds = new Set(targets.map(target => target.id))
    for (const id of retryAt.keys()) {
      if (!activeIds.has(id)) {
        retryAt.delete(id)
        failures.delete(id)
      }
    }

    const results = []
    for (const target of targets) {
      if (!allowed(target) || (retryAt.get(target.id) || 0) > now()
        || devices.some(device => device.status !== 'offline' && matchesDevice(target, device))) {
        continue
      }
      if (await probe(target.host, target.port))
        results.push(await connect(target))
    }

    const stale = results.find(result => /no route to host|network is unreachable|EHOSTUNREACH|ENETUNREACH/i.test(result.message || ''))
    if (!stale || occupied || emptyChecks < 2 || now() - lastRestart < cooldown || !allowed(stale.target))
      return

    // Recheck after connecting: another phone or application may have come online.
    const latest = parseAdbDevices(outputOf(await runAdb(['devices', '-l'])))
    if (latest.some(device => device.status !== 'offline') || !allowed(stale.target))
      return

    lastRestart = now()
    log('restart', 'Reachable wireless port but ADB reports no route; no active transports')
    await runAdb(['kill-server'])
    if (stopped || !enabled())
      return
    await runAdb(['start-server'])
    emptyChecks = 0
    // Use a fresh history snapshot so a removed phone is never resurrected.
    for (const target of wirelessTargets(getHistory())) {
      if (allowed(target) && await probe(target.host, target.port))
        await connect(target)
    }
  }

  function check() {
    if (!pending) {
      pending = recover().catch(error => log('check-failed', errorOf(error))).finally(() => {
        pending = null
      })
    }
    return pending
  }

  return {
    check,
    setSuppressed,
    stop: () => {
      stopped = true
    },
  }
}
