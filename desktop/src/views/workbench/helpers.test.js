import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { getVideoPoint, selectOnlineDevices } from './helpers.js'

test('USB, IP and mDNS aliases represent one phone; missing serials remain separate', () => {
  const devices = selectOnlineDevices([
    { id: 'adb-abc._adb-tls-connect._tcp', serialNo: 'abc', status: 'device' },
    { id: '192.168.1.2:3333', serialNo: 'abc', status: 'device' },
    { id: 'abc', serialNo: 'abc', status: 'device' },
    { id: 'phone-two', status: 'device' }, { id: 'phone-three', status: 'device' },
    { id: 'offline', serialNo: 'xyz', status: 'offline' },
    { id: 'unauthorized', serialNo: 'xyz', status: 'unauthorized' },
  ])
  assert.deepEqual(devices.map(x => x.id), ['abc', 'phone-three', 'phone-two'])
})

test('pointer coordinates account for letterboxing and clamp a drag outside the screen', () => {
  const element = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 600, height: 400 }) }
  const point = getVideoPoint({ clientX: 400, clientY: 250 }, element, 100, 200)
  assert.deepEqual(point, { x: 0.5, y: 0.5 })
  assert.deepEqual(getVideoPoint({ clientX: -100, clientY: 900 }, element, 100, 200), { x: 0, y: 1 })
  assert.equal(getVideoPoint({}, element, 0, 0), null)
  assert.equal(getVideoPoint({ clientX: 110, clientY: 250 }, element, 100, 200, false), null)
})
