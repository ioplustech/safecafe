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
import type { RpcGatewayEnv } from "./serverEnv"

const mockMerkleRoot = `0x${"11".repeat(32)}` as const
const accountLiveCacheTtlMs = 5 * 60 * 1000
const accountLiveCache = new Map<string, { body: string; expiresAt: number }>()

export async function handleAccountLiveRequest(request: Request, env: RpcGatewayEnv): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, "no-store")
  const url = new URL(request.url)
  const account = url.searchParams.get("account")
  if (!account || !isAddress(account)) return json({ error: "A valid account address is required." }, 400, "no-store")

  const normalizedAccount = getAddress(account)
  const cacheKey = normalizedAccount.toLowerCase()
  const bypassCache = url.searchParams.get("refresh") === "true"
  const cached = bypassCache ? null : accountLiveCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return jsonString(cached.body, 200, "no-store", "HIT")

  if (isMockAccountLiveEnabled(env, normalizedAccount)) {
    const body = JSON.stringify(mockAccountLiveBody(), bigintReplacer)
    accountLiveCache.set(cacheKey, { body, expiresAt: Date.now() + accountLiveCacheTtlMs })
    return jsonString(body, 200, "no-store", "MISS")
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
    return jsonString(body, 200, "no-store", "MISS")
  } catch {
    return json({ error: "Failed to load live account data." }, 502, "no-store")
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

function json(payload: unknown, status = 200, cacheControl = "no-store") {
  return jsonString(JSON.stringify(payload, bigintReplacer), status, cacheControl)
}

function jsonString(body: string, status = 200, cacheControl = "no-store", cacheStatus?: "HIT" | "MISS") {
  return new Response(body, {
    status,
    headers: {
      "cache-control": cacheControl,
      "content-type": "application/json; charset=utf-8",
      ...(cacheStatus ? { "x-safecafe-cache": cacheStatus } : {}),
    },
  })
}
