import { defineStore } from 'pinia'
import dayjs from 'dayjs'
import { capitalize } from 'lodash-es'
import { name as packageName } from '$root/package.json'
import {
  getCurrentDevices,
  getHistoryDevices,
  mergeDevices,
  saveDevicesToStore,
} from './helpers/index.js'

const $electronStore = window.$preload.store

export const useDeviceStore = defineStore('app-device', () => {
  const list = ref([])
  const config = ref({})

  function init() {
    config.value = {
      ...($electronStore.get('device') || {}),
    }
    return config.value
  }

  function getLabel(device, params) {
    const data = device?.id
      ? device
      : list.value.find(item => item.id === device)

    if (!data) {
      return ''
    }

    const appName = capitalize(packageName)
    const deviceSerial = data.id.replaceAll(/[<>:"/\\|?*]/g, '_')
    // Fallback for devices without remark/name (e.g. partially hydrated payloads)
    // so labels and generated file names never contain a literal `undefined`.
    const displayName = data.remark || data.name || window.t?.('common.unknownDevice') || 'Unknown Device'
    const deviceName = `${displayName}[${deviceSerial}]`
    const currentTime = dayjs().format('YYYYMMDDHHmmss')
    let value = `${deviceName}-${appName}`

    const createPreset = type => `${deviceName}-${capitalize(type)}-${appName}`

    const presets = {
      screenshot: `${deviceName}-Screenshot-${currentTime}`,
      name: deviceName,
    }

    if (typeof params === 'function') {
      value = params({
        data,
        appName,
        deviceName,
        currentTime,
      })
    }
    else if (params && typeof params === 'string') {
      value = presets[params] || createPreset(params)
    }

    return value
  }

  async function getList() {
    const currentDevices = await getCurrentDevices()
    // A removal made while ADB was being queried must not be saved back as history.
    const historyDevices = getHistoryDevices()
    const mergedDevices = mergeDevices(historyDevices, currentDevices)
    saveDevicesToStore(mergedDevices)
    list.value = mergedDevices
    return mergedDevices
  }

  window.$preload.ipcRenderer.on('adb-recovery:changed', () => {
    getList().catch(error => console.warn('[device:recovery]', error.message))
  })

  function setRemark(deviceId, value) {
    $electronStore.set(['device', deviceId, 'remark'], value)
    init()
  }

  return {
    list,
    config,
    init,
    getLabel,
    getList,
    setRemark,
  }
})
