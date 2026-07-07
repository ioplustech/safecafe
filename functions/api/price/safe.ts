import { handleSafePriceRequest } from "../../../src/server/safePrice"

export const onRequestGet: PagesFunction = async ({ request }) => handleSafePriceRequest(request)

export const onRequestPost: PagesFunction = async () =>
  new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  })
