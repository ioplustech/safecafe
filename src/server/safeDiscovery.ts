import { type Address, createPublicClient, fallback, getAddress, http, isAddress } from "viem"
import { safeAccountAbi } from "../protocol/abi"
import { ethereumMainnet } from "../protocol/chains"
import { rpcUrls } from "./rpcUpstream"
import { createRequestContext, logServerEvent, truncateMessage, withRequestHeaders } from "./serverDiagnostics"
import type { RpcGatewayEnv } from "./serverEnv"

const mainnetSafeTransactionService = "https://safe-transaction-mainnet.safe.global"

type SafeOwnerResponse = {
  safes?: unknown
}

export type SafeMultisigMetadata = {
  address: Address
  ownersCount: number | null
  threshold: number | null
}

export async function handleSafeDiscoveryRequest(request: Request, env: RpcGatewayEnv = {}): Promise<Response> {
  const context = createRequestContext(request, "/api/safes")
  if (request.method !== "GET") {
    return withRequestHeaders(
      json({ code: "method_not_allowed", error: "Method not allowed", requestId: context.requestId }, 405),
      context,
    )
  }
  const url = new URL(request.url)
  const owner = url.searchParams.get("owner")
  const safe = url.searchParams.get("safe")
  if (safe) {
    if (!isAddress(safe)) {
      return withRequestHeaders(
        json({ code: "invalid_safe", error: "A valid Safe address is required.", requestId: context.requestId }, 400),
        context,
        "invalid_safe",
      )
    }
    try {
      const metadata = await readSafeMultisigMetadata(getAddress(safe), env)
      return withRequestHeaders(json({ safe: metadata, requestId: context.requestId }, 200), context)
    } catch (error) {
      logServerEvent(context, "warn", "safe.discovery.metadata_failed", {
        error: truncateMessage(error instanceof Error ? error.message : "Failed to read Safe metadata."),
        safe: getAddress(safe),
      })
      return withRequestHeaders(
        json({ safe: emptySafeMetadata(getAddress(safe)), requestId: context.requestId }, 200),
        context,
      )
    }
  }

  if (!owner || !isAddress(owner)) {
    return withRequestHeaders(
      json({ code: "invalid_owner", error: "A valid owner address is required.", requestId: context.requestId }, 400),
      context,
      "invalid_owner",
    )
  }

  try {
    const normalizedOwner = getAddress(owner)
    const response = await fetch(`${mainnetSafeTransactionService}/api/v1/owners/${normalizedOwner}/safes/`, {
      headers: { accept: "application/json" },
    })
    if (!response.ok) {
      logServerEvent(context, "warn", "safe.discovery.service_failed", {
        owner: normalizedOwner,
        status: response.status,
      })
      return withRequestHeaders(
        json(
          {
            code: "safe_discovery_failed",
            error: "Failed to discover Safe accounts.",
            requestId: context.requestId,
            safes: [],
          },
          502,
        ),
        context,
        "safe_discovery_failed",
      )
    }
    const data = (await response.json()) as SafeOwnerResponse
    const safeAddresses = Array.isArray(data.safes)
      ? data.safes
          .filter((safe): safe is string => typeof safe === "string" && isAddress(safe))
          .map((safe) => getAddress(safe))
      : []
    const safes = await Promise.all(
      safeAddresses.map((address) => readSafeMultisigMetadataOrEmpty(address, env, context)),
    )
    logServerEvent(context, "info", "safe.discovery.success", {
      owner: normalizedOwner,
      safes: safes.length,
    })
    return withRequestHeaders(json({ requestId: context.requestId, safes }, 200), context)
  } catch (error) {
    logServerEvent(context, "error", "safe.discovery.failed", {
      error: truncateMessage(error instanceof Error ? error.message : "Failed to discover Safe accounts."),
    })
    return withRequestHeaders(
      json(
        {
          code: "safe_discovery_failed",
          error: "Failed to discover Safe accounts.",
          requestId: context.requestId,
          safes: [],
        },
        502,
      ),
      context,
      "safe_discovery_failed",
    )
  }
}

async function readSafeMultisigMetadataOrEmpty(
  address: Address,
  env: RpcGatewayEnv,
  context: ReturnType<typeof createRequestContext>,
) {
  try {
    return await readSafeMultisigMetadata(address, env)
  } catch (error) {
    logServerEvent(context, "warn", "safe.discovery.metadata_failed", {
      error: truncateMessage(error instanceof Error ? error.message : "Failed to read Safe metadata."),
      safe: address,
    })
    return emptySafeMetadata(address)
  }
}

async function readSafeMultisigMetadata(address: Address, env: RpcGatewayEnv): Promise<SafeMultisigMetadata> {
  const client = createPublicClient({
    chain: ethereumMainnet,
    transport: fallback((await rpcUrls(env)).map((url) => http(url, { timeout: 8_000 }))),
  })
  const [owners, threshold] = await Promise.all([
    client.readContract({
      address,
      abi: safeAccountAbi,
      functionName: "getOwners",
    }),
    client.readContract({
      address,
      abi: safeAccountAbi,
      functionName: "getThreshold",
    }),
  ])
  return {
    address,
    ownersCount: owners.length,
    threshold: bigintToSafeNumber(threshold),
  }
}

function emptySafeMetadata(address: Address): SafeMultisigMetadata {
  return {
    address,
    ownersCount: null,
    threshold: null,
  }
}

function bigintToSafeNumber(value: bigint): number | null {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value)
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
