# Safecafe In-Memory Rate Limit Module Implementation Plan

**Goal:** Replace the unbounded module-global IP counter with a private, bounded, reusable fixed-window workspace package and a trusted Safecafe HTTP adapter.

**Architecture:** `@safecafe/rate-limit` owns the platform-independent fixed-window algorithm and instance-local memory. `src/server/ipRateLimit.ts` remains the narrow compatibility seam for Request headers, environment configuration, diagnostics, and existing 429 response shapes.

**Tech Stack:** TypeScript strict mode, pnpm workspaces, Node test runner through `tsx`, Cloudflare Pages Functions, Biome.

## Global Constraints

- Keep the algorithm memory-only and per process/isolate.
- Use a fixed 60-second window for current Safecafe route limits.
- Bound active entries with a hard capacity; never scan the complete Map per request.
- Trust `cf-connecting-ip` by default; forwarded proxy headers require `SAFECAFE_TRUST_PROXY_HEADERS=true`.
- Preserve existing handler call sites, response bodies, and error codes.
- Do not add browser fingerprinting, KV, Durable Objects, or global quota semantics.
- Do not modify unrelated user changes in `src/app/App.tsx` or `src/styles.css`.
- Do not commit automatically.

---

### Task 1: Build the bounded fixed-window core package

**Files:**
- Create: `packages/rate-limit/package.json`
- Create: `packages/rate-limit/tsconfig.json`
- Create: `packages/rate-limit/src/types.ts`
- Create: `packages/rate-limit/src/fixedWindow.ts`
- Create: `packages/rate-limit/src/index.ts`
- Create: `packages/rate-limit/src/fixedWindow.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `createFixedWindowRateLimiter(options): FixedWindowRateLimiter`
- Produces: `FixedWindowRateLimiter.consume(input): RateLimitResult`

- [ ] Write failing tests using an injected clock for exact-limit rejection, reset, bucket/key isolation, disabled limits, dynamic limits, capacity eviction, key normalization, and invalid options.
- [ ] Run `pnpm exec tsx --test packages/rate-limit/src/fixedWindow.test.ts` and confirm failures are caused by the missing package implementation.
- [ ] Implement the public types and an insertion-ordered Map limiter with front cleanup and oldest-entry eviction.
- [ ] Ensure constructor options are positive safe integers and runtime strings are bounded before composing keys.
- [ ] Add package build/test scripts and the root `@safecafe/rate-limit: workspace:*` dependency plus `test:rate-limit` script.
- [ ] Run `pnpm test:rate-limit` and `pnpm --filter @safecafe/rate-limit build`.

### Task 2: Replace the Safecafe IP adapter behind its existing seam

**Files:**
- Create: `src/server/ipRateLimit.test.ts`
- Modify: `src/server/ipRateLimit.ts`
- Modify: `src/server/serverEnv.ts`

**Interfaces:**
- Consumes: `createFixedWindowRateLimiter` and `RateLimitResult` from `@safecafe/rate-limit`.
- Preserves: `consumeIpRateLimit(request, env, context, options): IpRateLimitHit | null`.
- Preserves: `ipRateLimitResponse(context, hit): Response`.

- [ ] Write failing adapter tests for Cloudflare IP priority, forwarded-header opt-in, stable local fallback, route/global/default precedence, invalid and empty values, disabled limits, route isolation, and 429 headers.
- [ ] Run `pnpm exec tsx --test src/server/ipRateLimit.test.ts` and confirm expected failures.
- [ ] Replace the global Map with one shared bounded limiter instance from the workspace package.
- [ ] Add `SAFECAFE_TRUST_PROXY_HEADERS` to the adapter environment type and only trust forwarded headers when it is exactly `true`.
- [ ] Resolve route-specific, global, and default limits in order, skipping empty or invalid configured values.
- [ ] Add remaining count to `IpRateLimitHit` and `X-Safecafe-IP-Rate-Remaining` on rejected responses while preserving current route error bodies.
- [ ] Run adapter and core tests together.

### Task 3: Integrate configuration and correct route defaults

**Files:**
- Modify: `src/server/safePrice.ts`
- Modify: `vite.config.ts`
- Modify: `scripts/release/core.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `CLOUDFLARE.md`
- Modify: `scripts/release/core-test.ts`

**Interfaces:**
- Adds runtime configuration: `SAFECAFE_TRUST_PROXY_HEADERS=true|false`.
- Keeps all existing per-route rate-limit environment variables.

- [ ] Add a failing release-config assertion that `SAFECAFE_TRUST_PROXY_HEADERS` is synchronized as a Cloudflare Pages runtime value.
- [ ] Forward the variable through local Vite API development and release runtime configuration.
- [ ] Change SAFE price's no-env default from 120 to 60 requests per minute.
- [ ] Document default-untrusted proxy headers, per-isolate memory semantics, capacity behavior, and the new variable.
- [ ] Run `pnpm test:release`, core limiter tests, and adapter tests.

### Task 4: Verify migration and regressions

**Files:**
- Modify only if a targeted test reveals a regression.

- [ ] Run `pnpm install --frozen-lockfile`.
- [ ] Run `pnpm test:rate-limit`, which covers both the core package and the Safecafe server adapter.
- [ ] Run `pnpm exec tsx scripts/agent-core-test.mjs` to verify handler compatibility.
- [ ] Run `pnpm check` for locale, package build, TypeScript, release type checking, and Biome.
- [ ] Run `pnpm test:e2e` because provider-mode API routing exercises the migrated server adapter.
- [ ] Run `git diff --check` and review the complete diff, excluding unrelated user changes from the implementation summary.

## Acceptance Checklist

- [ ] The limiter core has no Cloudflare or Safecafe imports.
- [ ] Active memory is bounded by `maxEntries`.
- [ ] Cleanup only advances from the oldest Map entries and never scans all active entries.
- [ ] Every test can use a fresh limiter and injected clock.
- [ ] Forwarded headers are ignored by default.
- [ ] Existing handlers keep their current interface and public errors.
- [ ] SAFE price defaults to 60 requests per minute.
- [ ] Documentation clearly states that limits are per isolate and not globally strict.
