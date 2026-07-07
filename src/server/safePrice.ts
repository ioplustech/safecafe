import { fetchSafeUsdPriceFromCoinGecko } from "../protocol"

export async function handleSafePriceRequest(request: Request) {
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405, "no-store")
  }
  try {
    const price = await fetchSafeUsdPriceFromCoinGecko()
    return json(price, 200, "public, max-age=300, stale-while-revalidate=3600")
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "SAFE price request failed" },
      502,
      "public, max-age=60, stale-if-error=3600",
    )
  }
}

function json(body: unknown, status: number, cacheControl: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": cacheControl,
      "content-type": "application/json; charset=utf-8",
    },
  })
}
