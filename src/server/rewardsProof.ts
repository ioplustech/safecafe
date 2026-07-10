import { getAddress, isAddress } from "viem"
import { fetchRewardProof, type RewardProof } from "../protocol"
import { consumeIpRateLimit, ipRateLimitResponse } from "./ipRateLimit"
import { createRequestContext, logServerEvent, truncateMessage, withRequestHeaders } from "./serverDiagnostics"
import type { RpcGatewayEnv } from "./serverEnv"

const rewardProofCacheTtlMs = 5 * 60 * 1000
const rewardProofCache = new Map<string, { proof: RewardProof | null; expiresAt: number }>()

export async function handleRewardProofRequest(request: Request, env: RpcGatewayEnv = {}): Promise<Response> {
  const context = createRequestContext(request, "/api/rewards/proof")
  if (request.method !== "GET") {
    return withRequestHeaders(
      json({ code: "method_not_allowed", error: "Method not allowed", requestId: context.requestId }, 405),
      context,
      "method_not_allowed",
    )
  }
  const ipLimited = consumeIpRateLimit(request, env, context, {
    bucket: "rewards.proof",
    defaultLimit: 60,
    limitEnvKey: "SAFECAFE_READ_API_IP_RATE_LIMIT_PER_MINUTE",
  })
  if (ipLimited) return ipRateLimitResponse(context, ipLimited)
  const url = new URL(request.url)
  const account = url.searchParams.get("account")
  if (!account || !isAddress(account)) {
    return withRequestHeaders(
      json(
        { code: "invalid_account", error: "A valid account address is required.", requestId: context.requestId },
        400,
      ),
      context,
      "invalid_account",
    )
  }

  const normalizedAccount = getAddress(account)
  try {
    const proof = await readRewardProof(normalizedAccount, request, context, {
      bypassCache: url.searchParams.get("refresh") === "true",
      throwOnFailure: true,
    })
    return withRequestHeaders(json({ proof, requestId: context.requestId }, 200), context)
  } catch {
    return withRequestHeaders(
      json(
        {
          code: "reward_proof_failed",
          error: "Failed to load reward proof.",
          requestId: context.requestId,
        },
        502,
      ),
      context,
      "reward_proof_failed",
    )
  }
}

export async function readRewardProof(
  account: string,
  request?: Request,
  context = request ? createRequestContext(request, "/api/rewards/proof") : undefined,
  options: { bypassCache?: boolean; throwOnFailure?: boolean } = {},
) {
  const normalizedAccount = getAddress(account)
  const cacheKey = normalizedAccount.toLowerCase()
  const cached = rewardProofCache.get(cacheKey)
  if (!options.bypassCache && cached && cached.expiresAt > Date.now()) return cached.proof
  try {
    const proof = await fetchRewardProof(normalizedAccount)
    rewardProofCache.set(cacheKey, { proof, expiresAt: Date.now() + rewardProofCacheTtlMs })
    return proof
  } catch (error) {
    if (context) {
      logServerEvent(context, "warn", "rewards.proof.failed", {
        account: normalizedAccount,
        error: truncateMessage(error instanceof Error ? error.message : "Failed to load reward proof."),
      })
    }
    if (options.throwOnFailure) throw error
    return null
  }
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  })
}
