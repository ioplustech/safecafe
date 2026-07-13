import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { createFixedWindowRateLimiter } from "./index.js"

describe("createFixedWindowRateLimiter", () => {
  test("allows the configured number of requests and rejects the next request", () => {
    let now = 1_000
    const limiter = createFixedWindowRateLimiter({ maxEntries: 100, now: () => now, windowMs: 100 })

    assert.deepEqual(limiter.consume({ bucket: "agent", key: "client-a", limit: 2 }), {
      allowed: true,
      limit: 2,
      remaining: 1,
      resetAt: 1_100,
      retryAfterMs: 0,
    })
    assert.equal(limiter.consume({ bucket: "agent", key: "client-a", limit: 2 }).remaining, 0)
    assert.deepEqual(limiter.consume({ bucket: "agent", key: "client-a", limit: 2 }), {
      allowed: false,
      limit: 2,
      remaining: 0,
      resetAt: 1_100,
      retryAfterMs: 100,
    })

    now = 1_099
    assert.equal(limiter.consume({ bucket: "agent", key: "client-a", limit: 2 }).retryAfterMs, 1)
  })

  test("starts a new fixed window after expiration without extending rejected windows", () => {
    let now = 5_000
    const limiter = createFixedWindowRateLimiter({ maxEntries: 100, now: () => now, windowMs: 60_000 })

    limiter.consume({ bucket: "rpc", key: "client-a", limit: 1 })
    now = 64_999
    const rejected = limiter.consume({ bucket: "rpc", key: "client-a", limit: 1 })
    assert.equal(rejected.allowed, false)
    assert.equal(rejected.resetAt, 65_000)

    now = 65_000
    assert.deepEqual(limiter.consume({ bucket: "rpc", key: "client-a", limit: 1 }), {
      allowed: true,
      limit: 1,
      remaining: 0,
      resetAt: 125_000,
      retryAfterMs: 0,
    })
  })

  test("uses a monotonic effective clock when the supplied clock moves backwards", () => {
    let now = 1_000
    const limiter = createFixedWindowRateLimiter({ maxEntries: 100, now: () => now, windowMs: 100 })
    limiter.consume({ bucket: "read", key: "client-a", limit: 1 })

    now = 900
    const result = limiter.consume({ bucket: "read", key: "client-b", limit: 1 })

    assert.equal(result.resetAt, 1_100)
  })

  test("isolates buckets and client keys", () => {
    const limiter = createFixedWindowRateLimiter({ maxEntries: 100, now: () => 0, windowMs: 60_000 })

    assert.equal(limiter.consume({ bucket: "agent", key: "client-a", limit: 1 }).allowed, true)
    assert.equal(limiter.consume({ bucket: "agent", key: "client-a", limit: 1 }).allowed, false)
    assert.equal(limiter.consume({ bucket: "rpc", key: "client-a", limit: 1 }).allowed, true)
    assert.equal(limiter.consume({ bucket: "agent", key: "client-b", limit: 1 }).allowed, true)
  })

  test("does not consume capacity when the runtime limit is disabled", () => {
    const limiter = createFixedWindowRateLimiter({ maxEntries: 1, now: () => 0, windowMs: 60_000 })

    assert.equal(limiter.consume({ bucket: "agent", key: "disabled", limit: 0 }).allowed, true)
    assert.equal(limiter.consume({ bucket: "agent", key: "disabled", limit: -1 }).allowed, true)
    assert.equal(limiter.consume({ bucket: "agent", key: "enabled", limit: 1 }).allowed, true)
    assert.equal(limiter.consume({ bucket: "agent", key: "enabled", limit: 1 }).allowed, false)
  })

  test("applies a changed limit immediately without extending the window", () => {
    const limiter = createFixedWindowRateLimiter({ maxEntries: 100, now: () => 10, windowMs: 100 })

    limiter.consume({ bucket: "agent", key: "client-a", limit: 3 })
    limiter.consume({ bucket: "agent", key: "client-a", limit: 3 })
    const rejected = limiter.consume({ bucket: "agent", key: "client-a", limit: 1 })

    assert.equal(rejected.allowed, false)
    assert.equal(rejected.limit, 1)
    assert.equal(rejected.resetAt, 110)
  })

  test("evicts the oldest live entry when maxEntries is reached", () => {
    const limiter = createFixedWindowRateLimiter({ maxEntries: 2, now: () => 0, windowMs: 60_000 })

    limiter.consume({ bucket: "read", key: "a", limit: 1 })
    limiter.consume({ bucket: "read", key: "b", limit: 1 })
    limiter.consume({ bucket: "read", key: "c", limit: 1 })

    assert.equal(limiter.consume({ bucket: "read", key: "a", limit: 1 }).allowed, true)
    assert.equal(limiter.consume({ bucket: "read", key: "c", limit: 1 }).allowed, false)
  })

  test("removes expired entries before evicting a live entry", () => {
    let now = 0
    const limiter = createFixedWindowRateLimiter({ maxEntries: 2, now: () => now, windowMs: 100 })

    limiter.consume({ bucket: "read", key: "expired", limit: 1 })
    now = 50
    limiter.consume({ bucket: "read", key: "live", limit: 1 })
    now = 100
    limiter.consume({ bucket: "read", key: "new", limit: 1 })

    assert.equal(limiter.consume({ bucket: "read", key: "live", limit: 1 }).allowed, false)
  })

  test("normalizes empty and long identifiers without collapsing distinct suffixes", () => {
    const limiter = createFixedWindowRateLimiter({ maxEntries: 100, now: () => 0, windowMs: 60_000 })
    const prefix = "x".repeat(300)

    assert.equal(limiter.consume({ bucket: "", key: "", limit: 1 }).allowed, true)
    assert.equal(limiter.consume({ bucket: "   ", key: "   ", limit: 1 }).allowed, false)
    assert.equal(limiter.consume({ bucket: "read", key: `${prefix}a`, limit: 1 }).allowed, true)
    assert.equal(limiter.consume({ bucket: "read", key: `${prefix}b`, limit: 1 }).allowed, true)
  })

  test("rejects invalid constructor options and runtime limits", () => {
    assert.throws(() => createFixedWindowRateLimiter({ maxEntries: 0, windowMs: 1 }), /maxEntries/)
    assert.throws(() => createFixedWindowRateLimiter({ maxEntries: 1, windowMs: 0 }), /windowMs/)

    const limiter = createFixedWindowRateLimiter({ maxEntries: 1, windowMs: 1 })
    assert.throws(() => limiter.consume({ bucket: "read", key: "client", limit: Number.NaN }), /limit/)
    assert.throws(() => limiter.consume({ bucket: "read", key: "client", limit: 1.5 }), /limit/)
  })
})
