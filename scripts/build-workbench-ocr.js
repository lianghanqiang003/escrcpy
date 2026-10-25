import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

if (process.platform === 'darwin') {
  const root = path.resolve(import.meta.dirname, '..')
  const source = path.join(root, 'desktop/electron/resources/extra/common/automation/jd-cart/ocr-preprocess.swift')
  const directory = path.join(root, `desktop/electron/resources/extra/mac-${process.arch}/automation`)
  fs.mkdirSync(directory, { recursive: true })
  execFileSync('xcrun', ['swiftc', '-O', source, '-o', path.join(directory, 'ocr-preprocess')], { stdio: 'inherit' })
}
