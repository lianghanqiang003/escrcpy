import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { app, ipcMain, shell } from 'electron'
import { getAdb } from '$electron/configs/which/index.js'
import { extraResolve, whichResolve } from '$electron/process/resources.js'
import { ACTIVE_PHASES, finalizeInterruptedState, SCRIPT_IDS, validateRequest } from './validation.js'

const run = promisify(execFile)

export default {
  name: 'module:workbench-automation',
  apply() {
    const root = path.join(app.getPath('userData'), 'workbench-automation')
    const lastTask = path.join(root, 'last-task.json')
    const bridge = extraResolve('common/automation/jd-cart/bridge.py')
    const children = new Map()
    let task = null
    let owner = null
    let starting = false
    let closing = false
    let persistTimer
    const active = () => !!task?.jobs.some(job => ACTIVE_PHASES.includes(job.phase))
    const snapshot = () => task ? { ...task, active: active() } : null
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    try {
      task = JSON.parse(fs.readFileSync(lastTask, 'utf8'))
      for (const job of task.jobs) {
        if (ACTIVE_PHASES.includes(job.phase)) {
          job.phase = 'stopped'
          job.state = finalizeInterruptedState(job.state)
        }
      }
    }
    catch {
      task = null
    }

    function persist() {
      if (!task)
        return
      const data = JSON.stringify(snapshot(), null, 2)
      fs.writeFileSync(`${lastTask}.tmp`, data, { mode: 0o600 })
      fs.renameSync(`${lastTask}.tmp`, lastTask)
      fs.writeFileSync(path.join(task.folder, 'task.json'), data, { mode: 0o600 })
    }

    function publish() {
      if (owner && !owner.isDestroyed())
        owner.send('workbench-automation:event', snapshot())
      clearTimeout(persistTimer)
      persistTimer = setTimeout(() => {
        try {
          persist()
        }
        catch (error) {
          console.warn('[automation:report]', error.message)
        }
      }, 300)
    }

    async function environment() {
      const python = whichResolve('python3')
      const tesseract = whichResolve('tesseract')
      let pythonReady = false
      if (python) {
        try {
          const { stdout } = await run(python, ['-c', 'import sys; print(int(sys.version_info >= (3,10)))'], { timeout: 5000 })
          pythonReady = stdout.trim() === '1'
        }
        catch {}
      }
      return { ready: process.platform === 'darwin' && pythonReady && !!getAdb(), pythonReady, ocrReady: !!tesseract, supported: process.platform === 'darwin', python, tesseract }
    }

    function launch(env, request, folder) {
      const child = spawn(env.python, ['-u', bridge], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1',
          ADB: getAdb(), JD_RUNS_DIR: folder,
          JD_TESSERACT: env.tesseract || '',
          JD_OCR_HELPER: extraResolve(`mac-${process.arch}/automation/ocr-preprocess`),
          JD_COUPON_ONLY: request.scriptId === 'jd-coupon' ? '1' : '0',
        },
      })
      child.stdin.on('error', () => {})
      child.stdin.write(`${JSON.stringify(request)}\n`)
      return child
    }

    function terminate(child) {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, 'SIGTERM')
        }
        catch {
          child.kill()
        }
      }
    }

    async function parse(text) {
      if (typeof text !== 'string' || text.length > 100000)
        throw new Error('链接文本过长')
      const env = await environment()
      if (!env.ready)
        throw new Error('需要 macOS、Python 3.10+ 和 ADB')
      return new Promise((resolve, reject) => {
        const child = launch(env, { mode: 'parse', text }, root)
        let result
        let error = ''
        const timer = setTimeout(() => terminate(child), 15000)
        child.stdin.end()
        child.stderr.on('data', data => error = (error + data).slice(-2000))
        const lines = createInterface({ input: child.stdout })
        lines.on('line', (line) => {
          try {
            result = JSON.parse(line)
          }
          catch {
            error = '脚本返回了无法识别的结果'
          }
        })
        child.once('error', reject)
        child.once('close', (code) => {
          clearTimeout(timer)
          if (code === 0 && result?.type === 'parsed')
            resolve({ items: result.items, rejected: result.rejected })
          else
            reject(new Error(result?.message || error || '链接识别失败'))
        })
      })
    }

    function pump(env) {
      if (closing || !task)
        return
      for (const job of task.jobs) {
        if (children.size >= 4)
          break
        if (job.phase !== 'queued')
          continue
        job.phase = 'running'
        const folder = path.join(task.folder, job.id)
        fs.mkdirSync(folder, { mode: 0o700 })
        const child = launch(env, { mode: 'run', scriptId: task.scriptId, deviceId: job.deviceId, items: task.items, commissionEntry: task.commissionEntry }, folder)
        children.set(job.id, { child })
        let error = ''
        child.stderr.on('data', data => error = (error + data).slice(-2000))
        child.on('error', (failure) => {
          error = failure.message
        })
        createInterface({ input: child.stdout }).on('line', (line) => {
          if (line.length > 2_000_000)
            return terminate(child)
          try {
            const event = JSON.parse(line)
            if (event.type === 'state') {
              job.state = event.state
              if (job.phase !== 'stopping')
                job.phase = event.state.running ? event.state.paused ? 'paused' : 'running' : event.state.outcome || 'completed'
            }
            else if (event.type === 'fatal') {
              error = event.message
            }
            else if (event.type === 'command-error') {
              job.state.message = event.message
            }
            publish()
          }
          catch (failure) {
            error = failure.message
          }
        })
        child.once('close', (code) => {
          clearTimeout(children.get(job.id)?.timer)
          children.delete(job.id)
          if (['stopping', 'stopped'].includes(job.phase)) {
            job.phase = 'stopped'
            job.state = finalizeInterruptedState(job.state)
          }
          else if (code !== 0 || ACTIVE_PHASES.includes(job.phase)) {
            job.phase = 'failed'
            job.state = { ...finalizeInterruptedState(job.state), message: error || '脚本意外退出，请核对手机后重新选择任务' }
          }
          publish()
          pump(env)
        })
      }
      publish()
    }

    function stopJob(job) {
      if (!ACTIVE_PHASES.includes(job.phase))
        return
      const running = children.get(job.id)
      if (!running) {
        job.phase = 'stopped'
        job.state = finalizeInterruptedState(job.state)
        return
      }
      job.phase = 'stopping'
      running.child.stdin.write(`${JSON.stringify({ action: 'stop' })}\n`)
      clearTimeout(running.timer)
      running.timer = setTimeout(() => terminate(running.child), 2000)
    }

    const channels = {
      catalog: async () => ({ scriptIds: SCRIPT_IDS, environment: await environment() }),
      state: (event) => {
        if (!active())
          owner = event.sender
        return snapshot()
      },
      parse: (_, text) => parse(text),
      start: async (event, input) => {
        if (starting || active())
          throw new Error('请先停止或完成当前任务')
        starting = true
        try {
          const request = validateRequest(input)
          const env = await environment()
          if (!env.ready)
            throw new Error('需要 macOS、Python 3.10+ 和 ADB')
          const online = (await run(getAdb(), ['devices'], { timeout: 10000 })).stdout.split('\n').filter(row => /\tdevice\s*$/.test(row)).map(row => row.split('\t')[0])
          const identities = new Set()
          for (const id of request.deviceIds) {
            if (!online.includes(id))
              throw new Error(`手机已离线：${id}`)
            const serial = (await run(getAdb(), ['-s', id, 'shell', 'getprop', 'ro.serialno'], { timeout: 8000 })).stdout.trim() || id
            if (identities.has(serial))
              throw new Error('同一手机有多个连接入口，请刷新设备列表')
            identities.add(serial)
          }
          const id = randomUUID()
          const folder = path.join(root, id)
          fs.mkdirSync(folder, { mode: 0o700 })
          task = { id, folder, scriptId: request.scriptId, items: request.items, commissionEntry: request.commissionEntry, createdAt: new Date().toISOString(), jobs: request.deviceIds.map(deviceId => ({ id: randomUUID(), deviceId, phase: 'queued', state: { items: request.items.map(item => ({ ...item, status: 'pending' })), message: '等待执行', logs: [] } })) }
          owner = event.sender
          const ownerId = owner.id
          owner.once('destroyed', () => {
            if (owner?.id === ownerId)
              task?.jobs.forEach(stopJob)
          })
          pump(env)
          return snapshot()
        }
        finally {
          starting = false
        }
      },
      action: (event, { taskId, jobId, action, pauseId } = {}) => {
        if (!task || task.id !== taskId || (active() && owner?.id !== event.sender.id))
          throw new Error('任务已更新，请刷新任务面板')
        const jobs = jobId ? task.jobs.filter(job => job.id === jobId) : task.jobs
        if (!jobs.length)
          throw new Error('未找到设备任务')
        for (const job of jobs) {
          if (action === 'stop') {
            stopJob(job)
          }
          else {
            if (!jobId || job.phase !== 'paused' || !pauseId || job.state.pause_id !== pauseId || !job.state.pause_options?.includes(action))
              throw new Error('暂停提示已经更新，请重新确认')
            children.get(job.id)?.child.stdin.write(`${JSON.stringify({ action, pauseId })}\n`)
          }
        }
        publish()
        return snapshot()
      },
      report: () => task && shell.openPath(task.folder),
    }
    for (const [channel, handler] of Object.entries(channels))
      ipcMain.handle(`workbench-automation:${channel}`, handler)
    function cleanup() {
      closing = true
      clearTimeout(persistTimer)
      for (const { child, timer } of children.values()) {
        clearTimeout(timer)
        terminate(child)
      }
      for (const job of task?.jobs || []) {
        if (ACTIVE_PHASES.includes(job.phase)) {
          job.phase = 'stopped'
          job.state = finalizeInterruptedState(job.state)
        }
      }
      try {
        persist()
      }
      catch {}
    }
    app.on('before-quit', cleanup)
    return () => {
      cleanup()
      app.removeListener('before-quit', cleanup)
      for (const channel of Object.keys(channels))
        ipcMain.removeHandler(`workbench-automation:${channel}`)
    }
  },
}
