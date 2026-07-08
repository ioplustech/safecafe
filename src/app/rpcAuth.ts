import type { Address } from "viem"
import { CHAIN_ID } from "../protocol"
import { appStorageKeys, readStorageJson, removeStorageValue, writeStorageJson } from "./persistence"
import type { WalletIdentity } from "./walletIdentity"

type StoredRpcSession = {
  address: Address
  expiresAt: number
  signer: Address
  subject: Address
  subjectKind: WalletIdentity["subjectKind"]
  token: string
}

type ChallengeResponse = {
  challenge: string
  message: string
}

type VerifyResponse = {
  address: Address
  expiresAt: number
  signer: Address
  subject: Address
  subjectKind: WalletIdentity["subjectKind"]
  token: string
}

export function readRpcSession(identity: WalletIdentity | Address | null): StoredRpcSession | null {
  const normalized = normalizeIdentity(identity)
  if (!normalized.signer || !normalized.subject) return null
  const signer = normalized.signer
  const subject = normalized.subject
  return readStorageJson(appStorageKeys.rpcSession, (value) => {
    const parsed = value as Partial<StoredRpcSession> | null
    if (!parsed?.token || !parsed.expiresAt) return null
    const parsedSigner = parsed.signer ?? parsed.address
    const parsedSubject = parsed.subject ?? parsedSigner
    if (!parsedSigner || !parsedSubject) return null
    if (parsedSigner.toLowerCase() !== signer.toLowerCase()) return null
    if (parsedSubject.toLowerCase() !== subject.toLowerCase()) return null
    if (parsed.expiresAt <= Math.floor(Date.now() / 1000) + 30) return null
    return {
      address: parsed.address ?? parsedSigner,
      expiresAt: parsed.expiresAt,
      signer: parsedSigner,
      subject: parsedSubject,
      subjectKind: parsed.subjectKind ?? normalized.subjectKind,
      token: parsed.token,
    }
  })
}

export function clearRpcSession() {
  removeStorageValue(appStorageKeys.rpcSession)
}

export async function ensureRpcSession(
  identity: WalletIdentity | Address,
  ethereum: EthereumProvider,
): Promise<StoredRpcSession | null> {
  const normalized = normalizeIdentity(identity)
  if (!normalized.signer || !normalized.subject) return null
  const cached = readRpcSession(normalized)
  if (cached) return cached
  const challengeResponse = await fetch("/api/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: CHAIN_ID, signer: normalized.signer, subject: normalized.subject }),
  })
  if (!challengeResponse.ok) throw await readRpcAuthError(challengeResponse)
  const challenge = (await challengeResponse.json()) as ChallengeResponse
  const signature = (await ethereum.request({
    method: "personal_sign",
    params: [challenge.message, normalized.signer],
  })) as string
  const verifyResponse = await fetch("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challenge: challenge.challenge,
      message: challenge.message,
      signature,
      signer: normalized.signer,
      subject: normalized.subject,
    }),
  })
  if (!verifyResponse.ok) throw await readRpcAuthError(verifyResponse)
  const session = (await verifyResponse.json()) as StoredRpcSession
  writeStorageJson(appStorageKeys.rpcSession, session satisfies VerifyResponse)
  return session
}

async function readRpcAuthError(response: Response) {
  try {
    const body = (await response.json()) as { code?: unknown; error?: unknown; requestId?: unknown }
    const message = typeof body.error === "string" ? body.error : `RPC authentication failed: ${response.status}`
    const code = typeof body.code === "string" ? body.code : ""
    const requestId = typeof body.requestId === "string" ? body.requestId : ""
    return new Error(
      [message, code ? `(${code})` : "", requestId ? `request ${requestId}` : ""].filter(Boolean).join(" "),
    )
  } catch {
    return new Error(`RPC authentication failed: ${response.status}`)
  }
}

function normalizeIdentity(identity: WalletIdentity | Address | null): WalletIdentity {
  if (typeof identity === "string") {
    return { signer: identity, subject: identity, subjectKind: "self" }
  }
  return identity ?? { signer: null, subject: null, subjectKind: "self" }
}
