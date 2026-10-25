<template>
  <section class="workbench">
    <aside class="fleet-sidebar">
      <div class="fleet-brand">
        <span class="brand-icon"><i class="i-lucide-panels-top-left" /></span><div><strong>{{ $t('workbench.name') }}</strong><small>ESCRCPY · WORKSPACE</small></div>
      </div>
      <div class="fleet-heading">
        <span>{{ $t('workbench.connected') }}</span><b>{{ devices.length.toString().padStart(2, '0') }}</b>
      </div>
      <button v-for="(device, index) in devices" :key="identity(device)" class="fleet-device" :class="{ selected: selectedId === device.id }" @click="selectedId = device.id">
        <span class="device-number">{{ (index + 1).toString().padStart(2, '0') }}</span><div><strong>{{ label(device) }}</strong><small>{{ device.id }}</small></div><span class="status-dot" :class="{ live: metrics[device.id]?.status === 'live' }" />
      </button>
      <p v-if="!devices.length" class="fleet-empty">
        {{ $t('workbench.empty') }}
      </p>
      <div class="fleet-control">
        <div class="control-label">
          <i class="i-lucide-mouse-pointer-2" /><strong>{{ $t('workbench.controlMode') }}</strong>
        </div>
        <button class="control-mode" :class="{ enabled: interactive }" @click="interactive = !interactive">
          <span>{{ $t(interactive ? 'workbench.controlOn' : 'workbench.viewOnly') }}</span><span class="toggle"><i /></span>
        </button>
        <button class="control-mode" :class="{ enabled: broadcast }" :disabled="!interactive || devices.length < 2 || automationLocks.active" @click="broadcast = !broadcast">
          <span>{{ $t('workbench.sync') }}</span><span class="toggle"><i /></span>
        </button>
        <p>{{ $t(broadcast && interactive ? 'workbench.syncHint' : 'workbench.controlHint') }}</p>
      </div>
      <div class="local-badge">
        <i class="i-lucide-shield-check" /><span>{{ $t('workbench.local') }}</span>
      </div>
    </aside>

    <main class="fleet-main">
      <header class="workspace-header">
        <div>
          <div class="eyebrow">
            DEVICE OVERVIEW <span class="live-pill"><i /> LIVE</span>
          </div><h1>{{ $t('workbench.overview') }}</h1><p>{{ $t('workbench.summary', { devices: devices.length, streams: liveCount }) }}</p>
        </div>
        <div class="workspace-actions">
          <button class="script-toggle" :class="{ active: scriptsOpen }" @click="scriptsOpen = !scriptsOpen">
            <i class="i-lucide-workflow" /><span>{{ $t('automation.title') }}</span><b v-if="automationLocks.active" />
          </button>
          <select v-model.number="maxSize" :aria-label="$t('workbench.quality')">
            <option :value="540">
              {{ $t('workbench.qualityCompact') }}
            </option><option :value="720">
              {{ $t('workbench.qualityBalanced') }}
            </option><option :value="1080">
              {{ $t('workbench.qualityHigh') }}
            </option>
          </select>
          <button :title="$t('workbench.refresh')" @click="refresh">
            <i class="i-lucide-refresh-cw" :class="{ 'animate-spin': refreshing }" />
          </button>
          <button :title="$t('workbench.fullscreen')" @click="fullscreen">
            <i class="i-lucide-maximize" />
          </button>
        </div>
      </header>
      <div class="layout-toolbar">
        <label class="size-control">
          <i class="i-lucide-panels-top-left" /><span>{{ $t('workbench.screenSize') }}</span>
          <input v-model.number="tileWidth" type="range" min="140" max="320" step="10" :aria-label="$t('workbench.screenSize')" @input="layoutColumns = 0">
          <output>{{ tileWidth }} px</output>
        </label>
        <label class="columns-control">
          <span>{{ $t('workbench.columns') }}</span>
          <select v-model.number="layoutColumns" :aria-label="$t('workbench.columns')">
            <option :value="0">{{ $t('workbench.autoLayout') }}</option>
            <option v-for="number in [2, 3, 4, 6, 8, 10]" :key="number" :value="number">{{ $t('workbench.columnCount', { number }) }}</option>
          </select>
        </label>
        <span class="layout-tip">{{ $t('workbench.arrangeHint') }}</span>
        <button class="layout-reset" @click="resetLayout">
          {{ $t('workbench.resetLayout') }}
        </button>
      </div>
      <div class="workspace-strip">
        <span><i class="status-dot live" />{{ $t('workbench.autoDiscover') }}</span><span>{{ $t('workbench.streamQuality', { fps: maxFps }) }}</span><span class="mode-indicator" :class="{ sync: broadcast && interactive }">{{ $t(interactive ? broadcast ? 'workbench.syncActive' : 'workbench.singleControl' : 'workbench.viewOnly') }}</span>
      </div>
      <div v-if="devices.length" ref="gridElement" class="screen-grid" :class="{ focused: !!focusedId }" :style="screenLayout.grid">
        <article v-for="(device, index) in devices" :key="identity(device)" class="phone-card" :class="{ 'selected': selectedId === device.id, 'drop-target': draggedId && draggedId !== identity(device), 'enlarged': focusedId === device.id }" :style="{ ...screenLayout.cards[index], '--screen-ratio': screenRatio(device.id) }" @dragover.prevent @drop.prevent="dropDevice(device)">
          <header class="phone-header" @click="selectedId = device.id">
            <span class="arrange-handle" draggable="true" :title="$t('workbench.arrangeHint')" @dragstart="startArrange($event, device)" @dragend="draggedId = ''"><i class="i-lucide-grip-vertical" /></span><div><strong :title="label(device)">{{ label(device) }}</strong><small><i class="status-dot" :class="{ live: metrics[device.id]?.status === 'live' }" />{{ $t('workbench.deviceNumber', { number: String(index + 1).padStart(2, '0') }) }}</small></div><button :title="$t('workbench.focus')" @click.stop="focusDevice(device.id)">
              <i :class="focusedId === device.id ? 'i-lucide-minimize-2' : 'i-lucide-expand'" />
            </button>
          </header>
          <div class="phone-screen">
            <DeviceScreen :device-id="device.id" :max-size="maxSize" :fps="maxFps" :interactive="interactive && !automationLocks.deviceIds.includes(device.id) && (!broadcast || selectedId === device.id)" @select="selectDevice(device.id)" @status="updateMetrics(device.id, $event)" @input="control(device.id, $event)" />
          </div>
          <div class="phone-navigation">
            <button :disabled="!interactive || automationLocks.deviceIds.includes(device.id)" :title="$t('workbench.back')" @click="key(device.id, 4)">
              <i class="i-lucide-chevron-left" />
            </button><button :disabled="!interactive || automationLocks.deviceIds.includes(device.id)" :title="$t('workbench.home')" @click="key(device.id, 3)">
              <i class="i-lucide-circle" />
            </button><button :disabled="!interactive || automationLocks.deviceIds.includes(device.id)" :title="$t('workbench.recents')" @click="key(device.id, 187)">
              <i class="i-lucide-square" />
            </button><span /><button :title="$t('workbench.wake')" @click="key(device.id, 224, true)">
              <i class="i-lucide-sun" />
            </button>
          </div>
          <footer class="phone-footer">
            <span :title="device.id">{{ device.id }}</span><span>{{ metrics[device.id]?.width || '—' }} × {{ metrics[device.id]?.height || '—' }}</span><b>{{ metrics[device.id]?.fps || 0 }} fps</b>
          </footer>
        </article>
      </div>
      <div v-else class="empty-workspace">
        <i class="i-lucide-monitor-smartphone" /><h2>{{ $t('workbench.waiting') }}</h2><p>{{ $t('workbench.waitingHint') }}</p><el-button type="primary" @click="router.push('/device')">
          {{ $t('workbench.connectDevice') }}
        </el-button>
      </div>
      <footer class="workspace-footer">
        <span><i class="i-lucide-radio" />{{ $t('workbench.realtime') }}</span><span>{{ $t('workbench.gestureHint') }}</span><a href="https://github.com/lianghanqiang003/escrcpy" target="_blank">WORKBENCH BUILD ↗</a>
      </footer>
    </main>
    <ScriptPanel :devices="devices" :open="scriptsOpen" @close="scriptsOpen = false" @focus="focusDevice" @starting="prepareAutomation" @locks="automationLocks = $event" />
  </section>
</template>

<script setup>
import DeviceScreen from './components/device-screen/index.vue'
import ScriptPanel from './components/script-panel/index.vue'
import { getScreenLayout, orderDevices, selectOnlineDevices } from './helpers.js'

const router = useRouter()
const store = useDeviceStore()
const ipc = window.$preload.ipcRenderer
const savedOrder = useLocalStorage('escrcpy-workbench-device-order', [])
const devices = computed(() => orderDevices(selectOnlineDevices(store.list), savedOrder.value))
const metrics = reactive({})
const selectedId = ref('')
const focusedId = ref('')
const draggedId = ref('')
const gridElement = ref(null)
const gridSize = useElementSize(gridElement)
const tileWidth = useLocalStorage('escrcpy-workbench-tile-width', 180)
const layoutColumns = useLocalStorage('escrcpy-workbench-columns', 0)
const maxSize = ref(720)
const interactive = ref(false)
const broadcast = ref(false)
const scriptsOpen = ref(false)
const automationLocks = ref({ active: false, deviceIds: [] })
const refreshing = ref(false)
const maxFps = computed(() => maxSize.value === 1080 ? 30 : 24)
const liveCount = computed(() => devices.value.filter(device => metrics[device.id]?.status === 'live').length)
const screenLayout = computed(() => getScreenLayout({
  count: devices.value.length,
  width: Math.max(1, gridSize.width.value - 14),
  height: gridSize.height.value,
  tileWidth: tileWidth.value,
  columns: layoutColumns.value,
  focusedIndex: devices.value.findIndex(device => device.id === focusedId.value),
  focusedRatio: screenRatio(focusedId.value),
}))
const gestures = new Map()
let interval
let active = false

const identity = device => device.serialNo || device.id
const label = device => device.remark || device.name || device.model || window.t('common.unknownDevice')

function screenRatio(id) {
  const { width, height } = metrics[id] || {}
  return width && height ? width / height : 0.45
}

function resetLayout() {
  tileWidth.value = 180
  layoutColumns.value = 0
  savedOrder.value = []
  focusedId.value = ''
}

function focusDevice(id) {
  selectedId.value = id
  focusedId.value = focusedId.value === id ? '' : id
  gridElement.value?.scrollTo({ top: 0, left: 0 })
}

function startArrange(event, device) {
  draggedId.value = identity(device)
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', draggedId.value)
}

function dropDevice(device) {
  const order = devices.value.map(identity)
  const source = order.indexOf(draggedId.value)
  const target = order.indexOf(identity(device))
  if (source >= 0 && target >= 0 && source !== target) {
    order.splice(source, 1)
    order.splice(target, 0, draggedId.value)
    savedOrder.value = [...order, ...savedOrder.value.filter(id => !order.includes(id))]
  }
  draggedId.value = ''
}

function selectDevice(id) {
  if (broadcast.value && interactive.value && gestures.size)
    return
  selectedId.value = id
}

function prepareAutomation() {
  interactive.value = false
  broadcast.value = false
}

function updateMetrics(id, data) {
  metrics[id] = { ...metrics[id], ...data }
}

async function refresh() {
  if (refreshing.value)
    return
  refreshing.value = true
  try {
    await store.getList()
  }
  catch (error) {
    console.warn('[workbench:devices]', error.message)
  }
  finally {
    refreshing.value = false
  }
}

function targets(id) {
  return broadcast.value && interactive.value ? devices.value.map(device => device.id) : [id]
}

function reportError(error) {
  console.warn('[workbench:control]', error.message)
  ElMessage.warning(window.t('workbench.controlError'))
}

function control(id, input) {
  let deviceIds = gestures.get(id)
  // An in-progress gesture keeps its original targets even if sync is toggled.
  if (input.action === 0) {
    if (!interactive.value || automationLocks.value.deviceIds.includes(id) || (broadcast.value && selectedId.value !== id))
      return
    deviceIds = targets(id)
    gestures.set(id, deviceIds)
  }
  if (!deviceIds)
    return
  ipc.invoke('workbench:input', { ...input, deviceIds }).catch(reportError)
  if (input.action === 1 || input.action === 3)
    gestures.delete(id)
}

function key(id, keyCode, force = false) {
  if (automationLocks.value.deviceIds.includes(id))
    return
  if (!force && !interactive.value)
    return
  ipc.invoke('workbench:input', { type: 'key', keyCode, deviceIds: force ? [id] : targets(id) }).catch(reportError)
}

function fullscreen() {
  if (document.fullscreenElement)
    document.exitFullscreen()
  else
    document.querySelector('.workbench').requestFullscreen()
}

function begin() {
  if (active)
    return
  active = true
  refresh()
  interval = setInterval(refresh, 5000)
}

function end() {
  active = false
  clearInterval(interval)
  interactive.value = false
  broadcast.value = false
}

watch(interactive, (value) => {
  if (!value)
    broadcast.value = false
})
watch(() => automationLocks.value.active, (value) => {
  if (value)
    broadcast.value = false
})
watch(devices, (list) => {
  if (!list.some(device => device.id === selectedId.value))
    selectedId.value = list[0]?.id || ''
  if (!list.some(device => device.id === focusedId.value))
    focusedId.value = ''
})
onMounted(begin)
onActivated(begin)
onDeactivated(end)
onBeforeUnmount(end)
</script>

<style scoped>
.workbench {
  position: relative;
  display: flex;
  height: 100%;
  min-height: 430px;
  overflow: hidden;
  background: #0d131c;
  color: #d9e3ee;
  border: 1px solid #ffffff0c;
  border-radius: 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
.workbench:fullscreen {
  border-radius: 0;
}
.workbench button {
  cursor: pointer;
  color: inherit;
}
.workbench button:disabled {
  cursor: default;
  opacity: 0.35;
}
.workbench i {
  display: inline-block;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.fleet-sidebar {
  display: flex;
  flex-direction: column;
  width: 198px;
  flex-shrink: 0;
  padding: 24px 14px 16px;
  background: #111a25;
  border-right: 1px solid #ffffff09;
}
.fleet-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px 30px;
}
.brand-icon {
  display: grid;
  place-items: center;
  width: 34px;
  height: 36px;
  color: #5de3bc;
  border-radius: 9px;
  background: #1c594343;
  border: 1px solid #4ed3a82c;
}
.brand-icon i {
  width: 20px;
  height: 20px;
}
.fleet-brand strong {
  display: block;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 1px;
}
.fleet-brand small {
  display: block;
  margin-top: 4px;
  font-size: 8px;
  color: #697e93;
  letter-spacing: 1.2px;
}
.fleet-heading {
  display: flex;
  justify-content: space-between;
  padding: 0 10px 12px;
  color: #72869b;
  font-size: 10px;
  letter-spacing: 1px;
}
.fleet-heading b {
  font-size: 11px;
  color: #adbdce;
  font-weight: 500;
}
.fleet-device {
  display: flex;
  align-items: center;
  gap: 9px;
  text-align: left;
  padding: 11px 9px;
  border-radius: 8px;
  margin-bottom: 6px;
  border: 1px solid transparent;
  background: transparent;
}
.fleet-device.selected {
  background: #1c302d;
  border-color: #63d4ad36;
}
.device-number {
  font:
    11px ui-monospace,
    monospace;
  color: #738799;
  border: 1px solid #ffffff10;
  padding: 5px 4px;
  border-radius: 5px;
}
.selected .device-number {
  color: #71e0ba;
  border-color: #5cce9b42;
}
.fleet-device div {
  flex: 1;
  min-width: 0;
}
.fleet-device strong {
  display: block;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fleet-device small {
  display: block;
  font:
    9px ui-monospace,
    monospace;
  color: #70869d;
  margin-top: 5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.status-dot {
  display: inline-block;
  width: 5px !important;
  height: 5px !important;
  background: #586674;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot.live {
  background: #56dbac;
  box-shadow: 0 0 6px #49d8a635;
}
.fleet-control {
  margin-top: auto;
  padding: 28px 8px 18px;
}
.control-label {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #8498ab;
  font-size: 10px;
  margin-bottom: 14px;
}
.control-label i {
  width: 12px;
  height: 12px;
}
.control-label strong {
  font-weight: 500;
}
.control-mode {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  font-size: 11px;
  background: transparent;
  border: 0;
  margin: 13px 0;
  padding: 0;
}
.toggle {
  padding: 3px;
  display: inline-flex;
  width: 29px;
  background: #344255;
  border-radius: 20px;
}
.toggle i {
  width: 9px !important;
  height: 9px !important;
  border-radius: 50%;
  background: #8b9cae;
  transition: transform 0.18s;
}
.enabled .toggle {
  background: #257858;
}
.enabled .toggle i {
  background: #b2f4da;
  transform: translateX(14px);
}
.fleet-control p {
  margin: 15px 0 0;
  font-size: 10px;
  line-height: 1.8;
  color: #647b91;
}
.local-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 13px 7px 0;
  border-top: 1px solid #ffffff0b;
  color: #637c91;
  font-size: 9px;
}
.local-badge i {
  width: 12px;
  height: 12px;
  color: #56b59a;
}
.fleet-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  padding: 20px 22px 0;
  overflow: hidden;
}
.workspace-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.eyebrow {
  display: flex;
  align-items: center;
  gap: 11px;
  font-size: 8px;
  letter-spacing: 2px;
  color: #72869b;
}
.live-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 7px;
  letter-spacing: 1px;
  padding: 3px 5px;
  color: #6ad6b0;
  border-radius: 4px;
  background: #15483747;
  border: 1px solid #48a88021;
}
.live-pill i {
  width: 4px;
  height: 4px;
  background: #6ad6b0;
  border-radius: 50%;
}
.workspace-header h1 {
  font-size: 21px;
  font-weight: 550;
  letter-spacing: 1px;
  margin: 9px 0 5px;
}
.workspace-header p {
  font-size: 10px;
  color: #758ba0;
  margin: 0;
}
.workspace-actions {
  display: flex;
  align-items: center;
  gap: 7px;
}
.workspace-actions select,
.layout-toolbar select {
  background: #172331;
  color: #c0cede;
  border: 1px solid #ffffff12;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 10px;
  outline: none;
}
.layout-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px 20px;
  margin-top: 18px;
  padding: 10px 12px;
  border: 1px solid #ffffff0b;
  border-radius: 7px;
  background: #131e2b;
  color: #92a8bd;
  font-size: 10px;
}
.size-control,
.columns-control {
  display: flex;
  align-items: center;
  gap: 8px;
}
.size-control i {
  width: 13px;
  height: 13px;
  color: #63c8a7;
}
.size-control input {
  width: 100px;
  accent-color: #60d7ae;
  cursor: ew-resize;
}
.size-control output {
  min-width: 38px;
  color: #c1d1df;
  font-variant-numeric: tabular-nums;
}
.layout-toolbar select {
  padding: 5px 8px;
}
.layout-tip {
  color: #5e7890;
}
.layout-reset {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: #88baa9 !important;
  padding: 3px;
}
.workspace-actions button,
.phone-header button {
  display: grid;
  place-items: center;
  border: 1px solid #ffffff12;
  border-radius: 6px;
  background: #15212f;
  width: 30px;
  height: 30px;
  color: #9bafc1;
}
.workspace-actions button:hover,
.phone-header button:hover {
  color: #7fe4bc;
  border-color: #7fe4bc60;
}
.workspace-actions i {
  width: 13px;
  height: 13px;
}
.workspace-actions .script-toggle {
  display: flex;
  gap: 6px;
  width: auto;
  padding: 0 10px;
  color: #80c9b1;
  font-size: 10px;
  white-space: nowrap;
}
.script-toggle.active {
  border-color: #4ba789;
  background: #1b3832;
}
.script-toggle b {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #75e0b4;
}
.workspace-strip {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 12px 0;
  color: #60788e;
  font-size: 9px;
}
.workspace-strip span {
  display: flex;
  align-items: center;
  gap: 6px;
}
.workspace-strip .mode-indicator {
  margin-left: auto;
  color: #8fa1b4;
}
.workspace-strip .mode-indicator.sync {
  color: #68dfb0;
}
.screen-grid {
  display: grid;
  flex: 1;
  min-height: 0;
  gap: 12px;
  overflow: auto;
  padding: 1px 1px 6px;
  align-content: start;
  align-items: start;
  scrollbar-gutter: stable;
}
.phone-card {
  min-width: 0;
  border: 1px solid #263547;
  border-radius: 7px;
  overflow: hidden;
  background: #111c29;
  display: flex;
  flex-direction: column;
  transition: border-color 0.15s;
}
.phone-card.selected {
  border-color: #4ea68987;
  box-shadow: 0 0 0 1px #49ca9712;
}
.phone-card.drop-target {
  border-style: dashed;
}
.phone-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 5px;
  padding: 7px 6px;
  border-bottom: 1px solid #ffffff08;
  cursor: pointer;
}
.arrange-handle {
  display: grid;
  place-items: center;
  width: 15px;
  height: 27px;
  color: #536e84;
  cursor: grab;
}
.arrange-handle:hover {
  color: #71dfb8;
}
.arrange-handle i {
  width: 12px;
  height: 14px;
}
.phone-header div {
  flex: 1;
  min-width: 0;
}
.phone-header strong {
  display: block;
  font-size: 10px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.phone-header small {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 8px;
  color: #647b91;
  margin-top: 3px;
}
.phone-header button {
  width: 22px;
  height: 24px;
  border: 0;
  background: transparent;
}
.phone-header button i {
  width: 12px;
  height: 12px;
}
.phone-screen {
  width: 100%;
  aspect-ratio: var(--screen-ratio, 0.45);
  min-height: 0;
}
.phone-navigation {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: #111c29;
  border-top: 1px solid #ffffff08;
}
.phone-navigation button {
  display: grid;
  place-items: center;
  height: 23px;
  width: 27px;
  border: 0;
  background: transparent;
  color: #7a91a9;
  border-radius: 5px;
}
.phone-navigation button:hover:enabled {
  background: #233748;
  color: #7de7be;
}
.phone-navigation button i {
  width: 12px;
  height: 12px;
}
.phone-navigation span {
  flex: 1;
}
.phone-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 6px 8px;
  border-top: 1px solid #ffffff08;
  font:
    8px ui-monospace,
    monospace;
  color: #5e7891;
}
.phone-footer span:first-child {
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.phone-footer span:nth-child(2) {
  flex: 1;
}
.phone-footer b {
  color: #77bba2;
  font-weight: 400;
  white-space: nowrap;
}
.workspace-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 15px;
  color: #4e677e;
  padding: 14px 0;
  font-size: 8px;
}
.workspace-footer span {
  display: flex;
  align-items: center;
  gap: 5px;
}
.workspace-footer i {
  width: 10px;
  height: 10px;
  color: #4e9f86;
}
.workspace-footer a {
  color: #526f84;
  font-size: 7px;
  letter-spacing: 1px;
  text-decoration: none;
}
.empty-workspace {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 15px;
  color: #6b849c;
  text-align: center;
}
.empty-workspace > i {
  width: 44px;
  height: 44px;
  color: #44645e;
}
.empty-workspace h2 {
  font-size: 17px;
  font-weight: 500;
  margin: 5px;
  color: #b4c5d5;
}
.empty-workspace p,
.fleet-empty {
  font-size: 11px;
  color: #72889f;
}
@media (min-width: 1700px) {
  .fleet-main {
    padding: 24px 26px 0;
  }
}
@media (max-width: 1000px) {
  .fleet-sidebar {
    width: 180px;
    padding: 20px 10px;
  }
  .fleet-main {
    padding: 22px 18px 0;
  }
  .layout-tip {
    display: none;
  }
  .phone-footer {
    gap: 6px;
    padding-inline: 9px;
  }
  .workspace-footer span:nth-child(2) {
    display: none;
  }
}
@media (max-width: 720px) {
  .fleet-sidebar {
    display: none;
  }
  .workspace-header h1 {
    font-size: 19px;
  }
  .workspace-header {
    flex-wrap: wrap;
  }
  .workspace-strip {
    gap: 10px;
  }
}
</style>
