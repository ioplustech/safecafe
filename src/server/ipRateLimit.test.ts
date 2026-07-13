import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { CONTRACTS } from "../protocol/index.js"
import { consumeIpRateLimit, ipRateLimitResponse } from "./ipRateLimit.js"
import { handleSafePriceRequest } from "./safePrice.js"
import { createRequestContext } from "./serverDiagnostics.js"

let bucketSequence = 0

function nextBucket(label: string) {
  bucketSequence += 1
  return `test.${label}.${bucketSequence}`
}

function request(headers: HeadersInit = {}) {
  return new Request("http://localhost/api/test", { headers })
}

function consume(testRequest: Request, env: Record<string, string | undefined>, bucket: string, defaultLimit = 1) {
  return consumeIpRateLimit(testRequest, env, createRequestContext(testRequest, bucket), {
    bucket,
    defaultLimit,
    limitEnvKey: "SAFECAFE_READ_API_IP_RATE_LIMIT_PER_MINUTE",
  })
}

describe("Safecafe IP rate limit adapter", () => {
  test("prefers cf-connecting-ip over trusted forwarded headers", () => {
    const bucket = nextBucket("cloudflare-priority")
    const env = { SAFECAFE_TRUST_PROXY_HEADERS: "true" }

    assert.equal(
      consume(request({ "cf-connecting-ip": "203.0.113.10", "x-forwarded-for": "198.51.100.1" }), env, bucket),
      null,
    )
    assert.equal(
      consume(request({ "cf-connecting-ip": "203.0.113.10", "x-forwarded-for": "198.51.100.2" }), env, bucket)?.code,
      "ip_rate_limited",
    )
  })

  test("ignores forwarded headers by default", () => {
    const bucket = nextBucket("forwarded-default")

    assert.equal(consume(request({ "x-forwarded-for": "198.51.100.1" }), {}, bucket), null)
    assert.equal(consume(request({ "x-forwarded-for": "198.51.100.2" }), {}, bucket)?.code, "ip_rate_limited")
  })

  test("uses forwarded headers when trusted proxy support is enabled", () => {
    const bucket = nextBucket("forwarded-trusted")
    const env = { SAFECAFE_TRUST_PROXY_HEADERS: "true" }

    assert.equal(consume(request({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }), env, bucket), null)
    assert.equal(consume(request({ "x-forwarded-for": "198.51.100.2, 10.0.0.1" }), env, bucket), null)
    assert.equal(consume(request({ "x-real-ip": "198.51.100.3" }), env, bucket), null)
  })

  test("uses route-specific, global, and default limits in order", () => {
    const routeBucket = nextBucket("route-limit")
    const routeEnv = {
      SAFECAFE_API_IP_RATE_LIMIT_PER_MINUTE: "5",
      SAFECAFE_READ_API_IP_RATE_LIMIT_PER_MINUTE: "1",
    }
    assert.equal(consume(request(), routeEnv, routeBucket, 3), null)
    assert.equal(consume(request(), routeEnv, routeBucket, 3)?.code, "ip_rate_limited")

    const globalBucket = nextBucket("global-limit")
    const globalEnv = {
      SAFECAFE_API_IP_RATE_LIMIT_PER_MINUTE: "1",
      SAFECAFE_READ_API_IP_RATE_LIMIT_PER_MINUTE: "",
    }
    assert.equal(consume(request(), globalEnv, globalBucket, 3), null)
    assert.equal(consume(request(), globalEnv, globalBucket, 3)?.code, "ip_rate_limited")

    const invalidRouteBucket = nextBucket("invalid-route-limit")
    const invalidRouteEnv = {
      SAFECAFE_API_IP_RATE_LIMIT_PER_MINUTE: "1",
      SAFECAFE_READ_API_IP_RATE_LIMIT_PER_MINUTE: "invalid",
    }
    assert.equal(consume(request(), invalidRouteEnv, invalidRouteBucket, 3), null)
    assert.equal(consume(request(), invalidRouteEnv, invalidRouteBucket, 3)?.code, "ip_rate_limited")

    const negativeRouteBucket = nextBucket("negative-route-limit")
    const negativeRouteEnv = {
      SAFECAFE_API_IP_RATE_LIMIT_PER_MINUTE: "1",
      SAFECAFE_READ_API_IP_RATE_LIMIT_PER_MINUTE: "-1",
    }
    assert.equal(consume(request(), negativeRouteEnv, negativeRouteBucket, 3), null)
    assert.equal(consume(request(), negativeRouteEnv, negativeRouteBucket, 3)?.code, "ip_rate_limited")

    const exponentRouteBucket = nextBucket("exponent-route-limit")
    const exponentRouteEnv = {
      SAFECAFE_API_IP_RATE_LIMIT_PER_MINUTE: "1",
      SAFECAFE_READ_API_IP_RATE_LIMIT_PER_MINUTE: "1e2",
    }
    assert.equal(consume(request(), exponentRouteEnv, exponentRouteBucket, 3), null)
    assert.equal(consume(request(), exponentRouteEnv, exponentRouteBucket, 3)?.code, "ip_rate_limited")

    const defaultBucket = nextBucket("default-limit")
    assert.equal(consume(request(), {}, defaultBucket, 1), null)
    assert.equal(consume(request(), {}, defaultBucket, 1)?.code, "ip_rate_limited")
  })

  test("allows an explicit zero route limit to disable limiting", () => {
    const bucket = nextBucket("disabled")
    const env = {
      SAFECAFE_API_IP_RATE_LIMIT_PER_MINUTE: "1",
      SAFECAFE_READ_API_IP_RATE_LIMIT_PER_MINUTE: "0",
    }

    for (let index = 0; index < 5; index += 1) assert.equal(consume(request(), env, bucket), null)
  })

  test("isolates route buckets for the same client", () => {
    const firstBucket = nextBucket("route-a")
    const secondBucket = nextBucket("route-b")
    const testRequest = request({ "cf-connecting-ip": "203.0.113.20" })

    assert.equal(consume(testRequest, {}, firstBucket), null)
    assert.equal(consume(testRequest, {}, firstBucket)?.code, "ip_rate_limited")
    assert.equal(consume(testRequest, {}, secondBucket), null)
  })

  test("returns retry, limit, remaining, and reset headers on rejection", async () => {
    const bucket = nextBucket("response")
    const testRequest = request({ "cf-connecting-ip": "203.0.113.30" })
    consume(testRequest, {}, bucket)
    const hit = consume(testRequest, {}, bucket)
    assert.ok(hit)

    const response = ipRateLimitResponse(createRequestContext(testRequest, bucket), hit)
    const body = (await response.json()) as Record<string, unknown>

    assert.equal(response.status, 429)
    assert.equal(response.headers.get("retry-after"), "60")
    assert.equal(response.headers.get("x-safecafe-ip-rate-limit"), "1")
    assert.equal(response.headers.get("x-safecafe-ip-rate-remaining"), "0")
    assert.match(response.headers.get("x-safecafe-ip-rate-reset") ?? "", /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(body.code, "ip_rate_limited")
    assert.equal(body.limit, 1)
  })

  test("limits SAFE price reads to the documented default of 60 requests per minute", async () => {
    const originalFetch = globalThis.fetch
    const contract = CONTRACTS.safeToken.toLowerCase()
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ [contract]: { last_updated_at: 1, usd: 0.5 } }), {
        headers: { "content-type": "application/json" },
        status: 200,
      })

    try {
      const priceRequest = request({ "cf-connecting-ip": "203.0.113.99" })
      for (let index = 0; index < 60; index += 1) {
        assert.equal((await handleSafePriceRequest(priceRequest)).status, 200)
      }
      assert.equal((await handleSafePriceRequest(priceRequest)).status, 429)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
