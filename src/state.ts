/**
 * Persisted market state — the set of installed package names the user has
 * toggled off. Disabling is recorded here (not by rewriting the profile's
 * patch layers) so the change is idempotent, survives reinstalls, and is cheap
 * to reconcile. It takes effect on the next host boot: the market does not
 * hot-unmount.
 * @module dsh-featured-plugins/state
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** State directory name under the profile directory. */
const STATE_DIR = '.dsh-featured-plugins'

/** State file name inside {@link STATE_DIR}. */
const STATE_FILE = 'state.json'

/** Shape of the persisted state document. */
interface MarketState {
  /** Installed package names the user has switched off. */
  disabled?: string[]
}

/**
 * Resolve the absolute state file path for a profile directory.
 */
export function stateFile(profileDirectory: string): string {
  return join(profileDirectory, STATE_DIR, STATE_FILE)
}

/**
 * Read the disabled package-name set for a profile. Missing/unreadable state
 * resolves to an empty set — disabling is best-effort and must never crash the
 * market.
 */
export function readDisabled(profileDirectory: string): Set<string> {
  const file = stateFile(profileDirectory)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as MarketState
    const disabled = Array.isArray(parsed.disabled) ? parsed.disabled : []
    return new Set(disabled.filter((id): id is string => typeof id === 'string'))
  } catch {
    return new Set()
  }
}

/**
 * Persist the disabled package-name set. Creates the state directory on
 * demand and writes atomically enough for this use (single process, low write
 * rate).
 */
export function writeDisabled(profileDirectory: string, disabled: Set<string>): void {
  const file = stateFile(profileDirectory)
  mkdirSync(join(profileDirectory, STATE_DIR), { recursive: true })
  const state: MarketState = { disabled: [...disabled].sort() }
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/**
 * Toggle a package name in the disabled set and persist the result.
 * @returns the new disabled set (post-toggle), for echoing back to the client.
 */
export function setDisabled(profileDirectory: string, name: string, disabled: boolean): Set<string> {
  const set = readDisabled(profileDirectory)
  if (disabled) set.add(name)
  else set.delete(name)
  writeDisabled(profileDirectory, set)
  return set
}

/**
 * Atomically make `active` the single enabled member of an exclusive group:
 * every other member of `group` is added to the disabled set, `active` is
 * removed from it, and the result is persisted. This is the persistence-layer
 * half of mutual exclusion (the live/hot-toggle half lives in {@link hot.ts});
 * on the next boot only `active` comes up.
 * @param profileDirectory - the profile's state directory root.
 * @param group - the full set of package names in the exclusive category.
 * @param active - the package name to keep enabled.
 * @returns the package names that were switched off by this activation.
 */
export function activateExclusive(profileDirectory: string, group: string[], active: string): string[] {
  const disabled = readDisabled(profileDirectory)
  const switchedOff: string[] = []
  for (const name of group) {
    if (name === active) continue
    if (!disabled.has(name)) switchedOff.push(name)
    disabled.add(name)
  }
  disabled.delete(active)
  writeDisabled(profileDirectory, disabled)
  return switchedOff
}
