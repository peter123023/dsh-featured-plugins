/**
 * Plugin-market host entry: mounts the market's HTTP routes once the profile
 * composes the webServer and loader services. Depends only on
 * `@deepseek-ai/cordis` (peer); the command name is discovered at runtime, so
 * the same package serves a `dsh` host and a renamed `dsw` host unchanged.
 * @module dsh-featured-plugins
 */

import type { Context } from '@deepseek-ai/cordis'
import { mountMarketRoutes, type MarketConfig, type MarketHost } from './routes.ts'
import {
  desktopRuntimeFor,
  type DesktopPnpmLike,
  type DesktopProfilesLike,
} from './desktop.ts'

export const name = 'dsh-featured-plugins'

/** Optional cordis config; profile defaults to the `--profile` arg or `web`. */
export type Config = Partial<Pick<MarketConfig, 'profile' | 'allowRestart' | 'exclusiveCategories'>>

interface MarketEffectHost extends MarketHost {
  effect(callback: () => (() => void | Promise<void>), label: string): void
}

/**
 * The profile this host process actually booted (`--profile <name>` on the
 * host CLI invocation). Without it the market would default to `web` and
 * installs from a secondary profile would mutate the real one.
 */
function argvProfile(): string | undefined {
  const argv = process.argv
  const flag = argv.indexOf('--profile')
  const value = flag !== -1 ? argv[flag + 1] : undefined
  if (value !== undefined && !value.startsWith('-')) return value
  return undefined
}

/**
 * Register the market against the host context.
 * @param ctx - Host context that may acquire webServer and loader services.
 * @param config - Optional profile override from the loader.
 */
export function apply(ctx: Context, config?: Config): void {
  ctx.inject(['webServer', 'loader'], (hostCtx: Context) => {
    const host = hostCtx as unknown as MarketEffectHost
    const desktopProfiles = ctx.get('desktopProfiles') as DesktopProfilesLike | undefined

    // Ordinary DSH (CLI-hosted) path: derive the profile from argv.
    if (desktopProfiles === undefined) {
      const resolved: MarketConfig = {
        profile: config?.profile ?? argvProfile() ?? 'web',
        allowRestart: config?.allowRestart ?? true,
      }
      if (config?.exclusiveCategories !== undefined) resolved.exclusiveCategories = config.exclusiveCategories
      host.effect(() => mountMarketRoutes(host, resolved), 'dsh-featured-plugins: http routes')
      return
    }

    // Desktop path: the shell owns the profile directory and a packaged
    // pnpm, so installs must route through Desktop's package manager rather
    // than a CLI spawn. The shell also owns relaunch, so restart is disabled.
    const desktopProfilesNonNull = desktopProfiles
    hostCtx.inject(['desktopPnpm'], (desktopCtx: Context) => {
      const current = desktopProfilesNonNull.current
      const pnpm = (desktopCtx as unknown as { desktopPnpm: DesktopPnpmLike }).desktopPnpm
      const runtime = desktopRuntimeFor(pnpm, current.dir)
      const resolved: MarketConfig = {
        profile: current.name,
        profileDirectory: current.dir,
        allowRestart: false,
      }
      if (config?.exclusiveCategories !== undefined) resolved.exclusiveCategories = config.exclusiveCategories
      const desktopHost = desktopCtx as unknown as MarketEffectHost
      desktopHost.effect(() => {
        const disposeRoutes = mountMarketRoutes(desktopHost, resolved, runtime)
        return async () => {
          disposeRoutes()
          await runtime.dispose()
        }
      }, 'dsh-featured-plugins: desktop http routes')
    })
  })
}

export default apply

// Re-export the public library surface for process-level consumers.
export type * from './types.ts'
export { argvProfile, DEFAULT_PROFILE, DEFAULT_EXCLUSIVE_CATEGORIES } from './config.ts'
export { tryHotToggle, type HotToggleResult } from './hot.ts'
export { activateExclusive } from './state.ts'
export { aboutInfo, type AboutInfo } from './about.ts'
export { appendLog, readLogs, type MarketLogEntry, type MarketLogLevel, type MarketLogOp } from './logs.ts'
export { loadRegistry, loadSnapshot, isValidRegistry, findPlugin, installTargetFor } from './registry.ts'
export { verifyActivation, verifyProfile, type ActivationResult, type ActivationState } from './verify.ts'
export { profileDir, readInstalled, readProfileBundles, readInstalledVersion, hasDshManifest, hasLoadableEntry } from './profile.ts'
export { hostArgv, runPluginCommand, installPlugin, removePlugin, cancelActive } from './spawn.ts'
