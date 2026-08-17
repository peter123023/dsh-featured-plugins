import { describe, expect, it } from 'vitest'
import { findPlugin, installTargetFor } from '../src/registry.ts'
import type { Registry } from '../src/types.ts'

const registry: Registry = {
  updated: '2026-08-16',
  count: 3,
  categories: { tool: { en: 'Tool' } },
  plugins: [
    {
      name: 'with-npm',
      owner: 'a',
      url: 'https://github.com/a/with-npm',
      category: 'tool',
      description: { en: 'has npm' },
      install: '@a/with-npm',
      npm: '@a/with-npm',
      added: '2026-08-01',
    },
    {
      name: 'git-only',
      owner: 'b',
      url: 'https://github.com/b/git-only',
      category: 'tool',
      description: { en: 'git only' },
      install: 'github:b/git-only',
      npm: null,
      added: '2026-08-02',
    },
    {
      name: 'no-target',
      owner: 'c',
      url: 'https://github.com/c/no-target',
      category: 'tool',
      description: { en: 'no target' },
      install: '',
      npm: null,
      added: '2026-08-03',
    },
  ],
}

describe('install target resolution', () => {
  it('finds a plugin by name or npm name', () => {
    expect(findPlugin(registry, 'with-npm')?.name).toBe('with-npm')
    expect(findPlugin(registry, '@a/with-npm')?.name).toBe('with-npm')
    expect(findPlugin(registry, 'missing')).toBeUndefined()
  })

  it('returns the pre-computed install target verbatim', () => {
    expect(installTargetFor(registry.plugins[0]!)).toBe('@a/with-npm')
    expect(installTargetFor(registry.plugins[1]!)).toBe('github:b/git-only')
  })

  it('falls back to npm name, then undefined when neither is set', () => {
    expect(installTargetFor(registry.plugins[2]!)).toBeUndefined()
  })
})
