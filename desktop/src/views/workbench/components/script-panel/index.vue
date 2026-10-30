<template>
  <aside v-show="open" class="script-panel">
    <header class="script-heading">
      <div><i class="i-lucide-workflow" /><strong>{{ $t('automation.title') }}</strong><span v-if="task?.active" class="running-dot" /></div>
      <button :title="$t('automation.close')" @click="$emit('close')">
        <i class="i-lucide-x" />
      </button>
    </header>
    <div class="script-body">
      <div class="script-field">
        <label for="workbench-script">{{ $t('automation.chooseScript') }}</label>
        <select id="workbench-script" v-model="scriptId" :disabled="task?.active || starting">
          <option v-for="id in scriptIds" :key="id" :value="id">
            {{ $t(`automation.script.${id}`) }}
          </option>
        </select>
        <p>{{ $t(`automation.description.${scriptId}`) }}</p>
      </div>
      <div class="script-environment" :class="{ unavailable: !environment?.ready }">
        <i :class="environment?.ready ? 'i-lucide-check-circle-2' : 'i-lucide-info'" />
        <span>{{ $t(environment?.ready ? environment.ocrReady ? 'automation.environmentReady' : 'automation.environmentXml' : 'automation.environmentMissing') }}</span>
      </div>
      <div class="targets-heading">
        <strong>{{ $t('automation.targets', { count: selectedDevices.length }) }}</strong>
        <button :disabled="task?.active || starting" @click="selected = devices.map(identity)">
          {{ $t('automation.selectAll') }}
        </button>
        <button :disabled="task?.active || starting" @click="selected = []">
          {{ $t('automation.selectNone') }}
        </button>
      </div>
      <div class="script-targets">
        <label v-for="device in devices" :key="identity(device)">
          <input v-model="selected" type="checkbox" :value="identity(device)" :disabled="task?.active || starting">
          <span>{{ label(device) }}<small>{{ device.id }}</small></span>
        </label>
        <p v-if="!devices.length">
          {{ $t('workbench.empty') }}
        </p>
      </div>
      <div v-if="scriptId === 'vip-coupon'" class="vip-options">
        <div class="script-field">
          <label for="vip-keyword">{{ $t('automation.vip.keyword') }}</label><input id="vip-keyword" v-model="vipKeyword" :disabled="task?.active || starting" maxlength="80">
        </div>
        <div class="script-field">
          <label for="vip-activity">{{ $t('automation.vip.activity') }}</label><input id="vip-activity" v-model="vipActivity" :disabled="task?.active || starting" maxlength="100"><p>{{ $t('automation.vip.activityHint') }}</p>
        </div>
        <div class="script-field">
          <label>{{ $t('automation.vip.time') }}</label><div class="vip-time">
            <input v-model="vipDate" type="date" :aria-label="$t('automation.vip.date')" :disabled="task?.active || starting"><input v-model="vipTime" type="time" :aria-label="$t('automation.vip.time')" :disabled="task?.active || starting">
          </div><p>{{ $t('automation.vip.timeHint') }}</p>
        </div>
        <label class="vip-checkbox"><input v-model="vipPrepareOnly" type="checkbox" :disabled="task?.active || starting">{{ $t('automation.vip.prepareOnly') }}</label>
        <label class="vip-checkbox"><input v-model="vipRefresh" type="checkbox" :disabled="task?.active || starting">{{ $t('automation.vip.refresh') }}</label>
        <p class="script-scope">
          {{ $t('automation.vip.keepOpen') }}
        </p>
      </div>
      <template v-else-if="scriptId !== 'jd-check'">
        <div class="script-field">
          <label for="workbench-links">{{ $t('automation.links') }}</label>
          <textarea id="workbench-links" v-model="draft" rows="5" :placeholder="$t('automation.linksPlaceholder')" :disabled="task?.active || starting" @input="items = []; rejected = []" />
          <div class="parse-actions">
            <small>{{ $t('automation.linksHint') }}</small>
            <button :disabled="!draft.trim() || parsing || task?.active || starting" @click="parseLinks">
              {{ $t(parsing ? 'automation.parsing' : 'automation.parse') }}
            </button>
          </div>
        </div>
        <details class="commission-field">
          <summary>{{ $t('automation.commissionEntry') }}</summary>
          <input v-model="commissionEntry" :disabled="task?.active || starting" :placeholder="$t('automation.commissionPlaceholder')">
          <p>{{ $t('automation.commissionHint') }}</p>
        </details>
        <div v-if="items.length" class="link-preview">
          <strong>{{ $t('automation.linkCount', { count: items.length }) }}</strong>
          <div v-for="(item, index) in items" :key="item.id" class="preview-item">
            <span :title="item.url">{{ index + 1 }}. {{ item.url }}</span>
            <select v-model="item.kind" :disabled="task?.active || starting" :aria-label="$t('automation.linkType')">
              <option v-for="kind in ['auto', 'coupon', 'product']" :key="kind" :value="kind">
                {{ $t(`automation.kind.${kind}`) }}
              </option>
            </select>
            <button :disabled="task?.active || starting" :title="$t('automation.removeLink')" @click="items.splice(index, 1)">
              <i class="i-lucide-x" />
            </button>
          </div>
        </div>
        <p v-if="rejected.length" class="rejected-links">
          {{ $t('automation.rejected', { count: rejected.length }) }}
        </p>
      </template>
      <button class="run-script" :disabled="!canStart" @click="startTask">
        <i :class="starting ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-play'" />{{ $t(starting ? 'automation.starting' : 'automation.start', { count: selectedDevices.length }) }}
      </button>
      <p class="script-scope">
        {{ $t(scriptId === 'vip-coupon' ? 'automation.vip.scope' : 'automation.scope') }}
      </p>
      <section v-if="task" class="task-results">
        <header>
          <strong>{{ $t('automation.results') }}</strong><button @click="openReport">
            {{ $t('automation.report') }}
          </button><button v-if="task.active" class="stop-script" @click="respond(null, 'stop')">
            {{ $t('automation.stopAll') }}
          </button>
        </header>
        <p>{{ $t(`automation.script.${task.scriptId}`) }} · {{ $t('automation.taskDevices', { count: task.jobs.length }) }}</p>
        <details v-for="job in task.jobs" :key="job.id" class="device-job" :class="job.phase" :open="job.phase === 'paused'">
          <summary><span>{{ deviceLabel(job.deviceId) }}<small>{{ job.deviceId }}</small></span><b>{{ $t(`automation.phase.${job.phase}`) }}</b></summary>
          <p class="job-message">
            {{ job.state.message }}
          </p>
          <p v-if="job.phase === 'waiting'" class="job-message">
            {{ $t('automation.vip.countdown', { time: waitTime(job.state.wait_until) }) }}
          </p>
          <div v-if="job.phase === 'paused' && job.state.pause_reason === 'captcha'" class="captcha-assist">
            <p>{{ $t('automation.vip.captchaHint') }}</p><button @click="$emit('assist', job.deviceId)">
              {{ $t('automation.vip.assist') }}
            </button>
          </div>
          <div class="job-progress">
            <span>{{ $t('automation.progress', { done: completedItems(job).length, total: job.state.items.length }) }}</span><button @click="$emit('focus', job.deviceId)">
              {{ $t('automation.viewDevice') }}
            </button><button v-if="['queued', 'running', 'waiting', 'paused'].includes(job.phase)" @click="respond(job, 'stop')">
              {{ $t('automation.stop') }}
            </button>
          </div>
          <div v-if="job.phase === 'paused'" class="pause-actions">
            <button v-for="action in job.state.pause_options" :key="action" :disabled="pendingAction === job.id" @click="respond(job, action)">
              {{ $t(`automation.action.${action}`) }}
            </button>
          </div>
          <div v-for="(item, index) in job.state.items" :key="item.id || index" class="result-item" :class="item.status">
            <span :title="item.url">{{ index + 1 }}. {{ item.url || item.title || $t('automation.environmentCheck') }}</span><b>{{ $t(`automation.status.${item.status}`) }}</b><small>{{ item.message }}</small>
          </div>
          <details v-if="job.state.logs?.length" class="job-logs">
            <summary>{{ $t('automation.logs') }}</summary><p v-for="(log, index) in job.state.logs.slice(-10)" :key="index">
              {{ log.time }} {{ log.message }}
            </p>
          </details>
        </details>
      </section>
    </div>
  </aside>
</template>

<script setup>
const props = defineProps({ devices: { type: Array, required: true }, open: Boolean })
const emit = defineEmits(['close', 'focus', 'assist', 'starting', 'locks'])
const ipc = window.$preload.ipcRenderer
const scriptIds = ref(['jd-cart', 'jd-coupon', 'jd-check', 'vip-coupon'])
const scriptId = ref('jd-cart')
const environment = ref(null)
const draft = ref('')
const commissionEntry = ref('')
const items = ref([])
const rejected = ref([])
const selected = ref([])
const task = ref(null)
const parsing = ref(false)
const starting = ref(false)
const pendingAction = ref('')
const vipKeyword = ref('四川消费券')
const vipActivity = ref('消费券')
const vipDate = ref(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()))
const vipTime = ref('10:00')
const vipPrepareOnly = ref(false)
const vipRefresh = ref(true)
const now = useNow({ interval: 1000 })
const vipClaimAt = computed(() => Date.parse(`${vipDate.value}T${vipTime.value}:00+08:00`))
let initialized = false
const identity = device => device.serialNo || device.id
const label = device => device.remark || device.name || device.model || device.id
const selectedDevices = computed(() => props.devices.filter(device => selected.value.includes(identity(device))))
const canStart = computed(() => environment.value?.ready && selectedDevices.value.length && !task.value?.active && !starting.value && !parsing.value && (scriptId.value === 'vip-coupon' ? vipKeyword.value.trim() && vipActivity.value.trim() && Number.isFinite(vipClaimAt.value) : scriptId.value === 'jd-check' || items.value.length > 0))
const deviceLabel = id => props.devices.find(device => device.id === id) ? label(props.devices.find(device => device.id === id)) : window.t('automation.device')
const completedItems = job => job.state.items.filter(item => !['pending', 'opening'].includes(item.status))
const showError = error => ElMessage.error(error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''))

watch(() => props.devices, (devices) => {
  if (!initialized && devices.length) {
    selected.value = devices.map(identity)
    initialized = true
  }
}, { immediate: true })
watch(task, (value) => {
  emit('locks', { active: !!value?.active, deviceIds: value?.jobs.filter(job => ['queued', 'running', 'waiting', 'stopping'].includes(job.phase)).map(job => job.deviceId) || [] })
}, { immediate: true })

async function parseLinks() {
  parsing.value = true
  const text = draft.value
  try {
    const result = await ipc.invoke('workbench-automation:parse', text)
    if (text === draft.value) {
      items.value = result.items
      rejected.value = result.rejected
      if (!result.items.length)
        ElMessage.info(window.t('automation.noLinks'))
    }
  }
  catch (error) {
    showError(error)
  }
  finally {
    parsing.value = false
  }
}

async function startTask() {
  if (!canStart.value)
    return
  starting.value = true
  emit('starting')
  try {
    task.value = await ipc.invoke('workbench-automation:start', { scriptId: scriptId.value, deviceIds: selectedDevices.value.map(device => device.id), items: items.value.map(item => ({ url: item.url, kind: item.kind })), commissionEntry: commissionEntry.value.trim(), vip: scriptId.value === 'vip-coupon' ? { keyword: vipKeyword.value, activityText: vipActivity.value, claimAt: vipClaimAt.value, prepareOnly: vipPrepareOnly.value, refresh: vipRefresh.value } : undefined })
  }
  catch (error) {
    showError(error)
  }
  finally {
    starting.value = false
  }
}

async function respond(job, action) {
  pendingAction.value = job?.id || 'all'
  try {
    task.value = await ipc.invoke('workbench-automation:action', { taskId: task.value.id, jobId: job?.id, action, pauseId: job?.state.pause_id })
  }
  catch (error) {
    showError(error)
  }
  finally {
    pendingAction.value = ''
  }
}

async function openReport() {
  try {
    await ipc.invoke('workbench-automation:report')
  }
  catch (error) {
    showError(error)
  }
}

function receive(_, value) {
  task.value = value
}
function waitTime(timestamp) {
  const seconds = Math.max(0, Math.ceil((timestamp - now.value.getTime()) / 1000))
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}
onMounted(async () => {
  ipc.on('workbench-automation:event', receive)
  try {
    const [catalog, current] = await Promise.all([ipc.invoke('workbench-automation:catalog'), ipc.invoke('workbench-automation:state')])
    scriptIds.value = catalog.scriptIds
    environment.value = catalog.environment
    task.value = current
  }
  catch (error) {
    showError(error)
  }
})
onBeforeUnmount(() => ipc.removeListener('workbench-automation:event', receive))
</script>

<style scoped>
.script-panel {
  width: 394px;
  min-width: 320px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid #28394a;
  background: #111b27;
  color: #c7d5e3;
}
.script-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 17px 18px;
  border-bottom: 1px solid #253444;
}
.script-heading > div {
  display: flex;
  align-items: center;
  gap: 9px;
}
.script-heading strong {
  font-size: 13px;
  font-weight: 550;
}
.script-heading i {
  color: #70d7b1;
}
.script-panel button {
  border: 0;
  background: transparent;
  color: #7dc8af;
  cursor: pointer;
  font-size: 10px;
}
.script-panel button:disabled {
  cursor: default;
  opacity: 0.4;
}
.script-panel i {
  display: inline-block;
  width: 14px;
  height: 14px;
}
.script-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 18px;
}
.script-field label,
.targets-heading strong,
.link-preview > strong {
  display: block;
  font-size: 11px;
  font-weight: 500;
  margin-bottom: 8px;
}
.script-panel select,
.script-panel textarea,
.commission-field input,
.vip-options .script-field input {
  width: 100%;
  border: 1px solid #314254;
  color: #c4d4e3;
  background: #0c1520;
  border-radius: 6px;
  padding: 8px;
  font-size: 11px;
  outline: none;
}
.vip-options .script-field {
  margin-bottom: 12px;
}
.vip-time {
  display: flex;
  gap: 8px;
}
.vip-time input {
  min-width: 0;
  color-scheme: dark;
}
.vip-checkbox {
  display: flex;
  gap: 7px;
  align-items: center;
  font-size: 10px;
  color: #8ba4b9;
  margin: 10px 0;
}
.vip-checkbox input {
  accent-color: #6ed6b1;
}
.captcha-assist {
  margin: 0 10px 12px;
  padding: 9px;
  border: 1px solid #866c42;
  background: #49392133;
  border-radius: 5px;
}
.captcha-assist p {
  font-size: 10px;
  line-height: 1.7;
  color: #d6bb8e;
  margin: 0 0 7px;
}
.captcha-assist button {
  padding: 6px !important;
  border: 1px solid #876d43 !important;
  border-radius: 4px;
  color: #ecc58c !important;
}
.script-panel textarea {
  resize: vertical;
  min-height: 95px;
  line-height: 1.6;
  font-family: inherit;
}
.script-panel textarea:focus,
.script-panel select:focus,
.commission-field input:focus {
  border-color: #4caa8c;
}
.script-field p,
.script-scope,
.commission-field p {
  font-size: 10px;
  line-height: 1.7;
  color: #70869c;
  margin: 8px 0 14px;
}
.script-environment {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #6fbd9e;
  font-size: 10px;
  padding: 9px;
  border-radius: 5px;
  background: #1d44312b;
  margin-bottom: 18px;
}
.script-environment.unavailable {
  color: #cfad78;
  background: #4a38252e;
}
.targets-heading {
  display: flex;
  align-items: center;
  gap: 8px;
}
.targets-heading strong {
  flex: 1;
  margin-bottom: 0;
}
.script-targets {
  max-height: 145px;
  overflow: auto;
  margin: 10px 0 18px;
  border: 1px solid #263749;
  border-radius: 6px;
}
.script-targets label {
  display: flex;
  gap: 9px;
  align-items: center;
  padding: 8px 10px;
  font-size: 10px;
  cursor: pointer;
  border-bottom: 1px solid #ffffff07;
}
.script-targets input {
  accent-color: #60d3aa;
}
.script-targets small {
  display: block;
  color: #5f7a92;
  margin-top: 3px;
  font-size: 9px;
}
.script-targets p {
  font-size: 10px;
  padding: 8px;
}
.parse-actions {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
  margin: 7px 0 12px;
}
.parse-actions small {
  font-size: 9px;
  color: #6e849b;
}
.parse-actions button {
  white-space: nowrap;
  border: 1px solid #375d54;
  border-radius: 5px;
  padding: 6px 8px;
}
.commission-field {
  font-size: 10px;
  color: #7a92a8;
  margin-bottom: 12px;
}
.commission-field summary {
  cursor: pointer;
  margin-bottom: 8px;
}
.link-preview {
  margin: 10px 0;
  max-height: 200px;
  overflow: auto;
}
.preview-item {
  display: flex;
  gap: 5px;
  align-items: center;
  margin: 6px 0;
}
.preview-item span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 9px;
  color: #829ab0;
}
.preview-item select {
  width: 72px;
  padding: 4px;
  font-size: 9px;
}
.preview-item i {
  width: 11px;
  height: 11px;
}
.rejected-links {
  color: #d8ac71;
  font-size: 10px;
}
.run-script {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 100%;
  padding: 10px !important;
  background: #21775a !important;
  color: #ddfff0 !important;
  border: 1px solid #3a9b79 !important;
  border-radius: 6px;
  font-size: 11px !important;
  margin-top: 15px;
}
.script-scope {
  text-align: center;
  font-size: 9px;
}
.task-results {
  border-top: 1px solid #293b4d;
  padding-top: 16px;
  margin-top: 18px;
}
.task-results > header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.task-results > header strong {
  flex: 1;
  font-size: 12px;
  font-weight: 500;
}
.task-results > p {
  color: #607b92;
  font-size: 9px;
  margin: 8px 0 12px;
}
.stop-script {
  color: #dd9b83 !important;
}
.device-job {
  border: 1px solid #2c3e50;
  border-radius: 6px;
  margin-bottom: 10px;
  overflow: hidden;
}
.device-job > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  background: #182534;
  cursor: pointer;
  font-size: 10px;
}
.device-job > summary span {
  flex: 1;
}
.device-job > summary small {
  display: block;
  color: #648098;
  margin-top: 4px;
  font-size: 8px;
}
.device-job b {
  font-size: 9px;
  font-weight: 500;
  color: #86a2bb;
}
.device-job.paused {
  border-color: #a48248;
}
.device-job.paused > summary b {
  color: #ebbf7b;
}
.device-job.completed > summary b {
  color: #79c7a3;
}
.device-job.failed > summary b {
  color: #df9689;
}
.job-message {
  padding: 0 10px;
  font-size: 10px;
  line-height: 1.6;
  overflow-wrap: anywhere;
  color: #acbdcc;
}
.job-progress {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 0 10px 10px;
  font-size: 9px;
  color: #6f899f;
}
.job-progress span {
  flex: 1;
}
.pause-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 10px 10px;
}
.pause-actions button {
  border: 1px solid #756040;
  border-radius: 4px;
  color: #dfbc82;
  padding: 6px 8px;
}
.result-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 5px 8px;
  border-top: 1px solid #ffffff08;
  padding: 8px 10px;
}
.result-item > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 9px;
  color: #6c8aa2;
}
.result-item > small {
  grid-column: 1 / -1;
  color: #839caf;
  font-size: 9px;
  line-height: 1.6;
}
.result-item.added b,
.result-item.claimed b,
.result-item.checked b {
  color: #75c5a3;
}
.result-item.uncertain b,
.result-item.unavailable b {
  color: #d2a76c;
}
.result-item.error b {
  color: #d39584;
}
.job-logs {
  padding: 10px;
  color: #607d95;
  font-size: 9px;
}
.job-logs summary {
  cursor: pointer;
}
.job-logs p {
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.running-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #6cdaad;
}
@media (max-width: 1050px) {
  .script-panel {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    z-index: 10;
    box-shadow: -12px 0 30px #0006;
    width: min(394px, 100%);
    min-width: 0;
  }
}
</style>
