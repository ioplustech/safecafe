import { handleAgentApiRequest } from "../../src/server/agentApi"

export const onRequestPost: PagesFunction<{
  SAFECAFE_RPC_URL?: string
  SAFECAFE_LLM_API_BASE?: string
  SAFECAFE_LLM_API_MODEL?: string
  SAFECAFE_LLM_API_KEY?: string
}> = async ({ request, env }) => handleAgentApiRequest(request, env)

export const onRequestGet: PagesFunction = async () =>
  new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })
