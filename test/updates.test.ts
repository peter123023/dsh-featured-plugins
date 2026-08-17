import { describe, expect, it } from 'vitest'
import { isUpgrade } from '../src/updates.ts'

describe('isUpgrade (semver upgrade-only, anti-downgrade)', () => {
  it('is an upgrade when latest is newer', () => {
    expect(isUpgrade('1.0.0', '1.1.0')).toBe(true)
    expect(isUpgrade('1.0.0', '2.0.0')).toBe(true)
  })

  it('is not an upgrade when equal or older (prevents downgrade)', () => {
    expect(isUpgrade('1.1.0', '1.1.0')).toBe(false)
    expect(isUpgrade('2.0.0', '1.9.0')).toBe(false)
  })

  it('handles prerelease ordering via semver (a higher prerelease still upgrades)', () => {
    expect(isUpgrade('1.0.0', '1.0.1-rc.1')).toBe(true)
    expect(isUpgrade('1.0.1', '1.0.1-rc.1')).toBe(false)
  })
})
