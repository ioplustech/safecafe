import { SAFE_PRICE_CACHE_MS, SAFE_PRICE_SOURCE } from "../protocol"
import { readCachedSafePrice as readStoredSafePrice, writeCachedSafePrice as writeStoredSafePrice } from "../shared"
import type { SafePriceState } from "./types"

const safePriceCacheKey = "safecafe.safeUsdPrice.v1"

export function readCachedSafePrice(): SafePriceState {
  try {
    return readStoredSafePrice(window.localStorage, safePriceCacheKey, SAFE_PRICE_SOURCE, SAFE_PRICE_CACHE_MS)
  } catch {
    return {
      usd: null,
      source: SAFE_PRICE_SOURCE,
      fetchedAt: null,
      stale: false,
      error: "",
    }
  }
}

export function writeCachedSafePrice(price: SafePriceState) {
  try {
    if (price.usd !== null && price.fetchedAt !== null) {
      writeStoredSafePrice(window.localStorage, safePriceCacheKey, {
        usd: price.usd,
        source: price.source,
        fetchedAt: price.fetchedAt,
      })
    }
  } catch {
    // Price display is best-effort; blocked storage should not affect staking.
  }
}
