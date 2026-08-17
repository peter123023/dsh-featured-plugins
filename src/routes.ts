/**
 * HTTP routes bridging the browser market UI to the host. This layer only
 * parses requests, calls the service modules, and serializes responses —
 * process spawning lives in spawn.ts, filesystem reads in profile.ts.
 *
 * Security: mutating endpoints accept only same-origin POSTs, and install
 * resolves its target from the curated registry (the client sends a registry
 * `url`, never an arbitrary target).
 * @module dsh-featured-plugins/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadRegistry } from './registry.ts'
import { profileDir, readInstalled, readProfileBundles } from './profile.ts'
import { verifyActivation } from './verify.ts'
import { readDisabled, setDisabled } from './state.ts'
import { cancelActive, runPluginCommand, type SpawnResult } from './spawn.ts'

/** The web server service contract the host provides. */
export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The host services the market routes require. */
export interface MarketHost {
  webServer: WebServerService
  loader: { entries(): Iterable<{ name?: string; entry?: { options?: { name?: string } } }> }
}

/** The market's runtime configuration (profile identity + restart policy). */
export interface MarketConfig {
  /** Profile the market installs into; matches the profile serving this UI. */
  profile: string
  /** Host-authoritative profile directory; ordinary DSH derives it from DSH_HOME. */
  profileDirectory?: string
  /** Detached self-restart is unsafe under systemd/launchd/pm2; operators can disable it. */
  allowRestart?: boolean
}

/** A plugin-command runtime the routes delegate installs to. */
export interface PluginCommandRuntime {
  runPlugin(profile: string, pluginArgs: string[]): Promise<SpawnResult>
  cancelActive(): boolean
}

const PROFILE_RE = /^[A-Za-z0-9_-]+$/

/** Write a JSON payload with no-store caching. */
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/** True when the request's Origin matches its Host — required on every POST route. */
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read and parse a JSON request body, rejecting anything over 4 KiB. */
async function readJsonBody(request: IncomingMessage, maxBytes = 4096): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** A same-origin POST guard wrapping a mutating handler. */
function requireSameOrigin(request: IncomingMessage, response: ServerResponse): boolean {
  if (!sameOrigin(request)) {
    sendJson(response, 403, { error: 'cross-origin request rejected' })
    return false
  }
  return true
}

/**
 * Register the market's HTTP routes.
 * @param host - the host webServer + loader services.
 * @param config - the resolved market configuration.
 * @param commandRuntime - plugin-command runner (defaults to the spawn layer).
 * @returns Disposer removing every registered route.
 */
export function mountMarketRoutes(
  host: MarketHost,
  config: MarketConfig,
  commandRuntime?: PluginCommandRuntime,
): () => void {
  if (config.profileDirectory === undefined && !PROFILE_RE.test(config.profile)) {
    throw new Error(`dsh-featured-plugins: invalid profile name: ${config.profile}`)
  }
  const commands = commandRuntime ?? {
    runPlugin: runPluginCommand,
    cancelActive,
  }

  const disposers: Array<() => void> = []

  const register = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): void => {
    disposers.push(host.webServer.register({ kind: 'exact', path, handler }))
  }

  // --- GET /market/list: the curated catalog with provenance. ---
  register('/market/list', async (_req, res) => {
    try {
      const { registry, source } = await loadRegistry()
      sendJson(res, 200, { ok: true, source, registry })
    } catch (error) {
      sendJson(res, 500, { ok: false, detail: String(error) })
    }
  })

  // --- POST /market/install: resolve target from the curated registry, then install. ---
  register('/market/install', async (req, res) => {
    if (!requireSameOrigin(req, res)) return
    let body: { url?: unknown }
    try {
      body = await readJsonBody(req) as { url?: unknown }
    } catch {
      sendJson(res, 400, { ok: false, detail: 'invalid JSON body' })
      return
    }
    if (typeof body.url !== 'string' || body.url.trim() === '') {
      sendJson(res, 400, { ok: false, detail: 'install requires a registry url' })
      return
    }
    const url = body.url
    // Resolve the install target server-side from the curated registry: the
    // client sends a registry entry's `url`, never an arbitrary target.
    const { registry } = await loadRegistry()
    const entry = registry.plugins.find(plugin => plugin.url.toLowerCase() === url.toLowerCase())
    if (entry === undefined) {
      sendJson(res, 400, { ok: false, detail: 'plugin is not in the curated registry' })
      return
    }
    const target = entry.install
    const result = await commands.runPlugin(config.profile, ['add', target])
    if (result.exitCode === 0) {
      sendJson(res, 200, { ok: true, profile: config.profile, target, name: entry.name })
    } else {
      const detail = result.stderr.trim() || result.stdout.trim() || `command exited with code ${result.exitCode}`
      sendJson(res, 500, { ok: false, profile: config.profile, target, detail, exitCode: result.exitCode })
    }
  })

  // --- POST /market/remove: uninstall by package name. ---
  register('/market/remove', async (req, res) => {
    if (!requireSameOrigin(req, res)) return
    let body: { name?: unknown }
    try {
      body = await readJsonBody(req) as { name?: unknown }
    } catch {
      sendJson(res, 400, { ok: false, detail: 'invalid JSON body' })
      return
    }
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      sendJson(res, 400, { ok: false, detail: 'remove requires a package name' })
      return
    }
    const result = await commands.runPlugin(config.profile, ['remove', body.name])
    if (result.exitCode === 0) {
      sendJson(res, 200, { ok: true, profile: config.profile, name: body.name })
    } else {
      const detail = result.stderr.trim() || result.stdout.trim() || `command exited with code ${result.exitCode}`
      sendJson(res, 500, { ok: false, detail, exitCode: result.exitCode })
    }
  })

  // --- POST /market/set-enabled: toggle a plugin's enabled state. ---
  // Recorded to profile state only; it takes effect on the next boot (the
  // market does not hot-unmount). The body is `{ name, enabled }` where `name`
  // is the installed package name reported by /market/status.
  register('/market/set-enabled', async (req, res) => {
    if (!requireSameOrigin(req, res)) return
    let body: { name?: unknown; enabled?: unknown }
    try {
      body = await readJsonBody(req) as { name?: unknown; enabled?: unknown }
    } catch {
      sendJson(res, 400, { ok: false, detail: 'invalid JSON body' })
      return
    }
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      sendJson(res, 400, { ok: false, detail: 'set-enabled requires a package name' })
      return
    }
    if (typeof body.enabled !== 'boolean') {
      sendJson(res, 400, { ok: false, detail: 'set-enabled requires an enabled flag' })
      return
    }
    try {
      const disabled = setDisabled(config.profileDirectory ?? profileDir(config.profile), body.name, !body.enabled)
      sendJson(res, 200, { ok: true, profile: config.profile, name: body.name, enabled: !disabled.has(body.name) })
    } catch (error) {
      sendJson(res, 500, { ok: false, detail: String(error) })
    }
  })

  // --- GET /market/status: installed plugins with activation states. ---
  register('/market/status', (_req, res) => {
    try {
      const installed = readInstalled(config.profile, config.profileDirectory)
      const disabled = readDisabled(config.profileDirectory ?? profileDir(config.profile))
      // `dsh.profile.bundles` is append-ordered by install time, so its index
      // doubles as an install-time key for stable, newest-first sorting.
      const bundles = readProfileBundles(config.profileDirectory ?? profileDir(config.profile))
      const bundleOrder = new Map(bundles.map((name, index) => [name, index]))
      const liveNames = new Set<string>()
      for (const entry of host.loader.entries()) {
        const name = entry.name ?? entry.entry?.options?.name
        if (name !== undefined) liveNames.add(name)
      }
      const plugins = Object.keys(installed).map(name => {
        const result = verifyActivation(config.profile, name, liveNames, config.profileDirectory)
        return {
          packageName: name,
          spec: installed[name],
          state: result.state,
          reasons: result.reasons,
          bundle: result.bundle,
          hot: result.hot,
          enabled: !disabled.has(name),
          order: bundleOrder.get(name) ?? Number.MAX_SAFE_INTEGER,
        }
      })
      sendJson(res, 200, { ok: true, profile: config.profile, plugins })
    } catch (error) {
      sendJson(res, 500, { ok: false, detail: String(error) })
    }
  })

  // --- POST /market/cancel: cancel the running install. ---
  register('/market/cancel', (req, res) => {
    if (!requireSameOrigin(req, res)) return
    const cancelled = commands.cancelActive()
    sendJson(res, 200, { ok: true, cancelled })
  })

  return () => {
    for (const dispose of disposers) dispose()
  }
}
