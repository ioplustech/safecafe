import { createPublicClient, fallback, http, type PublicClient } from "viem"
import { ethereumMainnet } from "./chains"
import { DEFAULT_RPC_URLS } from "./contracts"

export type SafenetPublicClientOptions = {
  authToken?: string | null
  rpcUrl?: string
}

export function createSafenetPublicClient(options?: SafenetPublicClientOptions | string): PublicClient {
  const normalized = typeof options === "string" ? { rpcUrl: options } : (options ?? {})
  const useGateway = normalized.authToken || (normalized.rpcUrl && isSafecafeRpcGatewayUrl(normalized.rpcUrl))
  const gatewayTransport = useGateway
    ? http("/api/rpc/ethereum", {
        fetchOptions: normalized.authToken
          ? { headers: { authorization: `Bearer ${normalized.authToken}` } }
          : undefined,
      })
    : null
  const publicRpcUrl = normalized.rpcUrl && !isSafecafeRpcGatewayUrl(normalized.rpcUrl) ? normalized.rpcUrl : undefined
  const transports = publicRpcUrl ? [http(publicRpcUrl)] : DEFAULT_RPC_URLS.map((url) => http(url))
  return createPublicClient({
    chain: ethereumMainnet,
    transport: gatewayTransport ?? fallback(transports),
  })
}

function isSafecafeRpcGatewayUrl(rpcUrl: string) {
  try {
    return new URL(rpcUrl, "http://localhost").pathname.replace(/\/+$/, "") === "/api/rpc/ethereum"
  } catch {
    return false
  }
}
