/**
 * The market's own "About" metadata: name, version, description, author,
 * repository, license — read from the installed package's manifest so the
 * Help → About pane always reports what is actually running (a source checkout
 * and a published npm build show their own versions).
 * @module dsh-featured-plugins/about
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The metadata the Help → About pane renders. */
export interface AboutInfo {
  /** Package name (e.g. `dsh-featured-plugins`). */
  name: string
  /** Installed semantic version. */
  version: string
  /** `owner/repo` from the repository URL, when present. */
  repo?: string
  /** SPDX license identifier. */
  license?: string
}

/** A loose package-manifest shape we read the fields we care about from. */
interface PackageManifest {
  name?: unknown
  version?: unknown
  license?: unknown
  repository?: { url?: unknown } | { type?: unknown; url?: unknown } | string
}

/** Read the package.json sitting beside this source module (or its lib/ build). */
function readManifest(): PackageManifest {
  // In a source checkout this module is src/about.ts → one level up is the
  // package root; in a built install it is lib/about.js → also one level up.
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
    } catch {
      // A corrupt manifest is not worth failing the whole About pane over.
      continue
    }
  }
  return {}
}

/** Extract `owner/repo` from a repository string, object url, or object {type,url}. */
function repoText(repository: unknown): string | undefined {
  const raw = typeof repository === 'string'
    ? repository
    : typeof repository === 'object' && repository !== null && typeof (repository as { url?: unknown }).url === 'string'
      ? (repository as { url?: string }).url!
      : undefined
  if (raw === undefined) return undefined
  // Accept `git+https://github.com/owner/repo.git`, `https://github.com/owner/repo`, etc.
  const match = /(?:github\.com|gitlab\.com|bitbucket\.org)\/([^/]+)\/([^/.#]+)/.exec(raw)
  if (match !== null) return `${match[1]}/${match[2]}`
  return raw
}

/**
 * Resolve the market's About metadata from the installed package manifest.
 * @returns the package metadata the Help → About pane renders.
 */
export function aboutInfo(): AboutInfo {
  const manifest = readManifest()
  const repo = repoText(manifest.repository)
  const license = typeof manifest.license === 'string' ? manifest.license : undefined
  const info: AboutInfo = {
    name: typeof manifest.name === 'string' ? manifest.name : 'dsh-featured-plugins',
    version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
  }
  if (repo !== undefined) info.repo = repo
  if (license !== undefined) info.license = license
  return info
}
