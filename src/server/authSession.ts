import {
  type Address,
  createPublicClient,
  fallback,
  getAddress,
  hashMessage,
  http,
  isAddress,
  verifyMessage,
} from "viem"
import { erc1271Abi } from "../protocol/abi"
import { ethereumMainnet } from "../protocol/chains"
import { CHAIN_ID } from "../protocol/contracts"
import { type AccessStrategy, allowAllWallets, rpcStrategy } from "./accessStrategy"
import { rpcUrls } from "./rpcUpstream"
import type { RpcGatewayEnv } from "./serverEnv"

export type SessionPayload = {
  address?: Address
  signer: Address
  subject: Address
  subjectKind: "self" | "safe"
  chainId: number
  exp: number
  iat: number
  strategy: AccessStrategy
}

export type ChallengePayload = {
  signer?: Address
  address?: Address
  subject?: Address
  subjectKind?: "self" | "safe"
  chainId: number
  exp: number
  iat: number
  messageHash?: `0x${string}`
  nonce: string
}

export const authTtlSeconds = 60 * 60
export const challengeTtlSeconds = 5 * 60

export function accountSubjectKind(signer: Address, subject: Address): SessionPayload["subjectKind"] {
  return signer.toLowerCase() === subject.toLowerCase() ? "self" : "safe"
}

export function createAuthMessage(input: {
  signer: Address
  subject: Address
  subjectKind: SessionPayload["subjectKind"]
  chainId: number
  domain: string
  expirationTime: string
  issuedAt: string
  nonce: string
  strategy: AccessStrategy
}) {
  return `${input.domain} wants you to sign in with your Ethereum account:
${input.signer}

Sign in to SafeCafe RPC Gateway.

URI: https://${input.domain}
Version: 1
Chain ID: ${input.chainId}
Nonce: ${input.nonce}
Issued At: ${input.issuedAt}
Expiration Time: ${input.expirationTime}
Staking Subject: ${input.subject}
Subject Kind: ${input.subjectKind}
Strategy: ${input.strategy}`
}

export async function createChallengeToken(
  input: {
    chainId: number
    exp: number
    iat: number
    messageHash: `0x${string}`
    nonce: string
    signer: Address
    subject: Address
    subjectKind: SessionPayload["subjectKind"]
  },
  env: RpcGatewayEnv,
) {
  return signToken(input, env)
}

export async function verifyChallengeToken(token: string, env: RpcGatewayEnv) {
  return verifyToken<ChallengePayload>(token, env)
}

export async function createSessionToken(session: SessionPayload, env: RpcGatewayEnv) {
  return signToken(session, env)
}

export async function readRpcSession(request: Request, env: RpcGatewayEnv) {
  const raw = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!raw) return null
  const payload = await verifyToken<SessionPayload>(raw, env)
  if (!payload || payload.chainId !== CHAIN_ID) return null
  const signer = payload.signer ?? payload.address
  const subject = payload.subject ?? signer
  if (!signer || !subject) return null
  if (payload.strategy !== "safe-staking-access" && payload.strategy !== "signed-wallet-access") return null
  if (!allowAllWallets(env) && payload.strategy !== "safe-staking-access") return null
  return { ...payload, signer, subject, subjectKind: payload.subjectKind ?? accountSubjectKind(signer, subject) }
}

export async function verifyWalletSignature(input: {
  address: Address
  env: RpcGatewayEnv
  message: string
  signature: `0x${string}`
}) {
  if (await verifyMessage({ address: input.address, message: input.message, signature: input.signature })) return true
  try {
    const client = createPublicClient({
      chain: ethereumMainnet,
      transport: fallback((await rpcUrls(input.env)).map((url) => http(url, { timeout: 8_000 }))),
    })
    const magicValue = await client.readContract({
      address: input.address,
      abi: erc1271Abi,
      functionName: "isValidSignature",
      args: [hashMessage(input.message), input.signature],
    })
    return magicValue.toLowerCase() === "0x1626ba7e"
  } catch {
    return false
  }
}

export function canUseAuthSecret(env: RpcGatewayEnv) {
  return Boolean(env.SAFECAFE_AUTH_SECRET || isLocalDevRuntime())
}

export function readAddress(value: unknown, key: string): Address | null {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null
  return typeof raw === "string" && isAddress(raw) ? getAddress(raw) : null
}

async function signToken(payload: Record<string, unknown>, env: RpcGatewayEnv) {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  const signature = await hmac(`${encodedPayload}`, authSecret(env))
  return `${encodedPayload}.${signature}`
}

async function verifyToken<T extends { exp?: number }>(token: string, env: RpcGatewayEnv): Promise<T | null> {
  const [encodedPayload, signature] = token.split(".")
  if (!encodedPayload || !signature) return null
  const expected = await hmac(encodedPayload, authSecret(env))
  if (!constantEqual(signature, expected)) return null
  const payload = JSON.parse(base64UrlDecode(encodedPayload)) as T
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null
  return payload
}

async function hmac(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))
  return base64UrlEncode(new Uint8Array(signature))
}

function authSecret(env: RpcGatewayEnv) {
  if (env.SAFECAFE_AUTH_SECRET) return env.SAFECAFE_AUTH_SECRET
  if (isLocalDevRuntime()) return "safecafe-dev-auth-secret"
  throw new Error("SAFECAFE_AUTH_SECRET is required.")
}

function isLocalDevRuntime() {
  const maybeGlobal = globalThis as { location?: { hostname?: unknown } }
  const host = typeof maybeGlobal.location?.hostname === "string" ? maybeGlobal.location.hostname : undefined
  if (host === "localhost" || host === "127.0.0.1") return true
  return typeof process !== "undefined" && process.env.NODE_ENV === "test"
}

function constantEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return diff === 0
}

function base64UrlEncode(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function base64UrlDecode(value: string) {
  const normalized = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=")
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new TextDecoder().decode(bytes)
}

export const authSessionTestHooks = {
  createAuthMessage,
  rpcStrategy,
}
