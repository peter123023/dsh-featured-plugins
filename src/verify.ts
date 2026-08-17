/**
 * Installed-plugin verification: map a profile's installed packages to their
 * activation states. The ground truth is the same manifest the host CLI
 * reconciles — `<profile>/package.json` → `dsh.profile.bundles` — plus the
 * package's own `dsh` surface and whether its entry artifact is on disk.
 *
 * State taxonomy:
 *   live    – mounted into the running composition
 *   restart – installed and will activate on the next boot, but not live now
 *   inert   – installed but never a profile-layer plugin (no dsh.bundle)
 *   broken  – installed but validation failed (no entry artifact)
 *   missing – not present in node_modules
 * @module dsh-featured-plugins/verify
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasDshManifest, hasLoadableEntry, profileDir, readInstalled, readProfileBundles } from './profile.ts'

/** Activation state of one installed plugin. */
export type ActivationState = 'live' | 'restart' | 'inert' | 'broken' | 'missing'

/** The verified state of one installed package. */
export interface ActivationResult {
  state: ActivationState
  /** Bilingual, user-facing explanations (zh / en joined with " / "). */
  reasons: string[]
  /** True when the package is in the profile's `dsh.profile.bundles`. */
  bundle: boolean
  /** True when the package is live in the running composition. */
  hot: boolean
}

interface PkgDsh {
  bundle?: unknown
  client?: unknown
}

/** True when `live` contains the package itself or a subpath entry of it. */
function liveIncludes(live: ReadonlySet<string>, packageName: string): boolean {
  if (live.has(packageName)) return true
  const prefix = `${packageName}/`
  for (const name of live) if (name.startsWith(prefix)) return true
  return false
}

function readPkgDsh(profileDirectory: string, name: string): PkgDsh | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDirectory, 'node_modules', name, 'package.json'), 'utf8'),
    ) as { dsh?: PkgDsh }
    return manifest.dsh ?? {}
  } catch {
    return null
  }
}

/**
 * Verify the activation state of one installed package.
 * @param profile - the profile name.
 * @param name - the installed package name.
 * @param live - names live in the current composition (injectable for tests).
 * @param explicitDir - explicit profile directory override.
 */
export function verifyActivation(
  profile: string,
  name: string,
  live: ReadonlySet<string> = new Set(),
  explicitDir?: string,
): ActivationResult {
  const activeProfileDir = profileDir(profile, explicitDir)
  const bundles = new Set(readProfileBundles(activeProfileDir))
  const inBundles = bundles.has(name)
  const dsh = readPkgDsh(activeProfileDir, name)

  if (dsh === null) {
    return { state: 'missing', reasons: ['未安装 / not installed'], bundle: inBundles, hot: false }
  }

  const dir = join(activeProfileDir, 'node_modules', name)
  if (!hasDshManifest(dir)) {
    return {
      state: 'broken',
      reasons: ['该包未声明 dsh 元数据,不会在启动时加载 / this package declares no dsh metadata and will never load'],
      bundle: inBundles,
      hot: false,
    }
  }

  if (!hasLoadableEntry(activeProfileDir, name)) {
    return {
      state: 'broken',
      reasons: [
        '声明的入口产物缺失(源码检出或构建被拦),下次启动会失败 / the declared entry artifact is missing (source-only checkout or blocked build) — the next boot would fail',
      ],
      bundle: inBundles,
      hot: false,
    }
  }

  if (liveIncludes(live, name)) {
    const clientOnly = dsh.bundle === undefined && dsh.client !== undefined
    return {
      state: 'live',
      reasons: [
        clientOnly
          ? '已热加载(纯客户端插件)/ live via the client-only shim'
          : '已热加载(bundle patch)/ live via its bundle patch',
      ],
      bundle: inBundles,
      hot: true,
    }
  }

  if (inBundles) {
    return {
      state: 'restart',
      reasons: ['已进入 profile bundle 层但本次未能热挂载;重启后生效 / in the bundle layer but not hot-mounted this session — it activates on restart'],
      bundle: true,
      hot: false,
    }
  }

  if (dsh.client !== undefined) {
    return {
      state: 'inert',
      reasons: ['未声明 dsh.bundle,不会进入 profile bundle 层(纯客户端插件) / no dsh.bundle — client-only plugins never enter the bundle layer'],
      bundle: false,
      hot: false,
    }
  }

  return {
    state: 'inert',
    reasons: ['未声明 dsh.bundle,已作为普通依赖安装,不会成为 profile 层 / no dsh.bundle — installed as a plain dependency, never a profile-layer plugin'],
    bundle: false,
    hot: false,
  }
}

/** Verify every installed community dependency of a profile, in manifest order. */
export function verifyProfile(profile: string, explicitDir?: string): ActivationResult[] {
  const installed = readInstalled(profile, explicitDir)
  return Object.keys(installed).map(name => verifyActivation(profile, name, new Set(), explicitDir))
}
