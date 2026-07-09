import { type Address, createPublicClient, fallback, getAddress, http, isAddress, type PublicClient } from "viem"
import { safeAccountAbi } from "../protocol/abi"
import { ethereumMainnet } from "../protocol/chains"
import { rpcUrls } from "./rpcUpstream"
import { createRequestContext, logServerEvent, truncateMessage, withRequestHeaders } from "./serverDiagnostics"
import type { RpcGatewayEnv } from "./serverEnv"

const mainnetSafeTransactionService = "https://api.safe.global/tx-service/eth"
const maxSafeDiscoveryDepth = 3
const maxDiscoveredSafes = 25

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
    const safeAddresses = await discoverSafeAddresses(normalizedOwner, context)
    const client = await createSafeDiscoveryClient(env)
    const safes = await Promise.all(
      safeAddresses.map((address) => readSafeMultisigMetadataOrEmpty(address, env, context, client)),
    )
    logServerEvent(context, "info", "safe.discovery.success", {
      depth: maxSafeDiscoveryDepth,
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

async function discoverSafeAddresses(owner: Address, context: ReturnType<typeof createRequestContext>) {
  const discovered = new Map<string, Address>()
  const visitedOwners = new Set<string>()
  let frontier: Array<{ owner: Address; depth: number }> = [{ owner, depth: 0 }]

  while (frontier.length > 0 && discovered.size < maxDiscoveredSafes) {
    const nextFrontier: Array<{ owner: Address; depth: number }> = []
    const currentFrontier = frontier
    frontier = nextFrontier

    const results = await Promise.all(
      currentFrontier.map(async (item) => {
        const ownerKey = item.owner.toLowerCase()
        if (visitedOwners.has(ownerKey)) return { depth: item.depth, owner: item.owner, safes: [] as Address[] }
        visitedOwners.add(ownerKey)
        try {
          return {
            depth: item.depth,
            owner: item.owner,
            safes: await fetchSafeAddressesForOwner(item.owner),
          }
        } catch (error) {
          logServerEvent(context, item.depth === 0 ? "error" : "warn", "safe.discovery.owner_failed", {
            depth: item.depth,
            error: truncateMessage(error instanceof Error ? error.message : "Failed to discover Safe accounts."),
            owner: item.owner,
          })
          if (item.depth === 0) throw error
          return { depth: item.depth, owner: item.owner, safes: [] as Address[] }
        }
      }),
    )

    for (const result of results) {
      for (const safe of result.safes) {
        if (discovered.size >= maxDiscoveredSafes) break
        const safeKey = safe.toLowerCase()
        if (!discovered.has(safeKey)) discovered.set(safeKey, safe)
        if (result.depth < maxSafeDiscoveryDepth && !visitedOwners.has(safeKey)) {
          nextFrontier.push({ owner: safe, depth: result.depth + 1 })
        }
      }
    }

    frontier = nextFrontier
  }

  return [...discovered.values()]
}

async function fetchSafeAddressesForOwner(owner: Address): Promise<Address[]> {
  const response = await fetch(`${mainnetSafeTransactionService}/api/v1/owners/${owner}/safes/`, {
    headers: { accept: "application/json" },
  })
  if (!response.ok) throw new Error(`Safe Transaction Service returned ${response.status}.`)
  const data = (await response.json()) as SafeOwnerResponse
  if (!Array.isArray(data.safes)) return []
  return data.safes
    .filter((safe): safe is string => typeof safe === "string" && isAddress(safe))
    .map((safe) => getAddress(safe))
}

async function readSafeMultisigMetadataOrEmpty(
  address: Address,
  env: RpcGatewayEnv,
  context: ReturnType<typeof createRequestContext>,
  client?: PublicClient,
) {
  try {
    return await readSafeMultisigMetadata(address, env, client)
  } catch (error) {
    logServerEvent(context, "warn", "safe.discovery.metadata_failed", {
      error: truncateMessage(error instanceof Error ? error.message : "Failed to read Safe metadata."),
      safe: address,
    })
    return emptySafeMetadata(address)
  }
}

async function readSafeMultisigMetadata(
  address: Address,
  env: RpcGatewayEnv,
  client?: PublicClient,
): Promise<SafeMultisigMetadata> {
  const publicClient = client ?? (await createSafeDiscoveryClient(env))
  const [owners, threshold] = await Promise.all([
    publicClient.readContract({
      address,
      abi: safeAccountAbi,
      functionName: "getOwners",
    }),
    publicClient.readContract({
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

async function createSafeDiscoveryClient(env: RpcGatewayEnv) {
  return createPublicClient({
    chain: ethereumMainnet,
    transport: fallback((await rpcUrls(env)).map((url) => http(url, { timeout: 8_000 }))),
  })
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
