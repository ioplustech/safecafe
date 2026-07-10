import { handleSafePriceRequest } from "../../../src/server/safePrice"
import type { RpcGatewayEnv } from "../../../src/server/serverEnv"

export const onRequestGet: PagesFunction<RpcGatewayEnv> = async ({ env, request }) =>
  handleSafePriceRequest(request, env)

export const onRequestPost: PagesFunction = async () =>
  new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  })
