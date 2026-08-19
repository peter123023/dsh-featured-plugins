/**
 * Configuration resolution for the plugin market. The command name is NOT a
 * config knob: it is discovered at runtime from the host's own entry point
 * (see {@link spawn.ts}), so a renamed binary (`dsh` → `dsw`) rebinds the
 * market with zero configuration.
 * @module dsh-featured-plugins/config
 */

/** Default profile the market manages when none is supplied. */
export const DEFAULT_PROFILE = 'web'

/** Default registry URL (curated upstream catalog from awesome-dsh-plugin). */
export const DEFAULT_REGISTRY_URL = 'https://awesome-dsh-plugin.com/plugins.json'

/** Default cache TTL: 30 minutes. */
export const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000

/**
 * Categories whose plugins are mutually exclusive: within one such category,
 * only a single plugin may be enabled at a time (e.g. themes). Enabling one
 * automatically disables the rest of the group. Operators can override this
 * via `MarketConfig.exclusiveCategories`.
 */
export const DEFAULT_EXCLUSIVE_CATEGORIES = ['theme']

/**
 * Read the active profile from `--profile <name>` on the current process
 * argv, falling back to {@link DEFAULT_PROFILE} when absent.
 */
export function argvProfile(argv: readonly string[] = process.argv): string {
  const index = argv.indexOf('--profile')
  if (index >= 0) {
    const value = argv[index + 1]
    if (value !== undefined && value.trim().length > 0) return value
  }
  return DEFAULT_PROFILE
}
