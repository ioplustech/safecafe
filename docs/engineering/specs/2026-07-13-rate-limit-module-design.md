# Safecafe In-Memory Rate Limit Module Design

## Status

Approved design for implementation. This specification covers an internal workspace module and its Safecafe server adapter. It does not introduce distributed storage, browser fingerprinting, Cloudflare KV, or Durable Objects.

## Goal

Replace the current module-global IP counter with a bounded, testable, reusable fixed-window rate limiter while preserving existing route behavior and environment-variable controls.

The implementation must remain lightweight enough for Cloudflare Pages Functions and local development. It is a first abuse-control layer, not a globally consistent quota system.

## Scope

This work includes:

- A private workspace package named `@safecafe/rate-limit` under `packages/rate-limit`.
- A fixed-window in-memory limiter with bounded storage and amortized constant-time cleanup.
- Injectable time for deterministic tests.
- A Safecafe server adapter for Request IP resolution, environment configuration, logging, and HTTP 429 responses.
- Migration of all existing API routes without changing their public error codes or configured limits.
- Dedicated tests for the core package and server adapter.
- Documentation for trusted proxy behavior and memory-level limitations.

This work excludes:

- Browser, Canvas, WebGL, font, or device fingerprinting.
- Cross-isolate or globally consistent counters.
- Cloudflare KV, Durable Objects, D1, or third-party stores.
- Cloudflare dashboard Rate Limiting Rules.
- Changing the Agent signer-address daily quota.
- A sliding-window or token-bucket algorithm.

## Architecture

The implementation uses two modules separated by a narrow seam.

### Core Module

`packages/rate-limit` owns the algorithm and in-memory state. It must not import Cloudflare, Node HTTP, Safecafe server modules, or environment-variable helpers.

Proposed layout:

```text
packages/rate-limit/
├── package.json
├── tsconfig.json
└── src/
    ├── fixedWindow.ts
    ├── types.ts
    └── index.ts
```

The package is private and consumed through `workspace:*`.

### Safecafe Server Adapter

`src/server/ipRateLimit.ts` remains the compatibility interface for current server handlers. It owns:

- The shared limiter instance used by Safecafe API routes.
- Route and global environment-variable resolution.
- Trusted client-key extraction from Request headers.
- Conversion from the core result to existing 429 response shapes and headers.
- Safecafe diagnostics logging.

Existing handlers continue calling `consumeIpRateLimit(request, env, context, options)`. They do not import the workspace package directly.

## Core Interface

The public interface is intentionally small:

```ts
export type FixedWindowRateLimiterOptions = {
  windowMs: number
  maxEntries: number
  now?: () => number
}

export type RateLimitConsumeInput = {
  bucket: string
  key: string
  limit: number
}

export type RateLimitResult = {
  allowed: boolean
  limit: number
  remaining: number
  resetAt: number
  retryAfterMs: number
}

export type FixedWindowRateLimiter = {
  consume(input: RateLimitConsumeInput): RateLimitResult
}

export function createFixedWindowRateLimiter(
  options: FixedWindowRateLimiterOptions,
): FixedWindowRateLimiter
```

Callers create an instance and consume a named bucket and client key. Tests use a fresh instance instead of resetting module-global state.

No public `clear`, `peek`, storage adapter, or statistics interface is required. Test-only implementation details must not expand the production interface.

## Fixed-Window Semantics

- The first request creates a window ending at `now + windowMs`.
- Requests up to and including `limit` are allowed.
- Later requests in the same window are rejected.
- A rejected request does not extend the window.
- Once the window expires, the next request creates a new window.
- The effective clock never moves backwards, preserving expiration order if the system clock is adjusted.
- `limit <= 0` disables limiting for that call and returns an allowed result.
- Bucket and key form one logical identity; different buckets never share counts.
- A limit change takes effect immediately against the existing count without extending the window.

`remaining` is clamped to zero. `retryAfterMs` is zero for allowed requests and at least one millisecond for rejected requests.

## Bounded Memory and Cleanup

The core implementation uses one insertion-ordered Map keyed by a normalized composite of bucket and key. The Map provides constant-time lookup and also acts as the expiration order because fixed windows never extend their reset time. Recreated windows are deleted and inserted again at the end. A hard `maxEntries` capacity bounds the complete data structure.

Cleanup occurs before inserting a new bucket:

1. Read the oldest Map entry.
2. Remove entries from the front while they are expired.
3. Stop as soon as the oldest remaining entry is still active, because every later entry expires at the same time or later.
4. If capacity is still exhausted, evict the oldest live entry before insertion.

Each entry is inserted and removed once per window, providing amortized O(1) cleanup without a second unbounded queue or a complete Map scan.

The core package normalizes bucket and key lengths before composing the storage key. Empty values receive stable fallback values. This prevents a caller from using very large strings as persistent Map keys.

Configuration validation fails fast when `windowMs` or `maxEntries` is not a positive safe integer. Runtime limits are clamped to a documented safe maximum by the Safecafe adapter.

## Trusted Client-Key Resolution

The server adapter resolves the client key in this order:

1. A non-empty `cf-connecting-ip` header.
2. When `SAFECAFE_TRUST_PROXY_HEADERS=true`, the first non-empty `x-forwarded-for` value.
3. When trusted proxy headers are enabled, a non-empty `x-real-ip` value.
4. The stable fallback key `local`.

Forwarded headers are not trusted by default. This prevents clients from bypassing limits by supplying arbitrary `x-forwarded-for` values when the project is directly exposed or self-hosted without a trusted proxy.

The adapter trims and bounds resolved values. It does not attempt browser fingerprinting or persist raw IP addresses outside the in-memory limiter.

## Environment Configuration

Existing variables remain supported:

- `SAFECAFE_API_IP_RATE_LIMIT_PER_MINUTE`
- `SAFECAFE_AGENT_IP_RATE_LIMIT_PER_MINUTE`
- `SAFECAFE_AGENT_FEEDBACK_IP_RATE_LIMIT_PER_MINUTE`
- `SAFECAFE_AUTH_IP_RATE_LIMIT_PER_MINUTE`
- `SAFECAFE_READ_API_IP_RATE_LIMIT_PER_MINUTE`
- `SAFECAFE_RPC_IP_RATE_LIMIT_PER_MINUTE`
- `SAFECAFE_SAFE_TX_IP_RATE_LIMIT_PER_MINUTE`

One variable is added:

- `SAFECAFE_TRUST_PROXY_HEADERS`: default `false`; only the exact value `true` enables `x-forwarded-for` and `x-real-ip`.

Limit resolution order is:

1. Non-empty, valid route-specific value.
2. Non-empty, valid global value.
3. Route default supplied by the handler.

An empty or invalid route-specific value must not suppress a valid global value. Values are bounded between zero and 100,000. Zero disables that limit.

The SAFE price route default is corrected from 120 to the documented read-API default of 60 requests per minute.

## HTTP Compatibility

Existing route-specific response bodies and error codes remain unchanged. Rejected requests continue returning HTTP 429 with:

- `Retry-After`
- `X-Safecafe-IP-Rate-Limit`
- `X-Safecafe-IP-Rate-Remaining`
- `X-Safecafe-IP-Rate-Reset`

The adapter may expose the core result internally for tests, but existing handlers continue receiving `null` for allowed requests and an `IpRateLimitHit` for rejected requests.

Successful requests do not need additional rate-limit headers in this iteration because adding them across all route response builders would broaden the migration surface.

## Testing Strategy

### Core Package Tests

Tests must prove:

- Requests one through N are allowed and request N+1 is rejected.
- Remaining count and retry timing are correct.
- A window resets using an injected clock without real waiting.
- Rejected requests do not extend the window.
- Buckets and keys are isolated.
- A non-positive limit disables limiting.
- A changed limit applies immediately.
- Expired entries are removed before capacity eviction.
- Capacity never exceeds `maxEntries` under many unique keys.
- Oldest live entries are evicted when capacity is exhausted.
- Long and empty bucket/key values are normalized consistently.
- Invalid constructor options fail fast.

### Safecafe Adapter Tests

Tests must prove:

- `cf-connecting-ip` has priority.
- Forwarded headers are ignored by default.
- Forwarded headers are used only when explicitly trusted.
- Route, global, and default limits follow the documented precedence.
- Empty and invalid route values fall through correctly.
- Zero disables a configured limit.
- A rejected request produces the expected 429 body and headers.
- Different route buckets do not share counts.
- Existing Agent, auth, read, RPC, and Safe transaction handlers still enforce their configured limits.
- SAFE price uses the 60-request default when no environment values are present.

Tests are written before production implementation and must demonstrate the expected failure before each behavior is added.

## Migration

1. Add the private workspace package and its failing tests.
2. Implement the fixed-window limiter until core tests pass.
3. Add adapter tests for configuration and trusted IP behavior.
4. Replace the current global Map implementation behind the existing server interface.
5. Add the trusted-proxy environment variable to server types, local Vite forwarding, release secret synchronization, `.env.example`, README, and Cloudflare documentation.
6. Correct the SAFE price route default.
7. Run targeted limiter tests, server core tests, type checking, locale checks, release tests, and the existing browser E2E smoke suite.

## Operational Characteristics

- Time complexity is O(1) average for lookup and amortized O(1) for cleanup.
- Memory is bounded by `maxEntries`.
- Counters remain local to one process or Cloudflare isolate.
- Isolate restarts reset counters.
- This module is not a replacement for Cloudflare edge rate limiting when strict global quotas or cost guarantees are required.
- Authenticated signer quotas remain a separate protection layer and should not be merged into the IP limiter.

## Acceptance Criteria

- No API route uses an unbounded module-global IP Map.
- No request performs a complete scan of all active rate-limit buckets.
- Core state is instance-local and deterministic under an injected clock.
- Memory capacity is explicitly bounded.
- Forwarded proxy headers are opt-in.
- Existing route-specific limits and public error codes remain compatible.
- SAFE price defaults to 60 requests per minute.
- The new package builds through the workspace and all specified tests pass.
- Documentation clearly states that counters are per isolate and memory-only.
