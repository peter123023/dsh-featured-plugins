import { describe, expect, it } from 'vitest'
import { isValidRegistry } from '../src/registry.ts'

describe('isValidRegistry', () => {
  it('accepts an object with a non-empty plugins array', () => {
    expect(isValidRegistry({ plugins: [{ name: 'x' }] })).toBe(true)
  })

  it('rejects null, non-objects, and empty/missing plugins', () => {
    expect(isValidRegistry(null)).toBe(false)
    expect(isValidRegistry(undefined)).toBe(false)
    expect(isValidRegistry('x')).toBe(false)
    expect(isValidRegistry({})).toBe(false)
    expect(isValidRegistry({ plugins: [] })).toBe(false)
    expect(isValidRegistry({ plugins: 'not-array' })).toBe(false)
  })
})
