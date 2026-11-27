export type TierNaming = 'premium' | 'advanced'

const ADVANCED_SHARE = 0.5
const BUCKETS = 10_000
const SEED_PREFIX = 'tier_naming:'

const fnv1a = (input: string): number => {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

// Web and mobile must bucket a wallet identically, so the A/B arm is derived
// here from the L1 address alone.
export const getTierNamingArm = (l1Address: string): TierNaming =>
  fnv1a(SEED_PREFIX + l1Address.toLowerCase()) % BUCKETS < ADVANCED_SHARE * BUCKETS
    ? 'advanced'
    : 'premium'
