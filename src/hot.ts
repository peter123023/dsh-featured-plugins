/**
 * Live (hot) enable/disable of installed plugins through the host's loader
 * entry tree. The market persists the user's choice to state.json and replays
 * it at boot; `tryHotToggle` additionally flips the running entry so the change
 * takes effect without restarting the host. Because a bundle tree is in-memory
 * (its write is a no-op), hot toggling never touches disk — persistence is the
 * state layer's job, and a failed or absent entry simply falls back to the
 * "restart to apply" path.
 *
 * The flip can race an entry whose init is still in flight: the options flip
 * but the finishing init brings the fiber up anyway, and a plain re-update
 * no-ops on the empty diff. We therefore force the update and verify the live
 * state, retrying until reality matches the requested flag.
 * @module dsh-featured-plugins/hot
 */

/** The slice of a host loader entry the market needs for live enable/disable. */
export interface LoaderEntry {
  options: { name?: string; id?: string; disabled?: boolean | null }
  fiber?: unknown
  update(options: { disabled: boolean | null }, create?: boolean, force?: boolean): Promise<void>
}

/** The loader surface a host exposes to the market. */
export interface HotLoader {
  entries(): Iterable<LoaderEntry>
}

/** How many forced retries before declaring a hot toggle failed. */
const MAX_ATTEMPTS = 3

/** Pause between verification retries (ms) so an in-flight init can settle. */
const RETRY_DELAY_MS = 200

/** Outcome of a {@link tryHotToggle} attempt. */
export type HotToggleResult = 'hot' | 'not-in-tree' | 'failed'

/**
 * Live-toggle a plugin through its loader entry, verifying the fiber ends up in
 * the requested state. Never throws.
 * @param loader - the host loader entry tree.
 * @param name - the installed package name to toggle.
 * @param enabled - true to bring the plugin up, false to bring it down.
 * @returns
 *   - `'hot'` — a matching entry was found and the live state now matches.
 *   - `'not-in-tree'` — no entry matched `name`; it cannot be hot toggled.
 *   - `'failed'` — a matching entry existed but update errored or the fiber
 *     never settled into the requested state.
 */
export async function tryHotToggle(loader: HotLoader, name: string, enabled: boolean): Promise<HotToggleResult> {
  for (const entry of loader.entries()) {
    if (entry.options.name !== name) continue
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await entry.update({ disabled: enabled ? null : true }, false, true)
      } catch {
        // Update rejected (import / dispose / apply / rollback failure): the
        // live change did not land — fall back to the restart-to-apply path.
        return 'failed'
      }
      const live = entry.fiber !== undefined
      if (live === enabled) return 'hot'
      await new Promise(resolvePromise => setTimeout(resolvePromise, RETRY_DELAY_MS))
    }
    return 'failed'
  }
  return 'not-in-tree'
}
