const keys = { Enter: 66, Backspace: 67, Delete: 112, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Home: 122, End: 123, PageUp: 92, PageDown: 93, Tab: 61, Escape: 111 }

export function keyboardTargets(id, { interactive, broadcast, selectedId, deviceIds, lockedIds }) {
  if (!interactive || !deviceIds.includes(id) || lockedIds.includes(id) || (broadcast && selectedId !== id))
    return []
  return (broadcast ? deviceIds : [id]).filter(target => !lockedIds.includes(target))
}

// Listen to committed DOM text, rather than keydown characters: macOS IME
// preedit, dead keys and emoji must reach Android once, after composition ends.
export function createKeyboardInput(send) {
  let composing = false
  const reset = (element) => {
    composing = false
    if (element)
      element.value = ''
  }
  const commit = (element) => {
    const text = element.value
    element.value = ''
    if (text)
      send({ type: 'text', text })
  }
  return {
    reset,
    input(event) {
      if (!composing && !event.isComposing)
        commit(event.target)
    },
    compositionStart() { composing = true },
    compositionEnd(event) {
      composing = false
      if (event.data === '')
        reset(event.target)
      else
        commit(event.target)
    },
    paste(event) {
      event.preventDefault()
      const text = event.clipboardData?.getData('text/plain')
      reset(event.target)
      if (text)
        send({ type: 'text', text, paste: true })
    },
    keydown(event) {
      if (composing || event.isComposing || event.keyCode === 229)
        return
      let input
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'a')
        input = { type: 'key', keyCode: 29, metaState: 4096 }
      else if (!event.metaKey && !event.ctrlKey && !event.altKey && keys[event.key])
        input = { type: 'key', keyCode: keys[event.key], metaState: event.shiftKey ? 1 : 0 }
      if (input) {
        event.preventDefault()
        send(input)
      }
    },
  }
}
