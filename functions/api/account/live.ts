import { handleAccountLiveRequest } from "../../../src/server/accountLive"

export const onRequestGet: PagesFunction<{
  SAFECAFE_MOCK_ACCOUNT?: string
  SAFECAFE_MOCK_ACCOUNT_LIVE?: string
  SAFECAFE_RPC_URL?: string
  SAFECAFE_RPC_URLS?: string
}> = async ({ request, env }) => handleAccountLiveRequest(request, env)

export const onRequestPost: PagesFunction = async () =>
  new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  })
