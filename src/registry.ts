/**
 * Registry catalog loading with layered fallback: a 1-hour in-memory cache,
 * a remote `plugins.json` fetch with a bounded timeout, then — on any network
 * failure — the stale cache, and finally a bundled snapshot, so a market never
 * renders an empty catalog because the network hiccupped. Stability-first,
 * degrading stale cache over snapshot. The remote catalog is the curated
 * `awesome-dsh-plugin` list, whose `install` fields are full command strings
 * that get normalized down to bare install targets (see {@link normalizeUpstreamPlugin}).
 * @module dsh-featured-plugins/registry
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Registry, RegistryLoad, RegistryPlugin, RegistrySource } from './types.ts'

/** Default remote registry catalog (upstream curated list from awesome-dsh-plugin). */
export const DEFAULT_REGISTRY_URL = 'https://awesome-dsh-plugin.com/plugins.json'

/** How long a fetched catalog stays fresh before a refetch is attempted. */
const DEFAULT_TTL_MS = 60 * 60 * 1000

/** Fetch timeout for the remote catalog. */
const FETCH_TIMEOUT_MS = 4000

let cache: { at: number; data: Registry } | null = null

/** A cache entry is fresh when its age is under the TTL. */
function fresh(at: number, ttlMs: number): boolean {
  return Date.now() - at < ttlMs
}

/**
 * Validate a parsed value as a usable {@link Registry}: an object whose
 * `plugins` is a non-empty array. Anything else is treated as a bad payload.
 * @param value - the parsed JSON value.
 * @returns the registry when usable, otherwise `undefined`.
 */
export function isValidRegistry(value: unknown): value is Registry {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<Registry>
  return Array.isArray(record.plugins) && record.plugins.length > 0
}

/**
 * Load the bundled snapshot catalog, resolved beside this module.
 * @returns the snapshot registry.
 */
export function loadSnapshot(): Registry {
  const path = fileURLToPath(new URL('../data/registry-snapshot.json', import.meta.url))
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  if (!isValidRegistry(parsed)) {
    throw new Error(`dsh-featured-plugins: bundled registry snapshot at ${path} is not a usable registry`)
  }
  return parsed
}

/**
 * Load the registry with layered fallback.
 * @param registryUrl - the remote catalog URL.
 * @param ttlMs - cache TTL in milliseconds.
 * @returns the registry and its provenance source.
 */
export async function loadRegistry(
  registryUrl: string = DEFAULT_REGISTRY_URL,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<RegistryLoad> {
  if (cache !== null && fresh(cache.at, ttlMs)) {
    return { registry: cache.data, source: 'cache' }
  }
  try {
    const data = await fetchRemote(registryUrl)
    cache = { at: Date.now(), data }
    return { registry: data, source: 'live' }
  } catch {
    // Network failed: prefer the stale cache over the bundled snapshot, so an
    // offline market keeps showing the last-seen catalog rather than an older one.
    if (cache !== null) return { registry: cache.data, source: 'cache' }
    return { registry: loadSnapshot(), source: 'snapshot' }
  }
}

/**
 * Normalize one upstream entry for local consumption. The upstream catalog
 * pre-computes `install` as a FULL command string hard-coding the `dsh`
 * binary (e.g. `dsh plugin --profile web add github:owner/repo`), whereas our
 * {@link RegistryPlugin.install} is the bare target (`github:owner/repo` or an
 * npm package name). We extract the target by taking everything after the last
 * `add` token; entries whose `install` cannot be parsed this way are dropped
 * (returns `null`) so the catalog stays clean rather than feeding a malformed
 * target into the installer.
 * @param plugin - the upstream entry.
 * @returns the normalized entry, or `null` when the target is unparseable.
 */
function normalizeUpstreamPlugin(plugin: RegistryPlugin): RegistryPlugin | null {
  const install = plugin.install
  if (install === undefined || install === null) return null
  const trimmed = install.trim()
  if (trimmed.length === 0) return null
  const match = /^[\w.-]+\s+plugin\s+.*?\s+add\s+(.+)$/.exec(trimmed)
  if (match === null || match[1] === undefined) return null
  // Strip surrounding quotes: some upstream entries wrap a direct tarball URL
  // target in double quotes (e.g. `add "https://.../x.tgz"`), and pnpm accepts
  // the bare URL as a valid target.
  const target = match[1].trim().replace(/^["']|["']$/g, '').trim()
  if (target.length === 0) return null
  return { ...plugin, install: target }
}

/**
 * Normalize a parsed registry payload: strip the upstream command-string
 * `install` fields down to bare targets, dropping entries that fail to parse.
 * @param parsed - the parsed registry value.
 * @returns the registry with normalized plugins.
 */
function normalizeRegistry(parsed: Registry): Registry {
  const plugins: RegistryPlugin[] = []
  for (const plugin of parsed.plugins) {
    const normalized = normalizeUpstreamPlugin(plugin)
    if (normalized !== null) plugins.push(normalized)
  }
  return { ...parsed, count: plugins.length, plugins }
}

/** Fetch, normalize, and validate the remote catalog; throws on timeout, non-200, or bad payload. */
async function fetchRemote(url: string): Promise<Registry> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`dsh-featured-plugins: registry fetch ${url} returned ${response.status}`)
  const parsed = await response.json() as unknown
  if (!isValidRegistry(parsed)) {
    throw new Error(`dsh-featured-plugins: registry ${url} did not contain a non-empty plugins array`)
  }
  const normalized = normalizeRegistry(parsed)
  if (!isValidRegistry(normalized)) {
    throw new Error(`dsh-featured-plugins: registry ${url} had no installable plugins after normalization`)
  }
  return normalized
}

/** Expose provenance-name helper for UI freshness hints. */
export function describeSource(source: RegistrySource): string {
  switch (source) {
    case 'live': return 'live'
    case 'cache': return 'cached'
    case 'snapshot': return 'bundled snapshot'
  }
}

/**
 * Find a catalog entry by display name or npm package name. Matching is
 * case-insensitive on both keys, so `dsh-featured-plugins` and its npm spelling
 * resolve to the same entry.
 * @param registry - the catalog.
 * @param nameOrNpm - a display name or npm package name.
 */
export function findPlugin(registry: Registry, nameOrNpm: string): RegistryPlugin | undefined {
  const needle = nameOrNpm.toLocaleLowerCase()
  return registry.plugins.find(plugin =>
    plugin.name.toLocaleLowerCase() === needle
    || (plugin.npm !== undefined && plugin.npm !== null && plugin.npm.toLocaleLowerCase() === needle),
  )
}

/**
 * Resolve a catalog entry to its concrete install target. The catalog author
 * pre-computes `install`, so the caller never parses an arbitrary target: the
 * pre-computed value wins, then the npm name, then `undefined` (uninstallable).
 * @param plugin - the catalog entry.
 */
export function installTargetFor(plugin: RegistryPlugin): string | undefined {
  if (plugin.install !== undefined && plugin.install.trim().length > 0) return plugin.install
  if (plugin.npm !== undefined && plugin.npm !== null && plugin.npm.trim().length > 0) return plugin.npm
  return undefined
}

/** Extract a normalized `owner/repo` from a `github:owner/repo[#…]` target, or null. */
function gitRepoTarget(spec: string): string | null {
  const match = /^github:([^#]+?)(?:#.*)?$/i.exec(spec.trim())
  if (match === null) return null
  return match[1]!.replace(/\/+$/, '').toLowerCase()
}

/**
 * Resolve an installed package back to its catalog entry, so the market can
 * report and enforce category membership (e.g. which category an installed
 * theme belongs to). Matches by display name, npm name, and GitHub `owner/repo`
 * target — the inverse of {@link findPlugin}.
 * @param registry - the catalog.
 * @param packageName - the installed package name.
 * @param spec - the installed spec (e.g. `github:owner/repo`).
 * @returns the matching catalog entry, or `undefined`.
 */
export function registryEntryForPackage(
  registry: Registry,
  packageName: string,
  spec: string,
): RegistryPlugin | undefined {
  const target = packageName.toLowerCase()
  for (const plugin of registry.plugins) {
    if (plugin.name.toLowerCase() === target) return plugin
    if (plugin.npm != null && plugin.npm.toLowerCase() === target) return plugin
  }
  // GitHub-derived package names (e.g. `treg-dsh`) match on owner/repo.
  const gitTarget = gitRepoTarget(spec)
  if (gitTarget !== null) {
    for (const plugin of registry.plugins) {
      if (gitRepoTarget(plugin.install ?? '') === gitTarget) return plugin
    }
  }
  return undefined
}
