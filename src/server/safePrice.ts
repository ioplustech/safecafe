import { fetchSafeUsdPriceFromCoinGecko } from "../protocol"
import { consumeIpRateLimit } from "./ipRateLimit"
import { createRequestContext, withRequestHeaders } from "./serverDiagnostics"
import type { RpcGatewayEnv } from "./serverEnv"

export async function handleSafePriceRequest(request: Request, env: RpcGatewayEnv = {}) {
  const context = createRequestContext(request, "/api/price/safe")
  if (request.method !== "GET") {
    return withRequestHeaders(
      json({ error: "Method not allowed", requestId: context.requestId }, 405, "no-store"),
      context,
    )
  }
  const ipLimited = consumeIpRateLimit(request, env, context, {
    bucket: "price.safe",
    defaultLimit: 120,
    limitEnvKey: "SAFECAFE_READ_API_IP_RATE_LIMIT_PER_MINUTE",
  })
  if (ipLimited) {
    return withRequestHeaders(
      json(
        {
          code: ipLimited.code,
          error: "Too many price requests from this IP. Please slow down.",
          limit: ipLimited.limit,
          requestId: context.requestId,
          resetAt: new Date(ipLimited.resetAt).toISOString(),
        },
        429,
        "no-store",
        ipLimited.headers,
      ),
      context,
      ipLimited.code,
    )
  }
  try {
    const price = await fetchSafeUsdPriceFromCoinGecko()
    return withRequestHeaders(json(price, 200, "public, max-age=300, stale-while-revalidate=3600"), context)
  } catch (error) {
    return withRequestHeaders(
      json(
        { error: error instanceof Error ? error.message : "SAFE price request failed", requestId: context.requestId },
        502,
        "public, max-age=60, stale-if-error=3600",
      ),
      context,
      "safe_price_failed",
    )
  }
}

function json(body: unknown, status: number, cacheControl: string, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": cacheControl,
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  })
}
