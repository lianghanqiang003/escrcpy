import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { finalizeInterruptedState, validateRequest } from './validation.js'

test('only known scripts and explicit device targets are accepted', () => {
  assert.throws(() => validateRequest({ scriptId: 'shell', deviceIds: ['phone'] }))
  assert.throws(() => validateRequest({ scriptId: 'jd-check', deviceIds: [] }))
  assert.throws(() => validateRequest({ scriptId: 'jd-check', deviceIds: ['phone\nother'] }))
  assert.deepEqual(validateRequest({ scriptId: 'jd-check', deviceIds: ['phone', 'phone'] }).deviceIds, ['phone'])
})

test('official link parameters survive validation while unsafe destinations are rejected', () => {
  const request = { scriptId: 'jd-cart', deviceIds: ['phone'], items: [{ url: 'https://u.jd.com/abc?a=1&b=%2F', kind: 'auto', status: 'added' }] }
  assert.deepEqual(validateRequest(request).items, [{ url: request.items[0].url, kind: 'auto' }])
  for (const url of ['https://jd.com.evil.test/a', 'https://u.jd.com@evil.test/a', 'file:///etc/passwd', 'https://u.jd.com:999/a', 'https://u.jd.com/a\nb'])
    assert.throws(() => validateRequest({ ...request, items: [{ url, kind: 'auto' }] }), url)
  assert.throws(() => validateRequest({ ...request, scriptId: 'jd-coupon', items: [{ url: 'https://item.jd.com/1.html', kind: 'product' }] }))
})

test('an interrupted action is uncertain and cannot be restored as successful', () => {
  const result = finalizeInterruptedState({ running: true, paused: true, items: [{ status: 'added' }, { status: 'opening' }, { status: 'pending' }] })
  assert.equal(result.running, false)
  assert.equal(result.paused, false)
  assert.deepEqual(result.items.map(item => item.status), ['added', 'uncertain', 'stopped'])
})
