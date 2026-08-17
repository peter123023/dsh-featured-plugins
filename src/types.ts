/**
 * Shared types for the DSH plugin market: the registry catalog shape and the
 * install/verify/update domain types. The catalog fields mirror the upstream
 * curated-registry convention (awesome-dsh-plugin style) so a market can also
 * consume a third-party registry by dropping in a compatible `plugins.json`.
 * @module dsh-featured-plugins/types
 */

/** One plugin's localizable text: `en` plus optional `zh`. */
export interface LocalizedText {
  en: string
  zh?: string
}

/** A category id → localizable name map (`categories[key]`). */
export type CategoryMap = Record<string, LocalizedText>

/**
 * One curated registry entry. `install` is the PRE-COMPUTED install target:
 * the catalog author already decided npm-name-first / GitHub-tarball-fallback,
 * so the client never parses an arbitrary target — it only matches against
 * this value. `npm` is informational (updates and identity matching).
 */
export interface RegistryPlugin {
  /** Plugin name (display). */
  name: string
  /** Owner / author handle. */
  owner: string
  /** Repository or homepage URL. */
  url: string
  /** Category id, keyed into {@link Registry.categories}. */
  category: string
  /** Multi-language description. */
  description: LocalizedText
  /** Pre-computed install target: npm package name or `github:owner/repo[#subpath]`. */
  install: string
  /** npm package name, when the entry is published to npm. */
  npm?: string | null
  /** GitHub stars, when known. */
  stars?: number | null
  /** Date the entry was added (ISO date). */
  added: string
  /** Upstream site detail-page URL (informational, not used by the installer). */
  page?: string
  /** Upstream screenshot URLs (informational, not used by the installer). */
  screenshots?: string[]
  /** Catalog-side deprecation marker: hide the install button. */
  deprecated?: boolean
  /** Replacement plugin name when deprecated. */
  replacement?: string
}

/** The full registry catalog. */
export interface Registry {
  /** Last catalog update (ISO date). */
  updated: string
  /** Total plugin count. */
  count: number
  /** Category id → localizable name. */
  categories: CategoryMap
  /** Curated plugin entries. */
  plugins: RegistryPlugin[]
}

/** Where a {@link loadRegistry} result came from. */
export type RegistrySource = 'live' | 'cache' | 'snapshot'

/** A registry load result, carrying provenance for UI "data freshness" hints. */
export interface RegistryLoad {
  registry: Registry
  source: RegistrySource
}

/** Activation state of one installed plugin (see verify.ts for the taxonomy). */
export type ActivationState = 'live' | 'restart' | 'inert' | 'broken' | 'missing'

/** One installed plugin's update-enrichment status (used by updates.ts). */
export interface PluginStatus {
  /** The installed package name. */
  packageName: string
  /** Installed version, when resolvable. */
  version?: string
  /** Whether an update is available (semver/git detection). */
  updateAvailable?: boolean
  /** The target the update would install. */
  updateTarget?: string
}
