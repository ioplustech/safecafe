import { SAFE_PRICE_SOURCE, type SafePriceResult } from "../protocol"

export async function fetchSafeUsdPrice(): Promise<SafePriceResult> {
  const response = await fetch("/api/price/safe")
  if (!response.ok) throw new Error(`SAFE price request failed: ${response.status}`)

  const data = (await response.json()) as Partial<SafePriceResult>
  if (typeof data.usd !== "number" || !Number.isFinite(data.usd) || data.usd <= 0) {
    throw new Error("SAFE price response did not include a valid USD price.")
  }

  return {
    source: SAFE_PRICE_SOURCE,
    usd: data.usd,
    fetchedAt: typeof data.fetchedAt === "number" ? data.fetchedAt : Date.now(),
  }
}
