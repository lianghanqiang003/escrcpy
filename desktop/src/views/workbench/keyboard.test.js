import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { createKeyboardInput, keyboardTargets } from './keyboard.js'

test('Chinese IME preedit never reaches Android and final commit is sent once', () => {
  const sent = []
  const keyboard = createKeyboardInput(input => sent.push(input))
  const target = { value: 'sichuan' }
  keyboard.compositionStart()
  keyboard.input({ target, isComposing: true })
  keyboard.keydown({ key: 'Enter', isComposing: true })
  assert.deepEqual(sent, [])
  target.value = '四川消费券'
  keyboard.compositionEnd({ target, data: '四川消费券' })
  keyboard.input({ target, isComposing: false })
  assert.deepEqual(sent, [{ type: 'text', text: '四川消费券' }])
  assert.equal(target.value, '')
})

test('cancelled composition and lost focus discard unfinished local text', () => {
  const sent = []
  const keyboard = createKeyboardInput(input => sent.push(input))
  const target = { value: 'unfinished' }
  keyboard.compositionStart()
  keyboard.compositionEnd({ target, data: '' })
  keyboard.input({ target })
  target.value = 'another preedit'
  keyboard.compositionStart()
  keyboard.reset(target)
  keyboard.compositionEnd({ target, data: 'another preedit' })
  assert.deepEqual(sent, [])
})

test('plain typing and dead-key commits send committed DOM text', () => {
  const sent = []
  const keyboard = createKeyboardInput(input => sent.push(input))
  const target = { value: 'abc 123' }
  keyboard.input({ target })
  target.value = 'é🙂'
  keyboard.input({ target })
  assert.deepEqual(sent, [{ type: 'text', text: 'abc 123' }, { type: 'text', text: 'é🙂' }])
})

test('paste handles Chinese, links and newlines in one packet without duplicate input', () => {
  const sent = []
  const keyboard = createKeyboardInput(input => sent.push(input))
  const target = { value: '' }
  let prevented = false
  const text = '中文🙂\nhttps://u.jd.com/example?a=1&b=2'
  keyboard.paste({ target, preventDefault() {
    prevented = true
  }, clipboardData: { getData: () => text } })
  keyboard.input({ target })
  assert.equal(prevented, true)
  assert.deepEqual(sent, [{ type: 'text', text, paste: true }])
})

test('editing keys and select-all are mapped; app shortcuts and IME keys are left alone', () => {
  const sent = []
  const keyboard = createKeyboardInput(input => sent.push(input))
  let prevented = 0
  const event = { preventDefault() {
    prevented++
  } }
  for (const key of ['Backspace', 'Delete', 'ArrowLeft', 'Enter'])
    keyboard.keydown({ ...event, key })
  keyboard.keydown({ ...event, key: 'a', metaKey: true })
  keyboard.keydown({ ...event, key: 'ArrowRight', shiftKey: true })
  assert.deepEqual(sent.map(input => [input.keyCode, input.metaState]), [[67, 0], [112, 0], [21, 0], [66, 0], [29, 4096], [22, 1]])
  for (const details of [{ key: 'v', metaKey: true }, { key: 'q', metaKey: true }, { key: 'c', ctrlKey: true }, { key: 'Enter', keyCode: 229 }, { key: 'Dead' }])
    keyboard.keydown({ ...event, ...details })
  assert.equal(sent.length, 6)
  assert.equal(prevented, 6)
})

test('keyboard targets obey view-only, primary selection, script locks and device removal', () => {
  const options = { interactive: true, broadcast: true, selectedId: 'a', deviceIds: ['a', 'b', 'c'], lockedIds: ['c'] }
  assert.deepEqual(keyboardTargets('a', options), ['a', 'b'])
  assert.deepEqual(keyboardTargets('b', options), [])
  assert.deepEqual(keyboardTargets('a', { ...options, interactive: false }), [])
  assert.deepEqual(keyboardTargets('a', { ...options, lockedIds: ['a'] }), [])
  assert.deepEqual(keyboardTargets('gone', options), [])
  assert.deepEqual(keyboardTargets('b', { ...options, broadcast: false }), ['b'])
})
