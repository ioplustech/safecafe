import type { RpcGatewayEnv } from "../../src/server/serverEnv"

const defaultAllowedOrigins = new Set([
  "https://safe-staking.eth.limo",
  "https://safecafe.baserun.link",
  "https://safecafe.pages.dev",
])

const trustedIpfsOriginPattern = /^b[a-z2-7]{20,}\.ipfs\.(?:dweb|inbrowser|nftstorage|w3s)\.link$/

export const onRequest: PagesFunction<RpcGatewayEnv> = async ({ env, next, request }) => {
  const corsHeaders = createCorsHeaders(request, env)
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  const response = await next()
  for (const [key, value] of corsHeaders) response.headers.set(key, value)
  return response
}

function createCorsHeaders(request: Request, env: RpcGatewayEnv) {
  const headers = new Headers({ vary: "Origin" })
  const origin = request.headers.get("origin")
  if (origin && isAllowedOrigin(origin, env)) {
    headers.set("access-control-allow-origin", origin)
  }
  headers.set("access-control-allow-methods", "GET,HEAD,POST,OPTIONS")
  headers.set("access-control-allow-headers", "authorization,content-type")
  headers.set("access-control-max-age", "86400")
  return headers
}

function isAllowedOrigin(origin: string, env: RpcGatewayEnv) {
  const configured = (env.SAFECAFE_API_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  if (configured.includes("*")) return true
  return configured.length ? configured.includes(origin) : isDefaultApiCorsOrigin(origin)
}

export function isDefaultApiCorsOrigin(origin: string) {
  try {
    const url = new URL(origin)
    if (url.protocol !== "https:") return false
    return defaultAllowedOrigins.has(url.origin) || trustedIpfsOriginPattern.test(url.hostname)
  } catch {
    return false
  }
}
