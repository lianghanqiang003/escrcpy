import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { app, ipcMain, powerMonitor } from 'electron'
import { getAdb } from '$electron/configs/which/index.js'
import store from '$electron/helpers/store/index.js'
import { createAdbRecovery } from './recovery.js'

const run = promisify(execFile)

export function probePort(host, port, timeout = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    const finish = (reachable) => {
      socket.destroy()
      resolve(reachable)
    }
    socket.setTimeout(timeout, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export default {
  name: 'service:adb-recovery',
  apply(mainApp) {
    const logPath = path.join(app.getPath('logs'), 'adb-recovery.log')
    let logQueue = Promise.resolve()
    const log = (...args) => {
      console.info('[adb-recovery]', ...args)
      if (args[0] === 'connected') {
        const win = mainApp.getMainWindow()
        if (win && !win.isDestroyed())
          win.webContents.send('adb-recovery:changed')
      }
      logQueue = logQueue.then(async () => {
        await fs.mkdir(path.dirname(logPath), { recursive: true })
        if ((await fs.stat(logPath).catch(() => null))?.size > 1024 * 1024)
          await fs.rename(logPath, `${logPath}.previous`).catch(() => {})
        await fs.appendFile(logPath, `${new Date().toISOString()} ${args.join(' ')}\n`, { mode: 0o600 })
      }).catch(() => {})
    }
    const recovery = createAdbRecovery({
      runAdb: (args) => {
        const binary = getAdb()
        if (!binary)
          throw new Error('ADB is unavailable')
        return run(binary, args, { timeout: 6000, maxBuffer: 256 * 1024, windowsHide: true })
      },
      probe: probePort,
      getHistory: () => store.get('device') || {},
      enabled: () => !app.isQuitting && store.get('common.autoConnect') === true,
      log,
    })

    const check = () => recovery.check()
    const timer = setInterval(check, 15000)
    timer.unref()
    powerMonitor.on('resume', check)
    powerMonitor.on('unlock-screen', check)
    // Manual disconnect remains disconnected until an explicit connect or app restart.
    ipcMain.handle('adb-recovery:set-suppressed', (_, { id, suppressed } = {}) => {
      if (typeof id === 'string' && id.length <= 256)
        recovery.setSuppressed(id, Boolean(suppressed))
    })
    log('started', `ADB=${getAdb()}`)
    check()

    return () => {
      recovery.stop()
      clearInterval(timer)
      powerMonitor.removeListener('resume', check)
      powerMonitor.removeListener('unlock-screen', check)
      ipcMain.removeHandler('adb-recovery:set-suppressed')
    }
  },
}
