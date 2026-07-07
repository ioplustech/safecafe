import { handleSafeDiscoveryRequest } from "../../src/server/safeDiscovery"

export const onRequestGet: PagesFunction = async ({ request }) => handleSafeDiscoveryRequest(request)

export const onRequestPost: PagesFunction = async () =>
  new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })
