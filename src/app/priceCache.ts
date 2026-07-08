import { SAFE_PRICE_CACHE_MS, SAFE_PRICE_SOURCE } from "../protocol"
import { readCachedSafePrice as readStoredSafePrice, writeCachedSafePrice as writeStoredSafePrice } from "../shared"
import { appStorageKeys, readBrowserStorage } from "./persistence"
import type { SafePriceState } from "./types"

export function readCachedSafePrice(): SafePriceState {
  try {
    const storage = readBrowserStorage()
    if (!storage) throw new Error("Browser storage is unavailable.")
    return readStoredSafePrice(storage, appStorageKeys.safePrice, SAFE_PRICE_SOURCE, SAFE_PRICE_CACHE_MS)
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
      const storage = readBrowserStorage()
      if (!storage) return
      writeStoredSafePrice(storage, appStorageKeys.safePrice, {
        usd: price.usd,
        source: price.source,
        fetchedAt: price.fetchedAt,
      })
    }
  } catch {
    // Price display is best-effort; blocked storage should not affect staking.
  }
}
