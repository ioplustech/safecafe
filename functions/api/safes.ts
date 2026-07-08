import { handleSafeDiscoveryRequest } from "../../src/server/safeDiscovery"
import type { RpcGatewayEnv } from "../../src/server/serverEnv"

export const onRequestGet: PagesFunction<RpcGatewayEnv> = async ({ env, request }) =>
  handleSafeDiscoveryRequest(request, env)

export const onRequestPost: PagesFunction = async () =>
  new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })
