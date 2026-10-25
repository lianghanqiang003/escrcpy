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
        <button class="control-mode" :class="{ enabled: broadcast }" :disabled="!interactive || devices.length < 2" @click="broadcast = !broadcast">
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
      <div class="workspace-strip">
        <span><i class="status-dot live" />{{ $t('workbench.autoDiscover') }}</span><span>{{ $t('workbench.streamQuality', { fps: maxFps }) }}</span><span class="mode-indicator" :class="{ sync: broadcast && interactive }">{{ $t(interactive ? broadcast ? 'workbench.syncActive' : 'workbench.singleControl' : 'workbench.viewOnly') }}</span>
      </div>
      <div v-if="devices.length" class="screen-grid" :class="{ focused: !!focusedId }" :style="{ '--columns': columns }">
        <article v-for="(device, index) in devices" v-show="!focusedId || focusedId === device.id" :key="identity(device)" class="phone-card" :class="{ selected: selectedId === device.id }">
          <header class="phone-header" @click="selectedId = device.id">
            <span class="phone-icon"><i class="i-lucide-smartphone" /></span><div><strong>{{ label(device) }}</strong><small>{{ $t('workbench.deviceNumber', { number: String(index + 1).padStart(2, '0') }) }}</small></div><span class="phone-live"><i class="status-dot" :class="{ live: metrics[device.id]?.status === 'live' }" />{{ $t(metrics[device.id]?.status === 'live' ? 'workbench.live' : 'workbench.connecting') }}</span><button :title="$t('workbench.focus')" @click.stop="focusedId = focusedId ? '' : device.id">
              <i :class="focusedId ? 'i-lucide-minimize-2' : 'i-lucide-expand'" />
            </button>
          </header>
          <div class="phone-screen">
            <DeviceScreen :device-id="device.id" :max-size="maxSize" :fps="maxFps" :interactive="interactive && (!broadcast || selectedId === device.id)" @select="selectDevice(device.id)" @status="updateMetrics(device.id, $event)" @input="control(device.id, $event)" />
          </div>
          <div class="phone-navigation">
            <button :disabled="!interactive" :title="$t('workbench.back')" @click="key(device.id, 4)">
              <i class="i-lucide-chevron-left" />
            </button><button :disabled="!interactive" :title="$t('workbench.home')" @click="key(device.id, 3)">
              <i class="i-lucide-circle" />
            </button><button :disabled="!interactive" :title="$t('workbench.recents')" @click="key(device.id, 187)">
              <i class="i-lucide-square" />
            </button><span /><button :title="$t('workbench.wake')" @click="key(device.id, 224, true)">
              <i class="i-lucide-sun" />
            </button>
          </div>
          <footer class="phone-footer">
            <span>{{ device.id }}</span><span>{{ metrics[device.id]?.width || '—' }} × {{ metrics[device.id]?.height || '—' }}</span><b>{{ metrics[device.id]?.fps || 0 }} fps</b>
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
  </section>
</template>

<script setup>
import DeviceScreen from './components/device-screen/index.vue'
import { selectOnlineDevices } from './helpers.js'

const router = useRouter()
const store = useDeviceStore()
const ipc = window.$preload.ipcRenderer
const devices = computed(() => selectOnlineDevices(store.list))
const metrics = reactive({})
const selectedId = ref('')
const focusedId = ref('')
const maxSize = ref(720)
const interactive = ref(false)
const broadcast = ref(false)
const refreshing = ref(false)
const maxFps = computed(() => maxSize.value === 1080 ? 30 : 24)
const liveCount = computed(() => devices.value.filter(device => metrics[device.id]?.status === 'live').length)
const columns = computed(() => devices.value.length <= 2 ? devices.value.length : devices.value.length <= 6 ? 3 : 4)
const gestures = new Map()
let interval
let active = false

const identity = device => device.serialNo || device.id
const label = device => device.remark || device.name || device.model || window.t('common.unknownDevice')

function selectDevice(id) {
  if (broadcast.value && interactive.value && gestures.size)
    return
  selectedId.value = id
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
    if (!interactive.value || (broadcast.value && selectedId.value !== id))
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
  width: 218px;
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
  padding: 26px 30px 0;
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
  font-size: 24px;
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
.workspace-actions select {
  background: #172331;
  color: #c0cede;
  border: 1px solid #ffffff12;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 10px;
  outline: none;
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
.workspace-strip {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 22px 0 16px;
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
  grid-template-columns: repeat(var(--columns), minmax(0, 1fr));
  flex: 1;
  min-height: 0;
  gap: 16px;
  overflow: auto;
  padding: 1px 1px 6px;
  align-content: start;
}
.screen-grid.focused {
  grid-template-columns: minmax(0, 1fr);
}
.phone-card {
  min-width: 0;
  border: 1px solid #263547;
  border-radius: 10px;
  overflow: hidden;
  background: #111c29;
  height: calc(100vh - 268px);
  min-height: 280px;
  max-height: 850px;
  display: flex;
  flex-direction: column;
  transition: border-color 0.15s;
}
.phone-card.selected {
  border-color: #4ea68987;
  box-shadow: 0 0 0 1px #49ca9712;
}
.phone-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid #ffffff08;
  cursor: pointer;
}
.phone-icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 30px;
  border: 1px solid #ffffff0c;
  border-radius: 6px;
  color: #7b92a8;
}
.phone-icon i {
  width: 14px;
  height: 14px;
}
.phone-header div {
  flex: 1;
  min-width: 0;
}
.phone-header strong {
  display: block;
  font-size: 11px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.phone-header small {
  display: block;
  font-size: 8px;
  color: #647b91;
  margin-top: 4px;
}
.phone-live {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 8px;
  color: #68c9a8;
  white-space: nowrap;
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
  flex: 1;
  min-height: 0;
}
.phone-navigation {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 7px 14px;
  background: #111c29;
  border-top: 1px solid #ffffff08;
}
.phone-navigation button {
  display: grid;
  place-items: center;
  height: 24px;
  width: 32px;
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
  align-items: center;
  gap: 12px;
  padding: 9px 14px;
  border-top: 1px solid #ffffff08;
  font:
    8px ui-monospace,
    monospace;
  color: #5e7891;
}
.phone-footer span:first-child {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  .screen-grid {
    gap: 24px;
  }
  .fleet-main {
    padding: 32px 42px 0;
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
  .phone-live {
    display: none;
  }
  .screen-grid {
    gap: 10px;
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
  .workspace-strip {
    gap: 10px;
  }
}
</style>
