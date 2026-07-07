import { getAddress, isAddress } from "viem"

const mainnetSafeTransactionService = "https://safe-transaction-mainnet.safe.global"

type SafeOwnerResponse = {
  safes?: unknown
}

export async function handleSafeDiscoveryRequest(request: Request): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405)
  const url = new URL(request.url)
  const owner = url.searchParams.get("owner")
  if (!owner || !isAddress(owner)) return json({ error: "A valid owner address is required." }, 400)

  try {
    const normalizedOwner = getAddress(owner)
    const response = await fetch(`${mainnetSafeTransactionService}/api/v1/owners/${normalizedOwner}/safes/`, {
      headers: { accept: "application/json" },
    })
    if (!response.ok) return json({ error: "Failed to discover Safe accounts.", safes: [] }, 502)
    const data = (await response.json()) as SafeOwnerResponse
    const safes = Array.isArray(data.safes)
      ? data.safes
          .filter((safe): safe is string => typeof safe === "string" && isAddress(safe))
          .map((safe) => getAddress(safe))
      : []
    return json({ safes }, 200)
  } catch {
    return json({ error: "Failed to discover Safe accounts.", safes: [] }, 502)
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
