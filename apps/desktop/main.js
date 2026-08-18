/**
 * Electron main process for the dsh desktop shell.
 *
 * Spawns the built CLI (`apps/cli/lib/bin.js web --port <free>`) on the system
 * Node runtime — never Electron's embedded one, whose version and native-module
 * ABI may not satisfy the harness (`node >=22.19`, patched node-pty, koffi) —
 * then loads `http://127.0.0.1:<port>/` in a single BrowserWindow. Closing the
 * window kills the whole backend process tree.
 */
import { app, BrowserWindow, dialog } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const cliBin = join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')

const STARTUP_TIMEOUT_MS = 60_000
const HEALTH_POLL_MS = 250

/** Reserve an OS-assigned loopback port, then release it for the backend. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** Poll until the web server answers, giving up after the startup timeout. */
async function waitForServer(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return
    } catch {
      // Not up yet; keep polling until the deadline.
    }
    await new Promise(resolve => setTimeout(resolve, HEALTH_POLL_MS))
  }
  throw new Error(`dsh web did not start within ${STARTUP_TIMEOUT_MS / 1000}s`)
}

/** Kill the spawned backend and its children (process tree on Windows). */
function killBackend(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

async function main() {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const logStream = createWriteStream(join(app.getPath('userData'), 'dsh-desktop.log'), { flags: 'a' })
  const log = line => logStream.write(`[${new Date().toISOString()}] ${line}\n`)

  if (!existsSync(cliBin)) {
    dialog.showErrorBox(
      'DeepSeek Harness',
      `Built CLI not found at ${cliBin}.\nRun "pnpm run build" in ${repoRoot} first.`,
    )
    app.exit(1)
    return
  }

  const port = await freePort()
  const url = `http://127.0.0.1:${port}/`
  log(`spawning backend: node ${cliBin} web --port ${port}`)

  const backend = spawn(process.env.DSH_DESKTOP_NODE ?? 'node', [cliBin, 'web', '--port', String(port)], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  backend.stdout.on('data', chunk => log(`[backend] ${String(chunk).trimEnd()}`))
  backend.stderr.on('data', chunk => log(`[backend:err] ${String(chunk).trimEnd()}`))
  backend.on('exit', (code, signal) => log(`backend exited: code=${code} signal=${signal}`))

  app.on('will-quit', () => {
    killBackend(backend)
    logStream.end()
  })

  try {
    await waitForServer(url, Date.now() + STARTUP_TIMEOUT_MS)
  } catch (error) {
    killBackend(backend)
    dialog.showErrorBox(
      'DeepSeek Harness',
      `${error.message}\nSee the log at ${join(app.getPath('userData'), 'dsh-desktop.log')}`,
    )
    app.exit(1)
    return
  }

  log(`backend ready at ${url}`)
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    title: 'DeepSeek Harness',
  })
  window.loadURL(url)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.whenReady().then(main)
}
app.on('window-all-closed', () => app.quit())
