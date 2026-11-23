import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { createFramePresenter } from './frame-presenter.js'

function fixture(drawError) {
  const callbacks = new Map()
  const cancelled = []
  const drawn = []
  const closed = []
  const errors = []
  let sequence = 0
  const presenter = createFramePresenter({
    requestFrame(callback) {
      callbacks.set(++sequence, callback)
      return sequence
    },
    cancelFrame: id => cancelled.push(id),
    draw(frame) {
      if (drawError)
        throw drawError
      drawn.push(frame.id)
    },
    onError: error => errors.push(error.message),
  })
  const present = id => presenter.present({
    clone: () => ({ id, close: () => closed.push(id) }),
  })
  const tick = () => {
    const batch = [...callbacks.values()]
    callbacks.clear()
    for (const callback of batch) callback()
  }
  return { presenter, present, tick, callbacks, cancelled, drawn, closed, errors }
}

test('bursty decoded output presents the latest picture once per display refresh', () => {
  const f = fixture()
  for (let i = 1; i <= 100; i++)
    f.present(i)
  assert.equal(f.callbacks.size, 1)
  assert.equal(f.closed.length, 99, 'obsolete decoded images must release their GPU resources immediately')
  assert.deepEqual(f.drawn, [])
  f.tick()
  assert.deepEqual(f.drawn, [100])
  assert.equal(new Set(f.closed).size, 100)
})

test('three 60 fps streams remain bounded and preserve each latest image', () => {
  const screens = Array.from({ length: 3 }, () => fixture())
  for (let refresh = 0; refresh < 120; refresh++) {
    for (const f of screens) {
      f.present(refresh * 2)
      f.present(refresh * 2 + 1)
      f.tick()
    }
  }
  for (const f of screens) {
    assert.equal(f.drawn.length, 120)
    assert.equal(f.drawn.at(-1), 239)
    assert.equal(f.closed.length, 240)
    assert.equal(f.callbacks.size, 0)
  }
})

test('closing a session cancels presentation and rejects stale callbacks', () => {
  const f = fixture()
  f.present(1)
  const late = [...f.callbacks.values()][0]
  f.presenter.close()
  f.present(2)
  late()
  f.tick()
  assert.deepEqual(f.drawn, [2])
  assert.deepEqual(f.closed, [1, 2])
  assert.deepEqual(f.cancelled, [1])
})

test('a rendering failure releases the image and reports one recoverable error', () => {
  const f = fixture(new Error('GPU unavailable'))
  f.present(1)
  f.tick()
  assert.deepEqual(f.closed, [1])
  assert.deepEqual(f.errors, ['GPU unavailable'])
})
