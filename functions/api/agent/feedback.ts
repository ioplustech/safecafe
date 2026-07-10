import { handleAgentFeedbackRequest } from "../../../src/server/agentFeedback"
import type { RpcGatewayEnv } from "../../../src/server/serverEnv"

export const onRequestPost: PagesFunction<RpcGatewayEnv> = async ({ request, env }) =>
  handleAgentFeedbackRequest(request, env)

export const onRequestGet: PagesFunction = async () =>
  new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  })
