import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { app, ipcMain } from 'electron'
import { getAdb } from '$electron/configs/which/index.js'
import { extraResolve, getExtraPlatformDirs } from '$electron/process/resources.js'
import { encodeKey, encodeTouch, VideoPacketReader } from './protocol.js'

const run = promisify(execFile)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

export default {
  name: 'module:workbench',
  apply() {
    const sessions = new Map()
    const owners = new Set()
    let versionPromise

    async function adb(deviceId, args) {
      const binary = getAdb()
      if (!binary)
        throw new Error('ADB is unavailable')
      return run(binary, ['-s', deviceId, ...args], { timeout: 12000, maxBuffer: 1024 * 1024 })
    }

    function send(session, data) {
      if (!session.closed && !session.owner.isDestroyed())
        session.owner.send('workbench:event', { deviceId: session.deviceId, sessionId: session.id, requestId: session.requestId, ...data })
    }

    function stop(session, reason = 'Screen session stopped') {
      if (!session || session.closed)
        return
      send(session, { type: 'stopped', message: reason })
      session.closed = true
      if (sessions.get(session.key) === session)
        sessions.delete(session.key)
      session.video?.destroy()
      session.control?.destroy()
      session.process?.kill()
      clearTimeout(session.killTimer)
      session.killTimer = setTimeout(() => session.process?.kill('SIGKILL'), 1500)
      session.killTimer.unref()
      if (session.port)
        adb(session.deviceId, ['forward', '--remove', `tcp:${session.port}`]).catch(() => {})
    }

    function stopOwner(ownerId) {
      for (const session of sessions.values()) {
        if (session.owner.id === ownerId)
          stop(session)
      }
    }

    function bindOwner(owner) {
      if (owners.has(owner.id))
        return
      owners.add(owner.id)
      owner.once('destroyed', () => {
        stopOwner(owner.id)
        owners.delete(owner.id)
      })
      owner.on('did-start-navigation', (_, __, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace)
          stopOwner(owner.id)
      })
    }

    function publish(session, packet) {
      if (packet.type === 'size') {
        session.size = { width: packet.width, height: packet.height }
        session.waitKey = true
        session.config = null
        send(session, packet)
        return
      }
      if (packet.config) {
        session.config = packet.data
        session.waitKey = true
        return
      }
      // Bound IPC backlog. Resume with config + a keyframe after dropping frames.
      if (session.pending.size >= 4) {
        session.waitKey = true
        return
      }
      if (session.waitKey && !packet.key)
        return
      if (packet.key && session.config)
        send(session, { type: 'config', data: session.config })
      session.waitKey = false
      const sequence = ++session.sequence
      session.pending.add(sequence)
      send(session, { ...packet, sequence })
    }

    async function connectVideo(session) {
      for (let attempt = 0; attempt < 40 && !session.closed; attempt++) {
        const socket = net.createConnection({ host: '127.0.0.1', port: session.port })
        const ready = await new Promise((resolve) => {
          const finish = (ok) => {
            socket.removeAllListeners('data')
            socket.removeAllListeners('error')
            socket.removeAllListeners('close')
            socket.setTimeout(0)
            resolve(ok)
          }
          socket.setTimeout(700, () => {
            socket.destroy()
            finish(false)
          })
          socket.once('error', () => finish(false))
          socket.once('close', () => finish(false))
          socket.once('data', (data) => {
            if (data[0] !== 0) {
              socket.destroy()
              finish(false)
              return
            }
            socket.pause()
            if (data.length > 1)
              socket.unshift(data.subarray(1))
            finish(true)
          })
        })
        if (ready)
          return socket
        socket.destroy()
        if (session.process?.exitCode !== null)
          break
        await delay(150)
      }
      throw new Error(session.log || 'Could not start screen streaming')
    }

    async function start(owner, options = {}) {
      const deviceId = String(options.deviceId || '')
      if (!deviceId || deviceId.length > 256 || /[\s\0]/.test(deviceId))
        throw new Error('Invalid device id')
      const key = `${owner.id}:${deviceId}`
      stop(sessions.get(key))
      bindOwner(owner)
      const maxSize = [540, 720, 1080].includes(options.maxSize) ? options.maxSize : 720
      const fps = [15, 24, 30].includes(options.fps) ? options.fps : 24
      const scid = randomBytes(4).readUInt32BE() & 0x7FFFFFFF
      const id = scid.toString(16).padStart(8, '0')
      const session = { key, id, deviceId, owner, requestId: String(options.requestId || '').slice(0, 128), pending: new Set(), sequence: 0, waitKey: true, log: '', size: {} }
      sessions.set(key, session)
      try {
        if (!versionPromise) {
          // Always match the bundled server with the bundled client version.
          const binary = path.join(getExtraPlatformDirs().scrcpy, process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy')
          versionPromise = run(binary, ['--version'], { timeout: 5000 }).then(({ stdout }) => {
            const version = stdout.match(/scrcpy\s+(\d+\.\d+(?:\.\d+)?)/)?.[1]
            if (!version || Number(version.split('.')[0]) < 4)
              throw new Error('Workbench requires bundled scrcpy 4.x or later')
            return version
          }).catch((error) => {
            versionPromise = null
            throw error
          })
        }
        const version = await versionPromise
        const remote = `/data/local/tmp/escrcpy-workbench-${id}.jar`
        await adb(deviceId, ['push', extraResolve('common/scrcpy/scrcpy-server'), remote])
        if (session.closed)
          return { sessionId: id }
        const { stdout } = await adb(deviceId, ['forward', 'tcp:0', `localabstract:scrcpy_${id}`])
        session.port = Number(stdout.trim())
        if (!(session.port > 0 && session.port < 65536))
          throw new Error('ADB forwarding failed')
        const args = [
          `CLASSPATH=${remote}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', version,
          `scid=${id}`, 'log_level=warn', 'video=true', 'audio=false', 'control=true',
          `max_size=${maxSize}`, `max_fps=${fps}`, 'video_bit_rate=2500000', 'video_codec=h264',
          'tunnel_forward=true', 'send_device_meta=true', 'send_stream_meta=true',
          'send_frame_meta=true', 'send_dummy_byte=true', 'video_codec_options=i-frame-interval=1',
          'cleanup=true', 'clipboard_autosync=false', 'power_on=true', 'stay_awake=true',
        ]
        if (session.closed)
          return { sessionId: id }
        session.process = spawn(getAdb(), ['-s', deviceId, 'shell', args.join(' ')], { stdio: ['ignore', 'pipe', 'pipe'] })
        const log = (data) => {
          session.log = (session.log + String(data)).slice(-2500)
        }
        session.process.stdout.on('data', log)
        session.process.stderr.on('data', log)
        session.process.on('error', error => send(session, { type: 'error', message: error.message }))
        session.process.on('exit', () => {
          if (!session.closed) {
            send(session, { type: 'error', message: session.log || 'Device stream disconnected' })
            stop(session)
          }
        })
        session.video = await connectVideo(session)
        if (session.closed) {
          session.video.destroy()
          return { sessionId: id }
        }
        session.control = net.createConnection({ host: '127.0.0.1', port: session.port })
        session.control.on('data', () => {})
        session.control.on('error', error => send(session, { type: 'error', message: error.message }))
        const reader = new VideoPacketReader(packet => publish(session, packet))
        session.video.on('data', (data) => {
          try {
            reader.push(data)
          }
          catch (error) {
            send(session, { type: 'error', message: error.message })
            stop(session)
          }
        })
        session.video.on('error', error => send(session, { type: 'error', message: error.message }))
        session.video.on('close', () => {
          if (!session.closed) {
            send(session, { type: 'error', message: session.log || 'Device stream disconnected' })
            stop(session)
          }
        })
        session.video.resume()
        return { sessionId: id }
      }
      catch (error) {
        stop(session)
        throw error
      }
      finally {
        if (session.closed && session.port)
          adb(deviceId, ['forward', '--remove', `tcp:${session.port}`]).catch(() => {})
      }
    }

    ipcMain.handle('workbench:start', (event, options) => start(event.sender, options))
    ipcMain.handle('workbench:stop', (event, deviceId, sessionId) => {
      const session = sessions.get(`${event.sender.id}:${deviceId}`)
      if (sessionId && session?.id === sessionId)
        stop(session)
    })
    ipcMain.on('workbench:ack', (event, deviceId, sessionId, sequence) => {
      const session = sessions.get(`${event.sender.id}:${deviceId}`)
      if (session?.id === sessionId)
        session.pending.delete(sequence)
    })
    ipcMain.handle('workbench:input', (event, input) => {
      const targets = [...new Set(Array.isArray(input?.deviceIds) ? input.deviceIds : [])]
      if (!targets.length || targets.length > 64)
        throw new Error('Invalid control targets')
      let count = 0
      for (const deviceId of targets) {
        const session = sessions.get(`${event.sender.id}:${deviceId}`)
        if (!session?.control || session.closed || !session.size.width)
          continue
        if (input.type === 'touch') {
          session.control.write(encodeTouch(input, session.size))
        }
        else if (input.type === 'key') {
          session.control.write(encodeKey(input.keyCode, 0))
          session.control.write(encodeKey(input.keyCode, 1))
        }
        else { throw new Error('Unsupported control operation') }
        count++
      }
      return count
    })
    const cleanup = () => {
      for (const session of sessions.values())
        stop(session)
    }
    app.on('before-quit', cleanup)
    return () => {
      cleanup()
      app.removeListener('before-quit', cleanup)
      for (const channel of ['start', 'stop', 'input']) ipcMain.removeHandler(`workbench:${channel}`)
      ipcMain.removeAllListeners('workbench:ack')
    }
  },
}
