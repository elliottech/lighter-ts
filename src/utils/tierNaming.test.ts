import { describe, expect, it } from 'vitest'

import { getTierNamingArm } from './tierNaming'

const address = (i: number) => `0x${i.toString(16).padStart(40, '0')}`

describe('getTierNamingArm', () => {
  it('buckets an address the same way regardless of checksum casing', () => {
    const lower = '0xabcdef0123456789abcdef0123456789abcdef01'
    expect(getTierNamingArm(lower.toUpperCase().replace('0X', '0x'))).toBe(getTierNamingArm(lower))
  })

  it('splits addresses roughly in half', () => {
    const advanced = Array.from({ length: 2000 }, (_, i) => getTierNamingArm(address(i))).filter(
      (arm) => arm === 'advanced',
    ).length
    expect(advanced).toBeGreaterThan(900)
    expect(advanced).toBeLessThan(1100)
  })

  it('keeps known wallets in their assigned arm', () => {
    expect(getTierNamingArm(address(1))).toBe('premium')
    expect(getTierNamingArm(address(2))).toBe('advanced')
    expect(getTierNamingArm(address(3))).toBe('advanced')
    expect(getTierNamingArm(address(4))).toBe('premium')
  })
})
