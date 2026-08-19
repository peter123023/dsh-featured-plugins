/**
 * Persisted market operation logs — a history of install / remove /
 * set-enabled actions (success and failure) the Help → Logs pane renders.
 * The store is a plain append-order JSON list under the profile's state
 * directory; it is intentionally best-effort (a failing log write must never
 * crash a mutating request).
 * @module dsh-featured-plugins/logs
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** State directory name under the profile directory (shared with state.ts). */
const STATE_DIR = '.dsh-featured-plugins'

/** Log file name inside {@link STATE_DIR}. */
const LOGS_FILE = 'logs.json'

/** The operations a log entry can record. */
export type MarketLogOp = 'install' | 'remove' | 'set-enabled'

/**
 * Log level — models the event, not just the final outcome, so the pane can
 * read like a running Nginx-style log stream:
 * - `start`: an operation began (`Installing x…`).
 * - `done`: an operation finished successfully (`x installed`).
 * - `error`: an operation failed (`x install failed: …`).
 */
export type MarketLogLevel = 'start' | 'done' | 'error'

/** One persisted operation log entry. */
export interface MarketLogEntry {
  /** Monotonic id (ms timestamp), newest-first when rendered. */
  id: number
  /** ISO timestamp of the operation. */
  ts: string
  /** Event level: an action starting, succeeding, or failing. */
  level: MarketLogLevel
  /** Which action ran. */
  op: MarketLogOp
  /** The target the action acted on (install spec, package name, …). */
  target: string
  /** Human display name when known (e.g. registry entry name). */
  name?: string
  /** Whether the operation succeeded (`done` when true, `error` when false). */
  ok: boolean
  /** Child-process exit code when the operation spawned one. */
  exitCode?: number | null
  /** Human detail: error message or short success note. */
  detail?: string
  /**
   * A ready-to-display, one-line log message (e.g. `Installing x…` /
   * `x installed` / `x install failed`), so the pane can render each entry
   * as a single Nginx-style line without composing copy client-side.
   */
  message: string
}

/** Soft cap on persisted entries so the log file cannot grow unbounded. */
const MAX_ENTRIES = 200

/** Resolve the absolute logs file path for a profile directory. */
export function logsFile(profileDirectory: string): string {
  return join(profileDirectory, STATE_DIR, LOGS_FILE)
}

/**
 * Read the persisted operation log for a profile, newest-first. Missing or
 * corrupt files resolve to an empty list — logging must never crash the
 * market or a mutating route.
 */
export function readLogs(profileDirectory: string): MarketLogEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(logsFile(profileDirectory), 'utf8')) as {
      entries?: unknown
    }
    const raw = Array.isArray(parsed.entries) ? parsed.entries : []
    const entries: MarketLogEntry[] = []
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Partial<MarketLogEntry>
      if (typeof record.id !== 'number' || typeof record.ts !== 'string') continue
      const op: MarketLogOp = record.op === 'remove' || record.op === 'set-enabled' ? record.op : 'install'
      const target = typeof record.target === 'string' ? record.target : ''
      const ok = record.ok === true
      const entry: MarketLogEntry = {
        id: record.id,
        ts: record.ts,
        // Default the level from the outcome when a legacy entry lacks it.
        level: record.level === 'start' || record.level === 'done' || record.level === 'error' ? record.level : (ok ? 'done' : 'error'),
        op,
        target,
        ok,
        // Fall back to composing a line for legacy entries without a message.
        message: typeof record.message === 'string' ? record.message : defaultMessage(op, target, ok),
      }
      if (typeof record.name === 'string') entry.name = record.name
      if (typeof record.exitCode === 'number') entry.exitCode = record.exitCode
      if (typeof record.detail === 'string') entry.detail = record.detail
      entries.push(entry)
    }
    // Newest-first (descending by id).
    return entries.sort((a, b) => b.id - a.id)
  } catch {
    return []
  }
}

/**
 * Append one log entry and persist. Creates the state directory on demand,
 * keeps at most {@link MAX_ENTRIES} entries (newest retained), and swallows
 * filesystem errors so a logging failure never fails the underlying action.
 *
 * Callers pass either an explicit `message` (a ready-to-render line) or no
 * `level`/`message`, in which case a sensible line is composed from the
 * outcome.
 */
export function appendLog(profileDirectory: string, entry: Omit<MarketLogEntry, 'id' | 'ts' | 'level' | 'message'> & { level?: MarketLogLevel; message?: string }): MarketLogEntry {
  const id = Date.now()
  const level: MarketLogLevel = entry.level ?? (entry.ok === true ? 'done' : 'error')
  const message = entry.message ?? defaultMessage(entry.op, entry.target, entry.ok === true)
  const full: MarketLogEntry = {
    ...entry,
    level,
    message,
    id,
    ts: new Date(id).toISOString(),
  } as MarketLogEntry
  try {
    const prior = readLogs(profileDirectory)
    const entries = [full, ...prior].slice(0, MAX_ENTRIES)
    mkdirSync(join(profileDirectory, STATE_DIR), { recursive: true })
    writeFileSync(logsFile(profileDirectory), `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8')
  } catch {
    // Best-effort: a log write failure is non-fatal.
  }
  return full
}

/** Compose a one-line human message for an entry that lacks one. */
function defaultMessage(op: MarketLogOp, target: string, ok: boolean): string {
  const verb = op === 'install' ? 'Install' : op === 'remove' ? 'Remove' : 'Set enabled'
  if (!ok) return `${verb} failed: ${target}`
  return op === 'set-enabled' ? `${verb}: ${target}` : `${verb} ${target}`
}
