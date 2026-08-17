/**
 * Process layer: re-invoking the host CLI that launched this process to run
 * `plugin` subcommands. This is the only module that starts child processes.
 *
 * The command name is never hard-wired: {@link hostArgv} re-invokes the exact
 * entry that launched the host (`dsh`, `dsw`, or a source `bin.ts`), so a
 * renamed binary rebinds the market with zero configuration.
 * @module dsh-featured-plugins/spawn
 */

import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Default install timeout: 15 minutes (slow networks + git installs). */
const INSTALL_TIMEOUT_MS = Number(process.env.DSH_PLUGIN_STORE_INSTALL_TIMEOUT_MS) || 15 * 60 * 1000

/** Windows npm/corepack/pnpm are `.cmd` shims; only a shell can start them. */
export const winCmdShim = process.platform === 'win32'

/** Characters cmd.exe treats as syntax even inside a token. */
const CMD_METACHARS = /[\s"&|<>^()%!]/

/** Quote one argv token for a cmd.exe `/c` command line. */
export function quoteCmdArg(arg: string): string {
  if (!CMD_METACHARS.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

/** Build a cmd.exe command line from argv (Windows shim path only). */
export function cmdCommandLine(argv: readonly string[]): string {
  return argv.map(quoteCmdArg).join(' ')
}

/** cmd.exe resolved once; the Windows shim path only. */
const COMSPEC = process.env.ComSpec ?? 'cmd.exe'

/**
 * Spawn a command without Node's deprecated `shell: true` + argv combo
 * (DEP0190). Windows `.cmd` shims route through `cmd.exe /d /s /c` with an
 * explicitly quoted command line; everything else spawns directly.
 */
function spawnShim(file: string, args: readonly string[], options: SpawnOptions & { viaShell?: boolean }): ChildProcess {
  const { viaShell = false, ...spawnOptions } = options
  if (!viaShell || process.platform !== 'win32') {
    return spawn(file, [...args], { ...spawnOptions, shell: false })
  }
  return spawn(COMSPEC, ['/d', '/s', '/c', `"${cmdCommandLine([file, ...args])}"`], {
    ...spawnOptions,
    shell: false,
    windowsVerbatimArguments: true,
  })
}

/**
 * macOS apps launched from Finder/Dock inherit a minimal PATH without the
 * shell profile, so Homebrew/npm/corepack vanish and installs die with
 * ENOENT/127. Append the well-known bin directories so children find their
 * tools regardless of how the host was started. Also force `CI` so pnpm v10+
 * acts-or-fails instead of blocking on a silent prompt.
 */
function spawnEnv(): NodeJS.ProcessEnv {
  if (process.platform === 'win32') return { ...process.env, CI: 'true' }
  const parts = (process.env.PATH ?? '').split(':').filter(part => part !== '')
  for (const bin of ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')]) {
    if (!parts.includes(bin)) parts.push(bin)
  }
  return { ...process.env, CI: 'true', PATH: parts.join(':') }
}

/**
 * Argv re-invoking the CLI that launched this host process, so plugin
 * commands work whether the host runs from a global bin, a local install, or
 * repo source (`node --import tsx .../bin.ts`). Falls back to a PATH `dsh`.
 *
 * This is the command-name customization point: the entry is read from
 * `process.argv[1]`, so a host launched as `dsw` re-invokes `dsw`.
 */
export function hostArgv(): { file: string; args: string[]; cwd: string | undefined; viaShell: boolean } {
  const entry = process.argv[1]
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh|dsw)$/.test(entry)) {
    // Absolute paths are required: source launches pass a relative entry,
    // which a child would resolve against its OWN cwd and die with
    // MODULE_NOT_FOUND. cwd near the entry keeps execArgv imports resolvable.
    const abs = resolve(entry)
    return { file: process.execPath, args: [...process.execArgv, abs], cwd: dirname(abs), viaShell: false }
  }
  // Bare `dsh` is a .cmd shim on Windows that only a shell can start.
  return { file: 'dsh', args: [], cwd: undefined, viaShell: winCmdShim }
}

/** Outcome of one spawned plugin command. */
export interface SpawnResult {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  cancelled: boolean
}

/** Kill a child and, on POSIX, its whole process group (pnpm grandchild). */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
      return
    } catch { /* fall through */ }
  }
  const signalTree = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return
    try { process.kill(-child.pid, signal) } catch {
      try { child.kill(signal) } catch { /* already gone */ }
    }
  }
  signalTree('SIGTERM')
  const escalate = setTimeout(() => signalTree('SIGKILL'), 5000)
  escalate.unref?.()
}

/**
 * Central allowlist for every spawn target, regardless of which route built
 * it (defense in depth on top of per-route validation).
 */
const TARGET_RE = /^[A-Za-z0-9@:./_#+-]+$/

/**
 * Run one `<host> plugin --profile <profile> …` command with timeout and
 * process-group cancellation.
 * @param profile - the profile name.
 * @param pluginArgs - the plugin sub-args (`add <target>`, `remove <name>`, …).
 */
export function runPluginCommand(profile: string, pluginArgs: readonly string[]): Promise<SpawnResult> {
  const { file, args, cwd, viaShell } = hostArgv()
  const target = pluginArgs[pluginArgs.length - 1] ?? ''
  if (!TARGET_RE.test(target)) {
    return Promise.resolve({ exitCode: 1, timedOut: false, stdout: '', stderr: `unsafe plugin target rejected: ${JSON.stringify(target)}`, cancelled: false })
  }
  return new Promise((resolveSpawn) => {
    const child = spawnShim(file, [...args, 'plugin', '--profile', profile, ...pluginArgs], {
      cwd,
      env: spawnEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      viaShell,
      // Own process group on POSIX so cancel/timeout can kill the whole tree
      // (host wrapper + pnpm grandchild) with one group signal.
      detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cancelled = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, INSTALL_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-256 * 1024) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-64 * 1024) })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveSpawn({ exitCode: 127, timedOut: false, stdout, stderr: `${stderr}\n${error.message}`, cancelled: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveSpawn({ exitCode: code, timedOut, stdout, stderr, cancelled })
    })
    // Expose cancellation via a module-level handle (used by the cancel route).
    activeChild = child
    activeCancel = () => { cancelled = true; killTree(child) }
  })
}

/** The child of the operation currently running, for the cancel route. */
let activeChild: ChildProcess | null = null
let activeCancel: (() => void) | null = null

/** Cancel the plugin command currently running. @returns true when there was one. */
export function cancelActive(): boolean {
  if (activeChild === null || activeCancel === null) return false
  activeCancel()
  return true
}

/** Install a plugin target into a profile by delegating to the host command. */
export function installPlugin(profile: string, target: string): Promise<SpawnResult> {
  return runPluginCommand(profile, ['add', target])
}

/** Remove an installed plugin from a profile. */
export function removePlugin(profile: string, name: string): Promise<SpawnResult> {
  return runPluginCommand(profile, ['remove', name])
}
