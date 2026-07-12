import { createPublicClient, fallback, http } from "viem"
import { ethereumMainnet, fetchValidators, readHealth, readValidatorTotals } from "../protocol"
import { bigintReplacer } from "../shared"
import { consumeIpRateLimit, ipRateLimitResponse } from "./ipRateLimit"
import { rpcUrls } from "./rpcUpstream"
import { createRequestContext, logServerEvent, truncateMessage, withRequestHeaders } from "./serverDiagnostics"
import type { RpcGatewayEnv } from "./serverEnv"

const validatorMetadataCacheTtlMs = 5 * 60 * 1000
let validatorMetadataCache: {
  hasTotals: boolean
  source: "fallback" | "live"
  validators: Awaited<ReturnType<typeof fetchValidators>>
  withdrawDelay: bigint | null
  expiresAt: number
} | null = null

export async function handleValidatorsRequest(
  request: Request,
  env: RpcGatewayEnv = {},
  dependencies: {
    readProtocolData?: (validators: Awaited<ReturnType<typeof fetchValidators>>) => Promise<{
      validators: Awaited<ReturnType<typeof fetchValidators>>
      withdrawDelay: bigint
    }>
  } = {},
): Promise<Response> {
  const context = createRequestContext(request, "/api/validators")
  if (request.method !== "GET") {
    return withRequestHeaders(
      json({ code: "method_not_allowed", error: "Method not allowed", requestId: context.requestId }, 405),
      context,
      "method_not_allowed",
    )
  }
  const ipLimited = consumeIpRateLimit(request, env, context, {
    bucket: "validators",
    defaultLimit: 60,
    limitEnvKey: "SAFECAFE_READ_API_IP_RATE_LIMIT_PER_MINUTE",
  })
  if (ipLimited) return ipRateLimitResponse(context, ipLimited)

  const cached = validatorMetadataCache && validatorMetadataCache.expiresAt > Date.now() ? validatorMetadataCache : null
  if (cached?.source === "live" && cached.hasTotals) {
    return withRequestHeaders(
      json(
        {
          requestId: context.requestId,
          source: cached.source,
          validators: cached.validators,
          withdrawDelay: cached.withdrawDelay,
        },
        200,
        "HIT",
      ),
      context,
    )
  }

  try {
    const validatorMetadata = await readValidatorMetadata(request, context)
    const protocolData = dependencies.readProtocolData
      ? await dependencies.readProtocolData(validatorMetadata)
      : await readLiveValidatorProtocolData(validatorMetadata, env)
    validatorMetadataCache = {
      expiresAt: Date.now() + validatorMetadataCacheTtlMs,
      hasTotals: true,
      source: "live",
      validators: protocolData.validators,
      withdrawDelay: protocolData.withdrawDelay,
    }
    return withRequestHeaders(
      json(
        {
          requestId: context.requestId,
          source: "live",
          validators: protocolData.validators,
          withdrawDelay: protocolData.withdrawDelay,
        },
        200,
        "MISS",
      ),
      context,
    )
  } catch (error) {
    logServerEvent(context, "error", "validators.metadata.failed", {
      error: truncateMessage(error instanceof Error ? error.message : "Failed to load validator metadata."),
    })
    return withRequestHeaders(
      json(
        {
          code: "validators_metadata_failed",
          error: "Failed to load validator metadata.",
          requestId: context.requestId,
          validators: [],
        },
        502,
      ),
      context,
      "validators_metadata_failed",
    )
  }
}

async function readLiveValidatorProtocolData(
  validators: Awaited<ReturnType<typeof fetchValidators>>,
  env: RpcGatewayEnv,
) {
  const client = createPublicClient({
    chain: ethereumMainnet,
    transport: fallback((await rpcUrls(env)).map((rpcUrl) => http(rpcUrl, { timeout: 8_000 }))),
  })
  const [validatorsWithTotals, health] = await Promise.all([
    readValidatorTotals(client, validators, { strict: true }),
    readHealth(client),
  ])
  return { validators: validatorsWithTotals, withdrawDelay: health.withdrawDelay }
}

export async function readValidatorMetadata(
  _request?: Request,
  _context?: ReturnType<typeof createRequestContext>,
  options: { fallback?: boolean } = {},
) {
  const cached = validatorMetadataCache && validatorMetadataCache.expiresAt > Date.now() ? validatorMetadataCache : null
  if (cached?.source === "live") return cached.validators
  const validators = await fetchValidators(undefined, {
    fallback: options.fallback ?? false,
  })
  if (!options.fallback) {
    validatorMetadataCache = {
      hasTotals: false,
      source: "live",
      validators,
      withdrawDelay: null,
      expiresAt: Date.now() + validatorMetadataCacheTtlMs,
    }
  }
  return validators
}

export const validatorMetadataTestHooks = {
  resetCache() {
    validatorMetadataCache = null
  },
}

function json(payload: unknown, status = 200, cacheStatus?: "HIT" | "MISS") {
  return jsonString(JSON.stringify(payload, bigintReplacer), status, cacheStatus)
}

function jsonString(body: string, status = 200, cacheStatus?: "HIT" | "MISS") {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...(cacheStatus ? { "x-safecafe-cache": cacheStatus } : {}),
    },
  })
}
