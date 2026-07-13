import type {
  FixedWindowRateLimiter,
  FixedWindowRateLimiterOptions,
  RateLimitConsumeInput,
  RateLimitResult,
} from "./types.js"

type FixedWindowEntry = {
  count: number
  resetAt: number
}

const maxIdentifierLength = 160

export function createFixedWindowRateLimiter(options: FixedWindowRateLimiterOptions): FixedWindowRateLimiter {
  assertPositiveSafeInteger(options.windowMs, "windowMs")
  assertPositiveSafeInteger(options.maxEntries, "maxEntries")

  const now = options.now ?? Date.now
  const entries = new Map<string, FixedWindowEntry>()
  let lastObservedTime = Number.MIN_SAFE_INTEGER

  return {
    consume(input: RateLimitConsumeInput): RateLimitResult {
      assertSafeInteger(input.limit, "limit")
      const observedTime = now()
      assertSafeInteger(observedTime, "now")
      const currentTime = Math.max(lastObservedTime, observedTime)
      lastObservedTime = currentTime

      if (input.limit <= 0) {
        return {
          allowed: true,
          limit: 0,
          remaining: 0,
          resetAt: currentTime,
          retryAfterMs: 0,
        }
      }

      removeExpiredEntries(entries, currentTime)
      const storageKey = createStorageKey(input.bucket, input.key)
      let entry = entries.get(storageKey)

      if (!entry || entry.resetAt <= currentTime) {
        if (entry) entries.delete(storageKey)
        evictToCapacity(entries, options.maxEntries)
        entry = { count: 0, resetAt: currentTime + options.windowMs }
        entries.set(storageKey, entry)
      }

      entry.count += 1
      const allowed = entry.count <= input.limit
      return {
        allowed,
        limit: input.limit,
        remaining: Math.max(0, input.limit - entry.count),
        resetAt: entry.resetAt,
        retryAfterMs: allowed ? 0 : Math.max(1, entry.resetAt - currentTime),
      }
    },
  }
}

function removeExpiredEntries(entries: Map<string, FixedWindowEntry>, now: number) {
  while (entries.size > 0) {
    const oldest = entries.entries().next().value as [string, FixedWindowEntry] | undefined
    if (!oldest || oldest[1].resetAt > now) return
    entries.delete(oldest[0])
  }
}

function evictToCapacity(entries: Map<string, FixedWindowEntry>, maxEntries: number) {
  while (entries.size >= maxEntries) {
    const oldestKey = entries.keys().next().value as string | undefined
    if (oldestKey === undefined) return
    entries.delete(oldestKey)
  }
}

function createStorageKey(bucket: string, key: string) {
  return JSON.stringify([normalizeIdentifier(bucket, "default"), normalizeIdentifier(key, "anonymous")])
}

function normalizeIdentifier(value: string, fallback: string) {
  const normalized = value.trim() || fallback
  if (normalized.length <= maxIdentifierLength) return normalized
  const prefixLength = maxIdentifierLength - 9
  return `${normalized.slice(0, prefixLength)}:${hashIdentifier(normalized)}`
}

function hashIdentifier(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function assertPositiveSafeInteger(value: number, name: string) {
  assertSafeInteger(value, name)
  if (value <= 0) throw new RangeError(`${name} must be greater than zero.`)
}

function assertSafeInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer.`)
}
