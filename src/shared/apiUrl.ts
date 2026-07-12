export const defaultHostedApiBaseUrl = "https://safecafe.baserun.link"

export function apiUrl(path: string, configuredBaseUrl?: string | null): string {
  if (/^https?:\/\//i.test(path)) return path
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  const baseUrl = resolveApiBaseUrl(configuredBaseUrl)
  if (!baseUrl) return normalizedPath
  return `${baseUrl}${normalizedPath}`
}

export function resolveApiBaseUrl(configuredBaseUrl?: string | null): string {
  const explicit = normalizeApiBaseUrl(configuredBaseUrl)
  if (explicit) return explicit

  const hostname = readRuntimeHostname()
  if (isSafecafeStaticFrontendHost(hostname)) return defaultHostedApiBaseUrl
  return ""
}

export function isSafecafeStaticFrontendHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "")
  if (!normalized) return false
  if (normalized.endsWith(".eth.limo") || normalized.endsWith(".limo")) return true
  if (staticIpfsGatewayHosts.has(normalized)) return true
  return staticIpfsGatewaySuffixes.some((suffix) => normalized.endsWith(suffix))
}

const staticIpfsGatewayHosts = new Set(["dweb.link", "ipfs.filebase.io", "ipfs.io"])

const staticIpfsGatewaySuffixes = [".ipfs.dweb.link", ".ipfs.inbrowser.link", ".ipfs.w3s.link", ".ipfs.nftstorage.link"]

function normalizeApiBaseUrl(value?: string | null): string {
  const trimmed = value?.trim()
  if (!trimmed) return ""
  try {
    const url = new URL(trimmed)
    if (url.protocol !== "https:" && url.protocol !== "http:") return ""
    url.pathname = url.pathname.replace(/\/+$/, "")
    url.search = ""
    url.hash = ""
    return url.toString().replace(/\/+$/, "")
  } catch {
    return ""
  }
}

function readRuntimeHostname() {
  const maybeLocation = globalThis.location as { hostname?: unknown } | undefined
  return typeof maybeLocation?.hostname === "string" ? maybeLocation.hostname.toLowerCase() : ""
}
