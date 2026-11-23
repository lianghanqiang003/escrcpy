import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { createAdbRecovery, parseAdbDevices, parseWirelessAddress } from './recovery.js'

const address = '192.168.51.9:42789'
const other = '192.168.51.10:39419'

function fixture(overrides = {}) {
  const state = {
    time: 0,
    enabled: true,
    history: { [address]: { id: address, serialNo: 'phone-one', wifi: true } },
    devices: '',
    reachable: true,
    connectOutput: 'failed to connect: No route to host',
    calls: [],
    events: [],
    ...overrides,
  }
  const recovery = createAdbRecovery({
    getHistory: () => state.history,
    enabled: () => state.enabled,
    now: () => state.time,
    probe: async () => state.reachable,
    log: (...event) => state.events.push(event),
    runAdb: async (args) => {
      state.calls.push(args)
      if (args[0] === 'devices')
        return { stdout: state.devices }
      if (args[0] === 'connect')
        return { stdout: state.connectOutput }
      if (args[0] === 'start-server' && state.afterRestart)
        state.connectOutput = `connected to ${address}`
      return { stdout: '' }
    },
  })
  const tick = async () => {
    state.time += 15000
    await recovery.check()
  }
  const restarts = () => state.calls.filter(args => args[0] === 'kill-server').length
  return { state, recovery, tick, restarts }
}

test('reachable port plus repeated no-route errors restarts ADB and reconnects', async () => {
  const f = fixture({ afterRestart: true })
  await f.tick()
  assert.equal(f.restarts(), 0, 'a single transient error must not restart the server')
  await f.tick()
  assert.equal(f.restarts(), 1)
  assert.deepEqual(f.state.calls.slice(-3), [['kill-server'], ['start-server'], ['connect', address]])
  assert.ok(f.state.events.some(event => event[0] === 'connected'))
})

test('unreachable phone never causes a server restart or blind connect', async () => {
  const f = fixture({ reachable: false })
  await f.tick()
  await f.tick()
  assert.equal(f.restarts(), 0)
  assert.ok(f.state.calls.every(args => args[0] === 'devices'))
})

test('authentication errors and refused connections are not treated as stale routing', async () => {
  for (const message of ['failed to authenticate', 'SSLV3_ALERT_CERTIFICATE_UNKNOWN', 'Connection refused']) {
    const f = fixture({ connectOutput: message })
    await f.tick()
    await f.tick()
    assert.equal(f.restarts(), 0, message)
  }
})

test('one healthy or protected transport prevents a global restart', async () => {
  for (const status of ['device', 'unauthorized', 'recovery', 'sideload', 'bootloader']) {
    const f = fixture({ devices: `${other}\t${status}` })
    await f.tick()
    await f.tick()
    assert.equal(f.restarts(), 0, status)
  }
})

test('a device that comes online during the second check prevents restart', async () => {
  const f = fixture()
  await f.tick()
  // First list in the second pass is empty; the final pre-restart check sees a phone.
  let lists = 0
  Object.defineProperty(f.state, 'devices', { get: () => ++lists > 1 ? `${other}\tdevice` : '' })
  await f.tick()
  assert.equal(f.restarts(), 0)
})

test('restart attempts have a cooldown even when the replacement daemon also fails', async () => {
  const f = fixture()
  await f.tick()
  await f.tick()
  assert.equal(f.restarts(), 1)
  for (let i = 0; i < 7; i++)
    await f.tick()
  assert.equal(f.restarts(), 1)
})

test('already connected IP, USB or mDNS aliases are not connected twice', async () => {
  for (const id of [address, 'phone-one', 'adb-phone-one-random._adb-tls-connect._tcp']) {
    const f = fixture({ devices: `${id}\tdevice product:alioth` })
    await f.tick()
    assert.deepEqual(f.state.calls, [['devices', '-l']])
  }
})

test('manual disconnect is respected until an explicit connect allows the target', async () => {
  const f = fixture({ connectOutput: `connected to ${address}` })
  f.recovery.setSuppressed(address, true)
  await f.tick()
  assert.ok(f.state.calls.every(args => args[0] === 'devices'))
  f.recovery.setSuppressed(address, false)
  await f.tick()
  assert.deepEqual(f.state.calls.at(-1), ['connect', address])
})

test('a phone removed while probing is never reconnected or restarted for', async () => {
  const f = fixture()
  const recovery = createAdbRecovery({
    runAdb: async (args) => {
      f.state.calls.push(args)
      return { stdout: '' }
    },
    probe: async () => {
      f.state.history = {}
      return true
    },
    getHistory: () => f.state.history,
  })
  await recovery.check()
  assert.deepEqual(f.state.calls, [['devices', '-l']])
})

test('disabling auto-connect or stopping during a probe cancels recovery', async () => {
  for (const stop of [false, true]) {
    const f = fixture()
    const recovery = createAdbRecovery({
      runAdb: async (args) => {
        f.state.calls.push(args)
        return { stdout: '' }
      },
      probe: async () => {
        if (stop)
          recovery.stop()
        else
          f.state.enabled = false
        return true
      },
      getHistory: () => f.state.history,
      enabled: () => f.state.enabled,
    })
    await recovery.check()
    assert.deepEqual(f.state.calls, [['devices', '-l']])
  }
})

test('overlapping timer and resume checks share one recovery attempt', async () => {
  let release
  let calls = 0
  const recovery = createAdbRecovery({
    getHistory: () => ({ phone: { id: address } }),
    runAdb: () => {
      calls++
      return new Promise((resolve) => {
        release = resolve
      })
    },
    probe: async () => false,
  })
  const first = recovery.check()
  assert.equal(first, recovery.check())
  release({ stdout: '' })
  await first
  assert.equal(calls, 1)
})

test('parses actual transport status and rejects service names or invalid endpoints', () => {
  assert.deepEqual(parseAdbDevices(`List of devices attached\n${address}\tdevice product:alioth\n${other}\toffline`), [
    { id: address, status: 'device' }, { id: other, status: 'offline' },
  ])
  assert.deepEqual(parseWirelessAddress('[fe80::1%en0]:5555'), { id: '[fe80::1%en0]:5555', host: 'fe80::1%en0', port: 5555 })
  for (const id of ['adb-phone._adb-tls-connect._tcp', '999.1.1.1:5555', '192.168.1.2:0', '192.168.1.2:65536', '192.168.1.2:22;echo bad'])
    assert.equal(parseWirelessAddress(id), null, id)
})
