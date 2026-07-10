import { handleAgentApiRequest } from "../../src/server/agentApi"
import type { RpcGatewayEnv } from "../../src/server/serverEnv"

export const onRequestPost: PagesFunction<RpcGatewayEnv> = async ({ request, env }) =>
  handleAgentApiRequest(request, env)

export const onRequestGet: PagesFunction = async () =>
  new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })
