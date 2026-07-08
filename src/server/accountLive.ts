import { createPublicClient, fallback, getAddress, http, isAddress } from "viem"
import {
  ethereumMainnet,
  fetchValidators,
  mockSummary,
  mockValidators,
  readAccountSnapshot,
  readHealth,
  readValidatorPositions,
} from "../protocol"
import { bigintReplacer } from "../shared"
import { rpcUrls } from "./rpcUpstream"
import { createRequestContext, logServerEvent, truncateMessage, withRequestHeaders } from "./serverDiagnostics"
import type { RpcGatewayEnv } from "./serverEnv"

const mockMerkleRoot = `0x${"11".repeat(32)}` as const
const accountLiveCacheTtlMs = 5 * 60 * 1000
const accountLiveCache = new Map<string, { body: string; expiresAt: number }>()

export async function handleAccountLiveRequest(request: Request, env: RpcGatewayEnv): Promise<Response> {
  const context = createRequestContext(request, "account.live")
  if (request.method !== "GET")
    return json({ code: "method_not_allowed", error: "Method not allowed", requestId: context.requestId }, 405, context)
  const url = new URL(request.url)
  const account = url.searchParams.get("account")
  if (!account || !isAddress(account)) {
    return json(
      { code: "invalid_account", error: "A valid account address is required.", requestId: context.requestId },
      400,
      context,
    )
  }

  const normalizedAccount = getAddress(account)
  const cacheKey = normalizedAccount.toLowerCase()
  const bypassCache = url.searchParams.get("refresh") === "true"
  const cached = bypassCache ? null : accountLiveCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return jsonString(cached.body, 200, "no-store", "HIT", context)

  if (isMockAccountLiveEnabled(env, normalizedAccount)) {
    const body = JSON.stringify(mockAccountLiveBody(), bigintReplacer)
    accountLiveCache.set(cacheKey, { body, expiresAt: Date.now() + accountLiveCacheTtlMs })
    return jsonString(body, 200, "no-store", "MISS", context)
  }

  try {
    const client = createPublicClient({
      chain: ethereumMainnet,
      transport: fallback((await rpcUrls(env)).map((rpcUrl) => http(rpcUrl, { timeout: 8_000 }))),
    })
    const [snapshot, health, validatorMetadata] = await Promise.all([
      readAccountSnapshot(client, normalizedAccount),
      readHealth(client),
      fetchValidators(undefined, { fallback: false }),
    ])
    const validatorsWithPositions = await readValidatorPositions(client, normalizedAccount, validatorMetadata)
    const body = JSON.stringify({ health, snapshot, validatorsWithPositions }, bigintReplacer)
    accountLiveCache.set(cacheKey, { body, expiresAt: Date.now() + accountLiveCacheTtlMs })
    return jsonString(body, 200, "no-store", "MISS", context)
  } catch (error) {
    logServerEvent(context, "error", "account.live.failed", {
      account: normalizedAccount,
      error: truncateMessage(error instanceof Error ? error.message : "Unknown live account error."),
    })
    return json(
      { code: "account_live_failed", error: "Failed to load live account data.", requestId: context.requestId },
      502,
      context,
      "account_live_failed",
    )
  }
}

function isMockAccountLiveEnabled(env: RpcGatewayEnv, account: string) {
  if (env.SAFECAFE_MOCK_ACCOUNT_LIVE !== "true") return false
  return !env.SAFECAFE_MOCK_ACCOUNT || env.SAFECAFE_MOCK_ACCOUNT.toLowerCase() === account.toLowerCase()
}

function mockAccountLiveBody() {
  return {
    health: {
      blockNumber: 1n,
      withdrawDelay: mockSummary.withdrawDelay,
      merkleRoot: mockMerkleRoot,
    },
    snapshot: {
      safeBalance: mockSummary.safeBalance,
      totalStaked: mockSummary.totalStaked,
      pendingWithdrawals: [
        {
          amount: mockSummary.pendingWithdrawals,
          claimableAt: BigInt(Math.floor(Date.now() / 1000) + 60 * 60),
        },
      ],
      nextClaimableWithdrawal: {
        amount: mockSummary.claimableWithdrawals,
        claimableAt: 0n,
      },
      cumulativeClaimed: 0n,
      withdrawDelay: mockSummary.withdrawDelay,
      stakingAllowance: 0n,
    },
    validatorsWithPositions: mockValidators,
  }
}

function json(payload: unknown, status = 200, context?: ReturnType<typeof createRequestContext>, errorCode?: string) {
  return jsonString(JSON.stringify(payload, bigintReplacer), status, "no-store", undefined, context, errorCode)
}

function jsonString(
  body: string,
  status = 200,
  cacheControl = "no-store",
  cacheStatus?: "HIT" | "MISS",
  context?: ReturnType<typeof createRequestContext>,
  errorCode?: string,
) {
  const response = new Response(body, {
    status,
    headers: {
      "cache-control": cacheControl,
      "content-type": "application/json; charset=utf-8",
      ...(cacheStatus ? { "x-safecafe-cache": cacheStatus } : {}),
    },
  })
  return context ? withRequestHeaders(response, context, errorCode) : response
}
