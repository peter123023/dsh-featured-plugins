/**
 * Update checking with a 30-minute TTL cache. npm-published plugins compare
 * installed version vs the registry's latest with semver (upgrade-only, to
 * avoid the downgrade regression); git-hosted plugins compare the lockfile's
 * commit SHA against the remote HEAD. link/file installs are never updatable.
 * @module dsh-featured-plugins/updates
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { profileDir } from './profile.ts'
import semverGt from 'semver/functions/gt.js'
import type { PluginStatus } from './types.ts'

/** Update-check cache TTL. */
const TTL_MS = 30 * 60 * 1000

/** How long a just-published package must age before pnpm will resolve it (diagnostic window). */
export const RELEASE_WINDOW_MS = 26 * 60 * 60 * 1000

const cache = new Map<string, { at: number; version: string }>()

/**
 * Fetch the latest published version of an npm package, cached for the TTL.
 * @param packageName - the npm package name.
 * @returns the latest version, or `undefined` on network/registry failure.
 */
export async function latestNpmVersion(packageName: string): Promise<string | undefined> {
  const cached = cache.get(packageName)
  if (cached !== undefined && Date.now() - cached.at < TTL_MS) return cached.version
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
      signal: AbortSignal.timeout(4000),
    })
    if (!response.ok) return undefined
    const data = await response.json() as { version?: unknown }
    const version = typeof data.version === 'string' ? data.version : undefined
    if (version !== undefined) cache.set(packageName, { at: Date.now(), version })
    return version
  } catch {
    return undefined
  }
}

/**
 * Whether `installed` is older than `latest`, using semver (upgrade-only:
 * an equal or greater installed version is never "updatable", preventing the
 * downgrade regression).
 * @param installed - the installed version.
 * @param latest - the latest published version.
 * @returns true when an upgrade is available.
 */
export function isUpgrade(installed: string, latest: string): boolean {
  if (!semverGt(latest, installed)) return false
  return true
}

/**
 * Decide whether an installed plugin has an update, mutating the status with
 * the update target when one is found. git/link/file targets return `false`
 * here (git SHA comparison needs the lockfile, handled by the host).
 * @param status - the verified status to enrich.
 * @param npmName - the plugin's npm package name (from the registry entry).
 */
export async function checkNpmUpdate(
  status: PluginStatus, npmName: string,
): Promise<boolean> {
  if (status.version === undefined) return false
  const latest = await latestNpmVersion(npmName)
  if (latest === undefined) return false
  if (!isUpgrade(status.version, latest)) return false
  status.updateAvailable = true
  status.updateTarget = npmName
  return true
}

/**
 * Read the installed commit SHAs for git-hosted dependencies from a profile's
 * lockfile (`codeload.github.com/<owner>/<repo>/tar.gz/<sha>`).
 * @param profile - the profile name.
 * @returns owner/repo → commit SHA.
 */
export function readLockCommits(profile: string): Map<string, string> {
  const lockPath = join(profileDir(profile), 'pnpm-lock.yaml')
  let lock: string
  try {
    lock = readFileSync(lockPath, 'utf8')
  } catch {
    return new Map()
  }
  const commits = new Map<string, string>()
  for (const match of lock.matchAll(/codeload\.github\.com\/([^/\s]+\/[^/\s]+)\/tar\.gz\/([0-9a-f]{40})/g)) {
    const repo = match[1]
    const sha = match[2]
    if (repo !== undefined && sha !== undefined) commits.set(repo.toLowerCase(), sha)
  }
  return commits
}
