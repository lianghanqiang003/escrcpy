<template>
  <div
    ref="surface"
    class="device-surface"
    :class="{ interactive, pressed: !!gesture }"
    @pointerdown="pointerDown"
    @pointermove="pointerMove"
    @pointerup="pointerUp"
    @pointercancel="releaseTouch"
    @lostpointercapture="releaseTouch"
    @contextmenu.prevent
  >
    <canvas ref="canvas" />
    <div v-if="status !== 'live'" class="screen-placeholder">
      <i :class="error ? 'i-lucide-wifi-off' : 'i-lucide-loader-circle animate-spin'" />
      <strong>{{ error ? $t('workbench.disconnected') : $t('workbench.connecting') }}</strong>
      <p v-if="error">
        {{ error }}
      </p>
      <button v-if="error" type="button" @pointerdown.stop @click.stop="restart">
        {{ $t('common.retry') }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { getVideoPoint } from '../../helpers.js'

const props = defineProps({
  deviceId: { type: String, required: true },
  maxSize: { type: Number, default: 720 },
  fps: { type: Number, default: 24 },
  interactive: Boolean,
})
const emit = defineEmits(['status', 'input', 'select'])
const ipc = window.$preload.ipcRenderer
const canvas = ref(null)
const surface = ref(null)
const status = ref('connecting')
const error = ref('')
const gesture = ref(null)
let decoder
let configuration
let codec = ''
let sessionId = ''
let startedDeviceId = ''
let requestId = ''
const instanceId = crypto.randomUUID()
let generation = 0
let active = false
let retryTimer
let frameCount = 0
let width = 0
let height = 0
let lastFrameAt = 0
let needsKey = true
let lastMove = 0
let metricsTimer
let gestureTimer

function setStatus(value, message = '') {
  status.value = value
  error.value = message
  emit('status', { status: value, error: message, width, height })
}

function findCodec(data) {
  for (let i = 0; i + 7 < data.length; i++) {
    let start = -1
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1)
      start = i + 3
    else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1)
      start = i + 4
    if (start >= 0 && (data[start] & 31) === 7)
      return `avc1.${Array.from(data.subarray(start + 1, start + 4), x => x.toString(16).padStart(2, '0')).join('')}`
  }
  throw new Error(window.t('workbench.codecError'))
}

function configure(data) {
  const nextCodec = findCodec(data)
  configuration = data
  if (decoder?.state === 'configured' && codec === nextCodec)
    return
  closeDecoder()
  codec = nextCodec
  decoder = new VideoDecoder({
    output(frame) {
      try {
        const element = canvas.value
        if (!element)
          return
        if (element.width !== frame.displayWidth || element.height !== frame.displayHeight) {
          element.width = frame.displayWidth
          element.height = frame.displayHeight
        }
        element.getContext('2d', { alpha: false }).drawImage(frame, 0, 0)
        frameCount++
        lastFrameAt = Date.now()
        if (status.value !== 'live')
          setStatus('live')
      }
      finally { frame.close() }
    },
    error(reason) {
      setStatus('error', reason.message)
      scheduleRetry()
    },
  })
  decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' })
  needsKey = true
}

function onEvent(_, packet) {
  if (packet.deviceId !== props.deviceId || packet.requestId !== requestId || !active)
    return
  // Events can arrive before invoke(start) resolves. A generation check in
  // restart prevents its eventual result from adopting an obsolete session.
  if (sessionId && packet.sessionId !== sessionId)
    return
  if (!sessionId)
    sessionId = packet.sessionId
  try {
    if (packet.type === 'size') {
      width = packet.width
      height = packet.height
      closeDecoder()
      decoder = null
      codec = ''
      configuration = null
      needsKey = true
      emit('status', { status: status.value, width, height })
    }
    else if (packet.type === 'config') {
      configure(new Uint8Array(packet.data))
    }
    else if (packet.type === 'frame') {
      if (!decoder || decoder.state !== 'configured' || (needsKey && !packet.key))
        return
      if (decoder.decodeQueueSize > 5) {
        decoder.reset()
        decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' })
        needsKey = true
        if (!packet.key)
          return
      }
      const data = new Uint8Array(packet.data)
      let bytes = data
      if (packet.key && configuration) {
        bytes = new Uint8Array(configuration.length + data.length)
        bytes.set(configuration)
        bytes.set(data, configuration.length)
      }
      decoder.decode(new EncodedVideoChunk({ type: packet.key ? 'key' : 'delta', timestamp: packet.timestamp, data: bytes }))
      needsKey = false
    }
    else if (packet.type === 'error') {
      releaseTouch()
      setStatus('error', packet.message)
      scheduleRetry()
    }
  }
  catch (reason) {
    setStatus('error', reason.message)
    scheduleRetry()
  }
  finally {
    if (packet.sequence)
      ipc.send('workbench:ack', props.deviceId, packet.sessionId, packet.sequence)
  }
}

function scheduleRetry() {
  clearTimeout(retryTimer)
  if (active)
    retryTimer = setTimeout(restart, 4000)
}

async function restart() {
  const currentGeneration = ++generation
  clearTimeout(retryTimer)
  releaseTouch()
  const previousId = sessionId
  const previousDeviceId = startedDeviceId
  sessionId = ''
  requestId = `${instanceId}-${currentGeneration}`
  closeDecoder()
  decoder = null
  codec = ''
  configuration = null
  needsKey = true
  try {
    if (previousId)
      await ipc.invoke('workbench:stop', previousDeviceId, previousId)
    if (!active || currentGeneration !== generation)
      return
    if (!window.VideoDecoder)
      throw new Error(window.t('workbench.decoderUnavailable'))
    setStatus('connecting')
    const deviceId = props.deviceId
    startedDeviceId = deviceId
    const result = await ipc.invoke('workbench:start', { deviceId, requestId, maxSize: props.maxSize, fps: props.fps })
    if (!active || currentGeneration !== generation) {
      await ipc.invoke('workbench:stop', deviceId, result.sessionId)
      return
    }
    sessionId = result.sessionId
  }
  catch (reason) {
    if (active && currentGeneration === generation) {
      setStatus('error', reason.message)
      scheduleRetry()
    }
  }
}

function input(action, event) {
  const point = getVideoPoint(event, surface.value, width, height)
  if (point)
    emit('input', { type: 'touch', action, ...point })
}

function pointerDown(event) {
  if (event.button !== 0 || status.value !== 'live')
    return
  emit('select')
  if (!props.interactive || !getVideoPoint(event, surface.value, width, height, false))
    return
  event.preventDefault()
  gesture.value = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY }
  surface.value.setPointerCapture(event.pointerId)
  input(0, event)
  // Release an abandoned press even if the OS never delivers pointerup.
  clearTimeout(gestureTimer)
  gestureTimer = setTimeout(releaseTouch, 15000)
}

function pointerMove(event) {
  if (!gesture.value || gesture.value.pointerId !== event.pointerId)
    return
  gesture.value = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY }
  if (performance.now() - lastMove < 24)
    return
  lastMove = performance.now()
  input(2, event)
}

function pointerUp(event) {
  if (!gesture.value || gesture.value.pointerId !== event.pointerId)
    return
  input(1, event)
  gesture.value = null
  clearTimeout(gestureTimer)
}

function releaseTouch() {
  if (!gesture.value)
    return
  input(1, gesture.value)
  gesture.value = null
  clearTimeout(gestureTimer)
}

function begin() {
  if (active)
    return
  active = true
  ipc.on('workbench:event', onEvent)
  window.addEventListener('blur', releaseTouch)
  metricsTimer = setInterval(() => {
    emit('status', { status: status.value, width, height, fps: frameCount, lastFrameAt })
    frameCount = 0
  }, 1000)
  restart()
}

function end() {
  if (!active)
    return
  releaseTouch()
  active = false
  generation++
  clearTimeout(retryTimer)
  clearInterval(metricsTimer)
  ipc.removeListener('workbench:event', onEvent)
  window.removeEventListener('blur', releaseTouch)
  ipc.invoke('workbench:stop', startedDeviceId || props.deviceId, sessionId).catch(() => {})
  sessionId = ''
  closeDecoder()
  decoder = null
}

function closeDecoder() {
  if (decoder && decoder.state !== 'closed')
    decoder.close()
}

watch(() => [props.deviceId, props.maxSize, props.fps], () => {
  if (active)
    restart()
})
watch(() => props.interactive, () => releaseTouch())
onMounted(begin)
onActivated(begin)
onDeactivated(end)
onBeforeUnmount(end)
defineExpose({ restart })
</script>

<style scoped>
.device-surface {
  position: relative;
  height: 100%;
  min-height: 180px;
  background: #080d13;
  overflow: hidden;
  touch-action: none;
}
canvas {
  display: block;
  height: 100%;
  width: 100%;
  object-fit: contain;
  pointer-events: none;
}
.interactive {
  cursor: crosshair;
}
.pressed {
  cursor: grabbing;
}
.screen-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #9aadc2;
  padding: 28px;
  text-align: center;
  background: #0c1420ed;
}
.screen-placeholder i {
  width: 28px;
  height: 28px;
}
.screen-placeholder strong {
  font-size: 13px;
  font-weight: 500;
}
.screen-placeholder p {
  max-width: 300px;
  font-size: 11px;
  word-break: break-word;
  opacity: 0.65;
}
.screen-placeholder button {
  color: #a5ead6;
  border: 1px solid #366e62;
  background: #153b32;
  border-radius: 6px;
  padding: 5px 14px;
  cursor: pointer;
}
</style>
