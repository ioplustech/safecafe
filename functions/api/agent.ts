import { handleAgentApiRequest } from "../../src/server/agentApi"

export const onRequestPost: PagesFunction<{
  SAFECAFE_RPC_ALLOW_ALL_WALLETS?: string
  SAFECAFE_AUTH_SECRET?: string
  SAFECAFE_RPC_URL?: string
  SAFECAFE_RPC_URLS?: string
  SAFECAFE_AGENT_AUTH?: string
  SAFECAFE_LLM_API_BASE?: string
  SAFECAFE_LLM_API_MODEL?: string
  SAFECAFE_LLM_API_KEY?: string
  VITE_AGENT_AUTH?: string
}> = async ({ request, env }) => handleAgentApiRequest(request, env)

export const onRequestGet: PagesFunction = async () =>
  new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })
