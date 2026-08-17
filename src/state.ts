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
