#!/usr/bin/env node
/**
 * One-off snapshot builder: fetch the upstream awesome-dsh-plugin catalog,
 * normalize each entry's `install` command string down to a bare target
 * (everything after the last `add` token), drop unparseable entries, then
 * select a curated subset (highest stars, spread across categories) and write
 * `data/registry-snapshot.json` as the bundled offline fallback.
 *
 * Usage: node scripts/build-snapshot.mjs [limit]
 *   limit defaults to 50.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UPSTREAM_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const OUTPUT = join(__dirname, '..', 'data', 'registry-snapshot.json')
const LIMIT = Number(process.argv[2] ?? 50)

/** Extract the bare install target from an upstream full command string. */
function normalizeInstall(install) {
  if (install === undefined || install === null) return null
  const trimmed = String(install).trim()
  if (trimmed.length === 0) return null
  const match = /^[\w.-]+\s+plugin\s+.*?\s+add\s+(.+)$/.exec(trimmed)
  if (match === null || match[1] === undefined) return null
  // Strip surrounding quotes (direct tarball URL targets are quoted upstream).
  const target = match[1].trim().replace(/^["']|["']$/g, '').trim()
  return target.length > 0 ? target : null
}

async function main() {
  const response = await fetch(UPSTREAM_URL, { signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error(`fetch ${UPSTREAM_URL} returned ${response.status}`)
  const upstream = await response.json()

  // Normalize every entry, dropping those with an unparseable install target.
  const plugins = []
  let dropped = 0
  for (const entry of upstream.plugins ?? []) {
    const target = normalizeInstall(entry.install)
    if (target === null) {
      dropped++
      continue
    }
    plugins.push({
      ...entry,
      install: target,
    })
  }

  // Select: sort by stars desc (null/undefined as 0), then spread across
  // categories by taking the top-N overall while ensuring coverage.
  const sorted = [...plugins].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0))

  // Spread selection: round-robin across categories to keep coverage, then
  // fill the remainder with the global highest-star entries.
  const byCategory = new Map()
  for (const p of sorted) {
    const key = p.category ?? 'other'
    if (!byCategory.has(key)) byCategory.set(key, [])
    byCategory.get(key).push(p)
  }
  const categoryIds = [...byCategory.keys()]
  const selected = []
  const used = new Set()
  let round = 0
  while (selected.length < LIMIT && selected.length < sorted.length) {
    let addedThisRound = false
    for (const cat of categoryIds) {
      const list = byCategory.get(cat)
      if (round < list.length) {
        const p = list[round]
        const id = `${p.name}\u0000${p.url}`
        if (!used.has(id)) {
          used.add(id)
          selected.push(p)
          addedThisRound = true
          if (selected.length >= LIMIT) break
        }
      }
    }
    if (!addedThisRound) break
    round++
  }
  // Top up with global highest-star not yet selected.
  if (selected.length < LIMIT) {
    for (const p of sorted) {
      const id = `${p.name}\u0000${p.url}`
      if (!used.has(id)) {
        used.add(id)
        selected.push(p)
        if (selected.length >= LIMIT) break
      }
    }
  }

  const snapshot = {
    updated: upstream.updated ?? new Date().toISOString().slice(0, 10),
    count: selected.length,
    categories: upstream.categories ?? {},
    plugins: selected,
  }

  writeFileSync(OUTPUT, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
  console.log(
    `wrote ${OUTPUT}\n  total upstream: ${upstream.plugins?.length ?? 0}, dropped (bad install): ${dropped}, selected: ${selected.length}`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
