import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { getScreenLayout, getVideoPoint, orderDevices, selectOnlineDevices } from './helpers.js'

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

test('thumbnail size stays compact even with only two phones on a large desktop', () => {
  const layout = getScreenLayout({ count: 2, width: 1800, height: 900 })
  assert.match(layout.grid.gridTemplateColumns, /180px/)
  assert.deepEqual(layout.cards, [])
  const narrow = getScreenLayout({ count: 12, width: 270, height: 500, columns: 8 })
  assert.match(narrow.grid.gridTemplateColumns, /^repeat\(1, 270px\)$/)
})

test('enlarging any phone assigns every preview a distinct cell and keeps them visible', () => {
  for (const width of [260, 600, 1200]) {
    const layout = getScreenLayout({ count: 11, width, height: 620, focusedIndex: 4 })
    assert.equal(layout.cards.length, 11)
    const previews = layout.cards.filter((_, index) => index !== 4)
    assert.equal(new Set(previews.map(card => `${card.gridColumn}:${card.gridRow}`)).size, 10)
    assert.ok(Number.parseFloat(layout.cards[4].width) <= width)
    assert.ok(previews.every(card => Number(card.gridColumn) >= (width >= 600 ? 2 : 1)))
  }
})

test('saved arrangement follows hardware identity when a wireless endpoint changes', () => {
  const devices = [{ id: 'usb', serialNo: 'one' }, { id: 'new-ip:1234', serialNo: 'two' }, { id: 'new-phone' }]
  assert.deepEqual(orderDevices(devices, ['two', 'one']).map(item => item.id), ['new-ip:1234', 'usb', 'new-phone'])
  assert.deepEqual(devices.map(item => item.id), ['usb', 'new-ip:1234', 'new-phone'])
})
