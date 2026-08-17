/**
 * Plugin-market host entry: mounts the market's HTTP routes once the profile
 * composes the webServer and loader services. Depends only on
 * `@deepseek-ai/cordis` (peer); the command name is discovered at runtime, so
 * the same package serves a `dsh` host and a renamed `dsw` host unchanged.
 * @module dsh-featured-plugins
 */

import type { Context } from '@deepseek-ai/cordis'
import { mountMarketRoutes, type MarketConfig, type MarketHost } from './routes.ts'

export const name = 'dsh-featured-plugins'

/** Optional cordis config; profile defaults to the `--profile` arg or `web`. */
export type Config = Partial<Pick<MarketConfig, 'profile' | 'allowRestart'>>

/** Structural subset of a desktop host's public `desktopProfiles` contract. */
interface DesktopProfilesLike {
  readonly current: { readonly name: string; readonly dir: string }
}

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
      host.effect(() => mountMarketRoutes(host, resolved), 'dsh-featured-plugins: http routes')
      return
    }

    // Desktop path: the shell owns the profile location and a packaged pnpm.
    // TODO(phase-3): inject `desktopPnpm` and adapt via a desktop runtime,
    // mirroring the host's cross-environment contract. For now the market
    // simply does not mount under a desktop host without that service.
    void desktopProfiles
  })
}

export default apply

// Re-export the public library surface for process-level consumers.
export type * from './types.ts'
export { argvProfile, DEFAULT_PROFILE } from './config.ts'
export { loadRegistry, loadSnapshot, isValidRegistry, findPlugin, installTargetFor } from './registry.ts'
export { verifyActivation, verifyProfile, type ActivationResult, type ActivationState } from './verify.ts'
export { profileDir, readInstalled, readProfileBundles, readInstalledVersion, hasDshManifest, hasLoadableEntry } from './profile.ts'
export { hostArgv, runPluginCommand, installPlugin, removePlugin, cancelActive } from './spawn.ts'
