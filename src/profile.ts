/**
 * Profile filesystem reads — everything the market learns from a profile
 * directory (manifest, installed package trees). Pure functions of the
 * directory contents; no processes, no network. Installation itself is
 * delegated to the host command (see {@link spawn.ts}); this module only
 * reads what the host has already reconciled.
 * @module dsh-featured-plugins/profile
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve a profile name to its directory under `DSH_HOME` (default `~/.dsh`).
 * An explicit directory is used by hosts that own the active profile location
 * (e.g. a desktop shell) rather than deriving it from the process environment.
 */
export function profileDir(profile: string, explicitDir?: string): string {
  if (explicitDir !== undefined) return explicitDir
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'profiles', profile)
}

/**
 * The in-box bundles a profile template installs itself — the only names the
 * market hides from the installed list. Community plugins may legitimately
 * publish under the official scope, so a whole-scope filter would hide them.
 */
const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
])

/** Community dependencies of the profile (in-box bundles filtered out). */
export function readInstalled(profile: string, explicitDir?: string): Record<string, string> {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir(profile, explicitDir), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const installed: Record<string, string> = {}
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (!INBOX_BUNDLES.has(name)) installed[name] = spec
    }
    return installed
  } catch {
    return {}
  }
}

/** The profile manifest's `dsh.profile.bundles` — what the CLI reconciled. */
export function readProfileBundles(profileDirectory: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDirectory, 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: unknown } }
    }
    const bundles = manifest.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles.filter((name): name is string => typeof name === 'string') : []
  } catch {
    return []
  }
}

/** The version actually present in the profile's node_modules, or null. */
export function readInstalledVersion(profile: string, name: string, explicitDir?: string): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDir(profile, explicitDir), 'node_modules', name, 'package.json'), 'utf8'),
    ) as { version?: string }
    return manifest.version ?? null
  } catch {
    return null
  }
}

/** True when the installed package's manifest declares a dsh plugin surface. */
export function hasDshManifest(dir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh?: unknown }
    return manifest.dsh !== undefined
  } catch {
    return false
  }
}

/**
 * True when the package's declared entry artifact actually exists. GitHub
 * source checkouts of build-required plugins ship no `lib/`, and promoting
 * one into the bundle layer bricks the next boot.
 */
export function entryArtifactExists(dir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      main?: string
      exports?: Record<string, unknown> | string
    }
    const candidates: string[] = []
    if (typeof manifest.main === 'string') candidates.push(manifest.main)
    const rootExport = typeof manifest.exports === 'string'
      ? manifest.exports
      : (manifest.exports as Record<string, unknown> | undefined)?.['.']
    if (typeof rootExport === 'string') candidates.push(rootExport)
    else if (rootExport !== null && typeof rootExport === 'object') {
      for (const value of Object.values(rootExport)) if (typeof value === 'string') candidates.push(value)
    }
    if (candidates.length === 0) candidates.push('index.js')
    return candidates.some(rel => existsSync(join(dir, rel)))
  } catch {
    return false
  }
}

/** Package names a bundle patch mounts — the `name:` rows of its patch file. */
export function bundlePatchTargets(dir: string): string[] {
  let patchPath: string
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: unknown } }
    }
    const declared = manifest.dsh?.bundle?.patch
    if (typeof declared !== 'string' || declared === '') return []
    patchPath = join(dir, declared)
  } catch {
    return []
  }
  const names: string[] = []
  try {
    for (const line of readFileSync(patchPath, 'utf8').split('\n')) {
      const match = /^\s*-?\s*name:\s*['"]?([^'"\s]+)/.exec(line)
      const name = match?.[1]
      if (name !== undefined && !names.includes(name)) names.push(name)
    }
  } catch { /* unreadable patch — nothing to report */ }
  return names
}

/**
 * Whether the loader has anything to load for this package: its own entry
 * artifact, or — for carrier bundles — patch rows naming other packages that
 * do have one.
 */
export function hasLoadableEntry(profileDirectory: string, name: string): boolean {
  const dir = join(profileDirectory, 'node_modules', name)
  if (entryArtifactExists(dir)) return true
  return bundlePatchTargets(dir)
    .filter(target => target !== name)
    .some(target => entryArtifactExists(join(profileDirectory, 'node_modules', target))
      || entryArtifactExists(join(dir, 'node_modules', target)))
}
