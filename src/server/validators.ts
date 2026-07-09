import { fetchValidators } from "../protocol"
import { bigintReplacer } from "../shared"
import { createRequestContext, logServerEvent, truncateMessage, withRequestHeaders } from "./serverDiagnostics"

const validatorMetadataCacheTtlMs = 5 * 60 * 1000
let validatorMetadataCache: {
  source: "fallback" | "live"
  validators: Awaited<ReturnType<typeof fetchValidators>>
  expiresAt: number
} | null = null

export async function handleValidatorsRequest(request: Request): Promise<Response> {
  const context = createRequestContext(request, "/api/validators")
  if (request.method !== "GET") {
    return withRequestHeaders(
      json({ code: "method_not_allowed", error: "Method not allowed", requestId: context.requestId }, 405),
      context,
      "method_not_allowed",
    )
  }

  const cached = validatorMetadataCache && validatorMetadataCache.expiresAt > Date.now() ? validatorMetadataCache : null
  if (cached?.source === "live") {
    return withRequestHeaders(
      json({ requestId: context.requestId, source: cached.source, validators: cached.validators }, 200, "HIT"),
      context,
    )
  }

  try {
    const validators = await readValidatorMetadata(request, context)
    return withRequestHeaders(json({ requestId: context.requestId, source: "live", validators }, 200, "MISS"), context)
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
      source: "live",
      validators,
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
