import { type Address, type Hex, hexToBytes } from "viem"
import { namehash, normalize } from "viem/ens"
import { createSafenetPublicClient } from "../protocol"

export type IpfsReleaseFile = {
  path: string
  sha256: string
  size: number
}

export type IpfsReleaseRecord = {
  build: {
    command: string
    packageManager: string
  }
  commit: string
  contracts: {
    merkleDrop: string
    safeToken: string
    staking: string
  }
  createdAt: string
  dirty: boolean
  files: IpfsReleaseFile[]
  ipfs?: {
    cid: string
    gateways: {
      dweb?: string
      ethLimo?: string
      filebase?: string
      ipfsIo?: string
    }
    uri: string
  }
  name: string
  version: string
}

export type EnsContenthashStatus =
  | "error"
  | "idle"
  | "loading"
  | "matched"
  | "mismatch"
  | "missing"
  | "resolved"
  | "unchecked"
  | "unsupported"

export type EnsContenthashState = {
  cid: string | null
  contenthash: Hex | null
  error: string | null
  namespace: number | null
  resolverAddress: Address | null
  status: EnsContenthashStatus
  uri: string | null
}

export type ReleaseTrustKind = "loading" | "manifest" | "missing" | "record"

export type ReleaseTrustState = {
  ens: EnsContenthashState
  kind: ReleaseTrustKind
  record: IpfsReleaseRecord | null
}

const ipfsNsCode = 0xe3
const ensResolverContenthashAbi = [
  {
    inputs: [{ name: "node", type: "bytes32" }],
    name: "contenthash",
    outputs: [{ name: "", type: "bytes" }],
    stateMutability: "view",
    type: "function",
  },
] as const
const idleEnsState: EnsContenthashState = {
  cid: null,
  contenthash: null,
  error: null,
  namespace: null,
  resolverAddress: null,
  status: "idle",
  uri: null,
}

export const safeStakingEnsName = "safe-staking.eth"
export const safeStakingEthLimoUrl = "https://safe-staking.eth.limo/"
export const sourceRepositoryUrl = "https://github.com/ioplustech/safecafe"

export function createReleaseTrustLoadingState(): ReleaseTrustState {
  return {
    ens: {
      ...idleEnsState,
      status: "loading",
    },
    kind: "loading",
    record: null,
  }
}

export async function readCurrentReleaseTrust(rpcUrl?: string): Promise<ReleaseTrustState> {
  if (!shouldPreferBundledReleaseManifest()) {
    const record = await readReleaseJson("/release-record.json", "/latest.json")
    if (record?.ipfs?.cid) {
      return {
        ens: await readEnsContenthashState(record.ipfs.cid, rpcUrl),
        kind: "record",
        record,
      }
    }
  }

  const manifest = await readReleaseJson("/release-manifest.json")
  return {
    ens: await readEnsContenthashState(null, rpcUrl),
    kind: manifest ? "manifest" : "missing",
    record: manifest,
  }
}

export function compactCid(cid: string) {
  if (cid.length <= 18) return cid
  return `${cid.slice(0, 10)}...${cid.slice(-8)}`
}

export function resolveEnsTrustStatus(expectedCid: string | null, resolvedCid: string | null): EnsContenthashStatus {
  if (!resolvedCid) return expectedCid ? "unsupported" : "unchecked"
  if (!expectedCid) return "resolved"
  return resolvedCid.toLowerCase() === expectedCid.toLowerCase() ? "matched" : "mismatch"
}

export function findReleaseFile(record: IpfsReleaseRecord | null, path: string): IpfsReleaseFile | null {
  return record?.files.find((file) => file.path === path) ?? null
}

async function readEnsContenthashState(expectedCid: string | null, rpcUrl?: string): Promise<EnsContenthashState> {
  try {
    const client = createSafenetPublicClient(rpcUrl ? { rpcUrl } : undefined)
    const name = normalize(safeStakingEnsName)
    const resolverAddress = await client.getEnsResolver({ name })
    if (!resolverAddress) return { ...idleEnsState, status: expectedCid ? "missing" : "unchecked" }

    const contenthash = (await client.readContract({
      abi: ensResolverContenthashAbi,
      address: resolverAddress,
      args: [namehash(name)],
      functionName: "contenthash",
    })) as Hex

    if (!contenthash || contenthash === "0x") {
      return {
        ...idleEnsState,
        resolverAddress,
        status: expectedCid ? "missing" : "unchecked",
      }
    }

    const decoded = decodeEnsContenthash(contenthash)
    if (!decoded) {
      return {
        ...idleEnsState,
        contenthash,
        resolverAddress,
        status: "missing",
      }
    }

    const baseState: EnsContenthashState = {
      cid: decoded.cid,
      contenthash,
      error: null,
      namespace: decoded.namespace,
      resolverAddress,
      status: "unchecked",
      uri: decoded.uri,
    }

    return { ...baseState, status: resolveEnsTrustStatus(expectedCid, decoded.cid) }
  } catch (error) {
    return {
      ...idleEnsState,
      error: error instanceof Error ? error.message : "Unable to verify ENS contenthash.",
      status: "error",
    }
  }
}

function decodeEnsContenthash(contenthash: Hex): { cid: string | null; namespace: number; uri: string | null } | null {
  const bytes = hexToBytes(contenthash)
  if (!bytes.length) return null
  const prefix = decodeVarint(bytes)
  if (!prefix) return null
  const payload = bytes.slice(prefix.bytesRead)
  if (!payload.length) return { cid: null, namespace: prefix.value, uri: null }
  if (prefix.value !== ipfsNsCode) return { cid: null, namespace: prefix.value, uri: null }
  const cid = encodeBase32Multibase(payload)
  return { cid, namespace: prefix.value, uri: `ipfs://${cid}` }
}

function decodeVarint(bytes: Uint8Array) {
  let value = 0
  let shift = 0
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { bytesRead: index + 1, value }
    shift += 7
  }
  return null
}

function shouldPreferBundledReleaseManifest() {
  const hostname = globalThis.location?.hostname ?? ""
  return (
    hostname === "safe-staking.eth.limo" ||
    hostname.endsWith(".eth.limo") ||
    hostname.includes(".ipfs.") ||
    hostname === "ipfs.filebase.io"
  )
}

function encodeBase32Multibase(bytes: Uint8Array) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567"
  let buffer = 0
  let bits = 0
  let output = "b"

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += alphabet[(buffer >>> (bits - 5)) & 0x1f] ?? ""
      bits -= 5
      buffer &= (1 << bits) - 1
    }
  }

  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 0x1f] ?? ""
  return output
}

async function readReleaseJson(...paths: string[]): Promise<IpfsReleaseRecord | null> {
  for (const path of paths) {
    try {
      const response = await fetch(path, { cache: "no-store" })
      if (!response.ok) continue
      const record = normalizeReleaseRecord(await response.json())
      if (record) return record
    } catch {}
  }
  return null
}

function normalizeReleaseRecord(input: unknown): IpfsReleaseRecord | null {
  if (!input || typeof input !== "object") return null
  const record = input as Partial<IpfsReleaseRecord>
  if (!record.build || !record.contracts || !Array.isArray(record.files)) return null
  if (
    typeof record.name !== "string" ||
    typeof record.version !== "string" ||
    typeof record.commit !== "string" ||
    typeof record.createdAt !== "string"
  ) {
    return null
  }
  return {
    build: record.build,
    commit: record.commit,
    contracts: record.contracts,
    createdAt: record.createdAt,
    dirty: record.dirty === true,
    files: record.files,
    ipfs: record.ipfs,
    name: record.name,
    version: record.version,
  }
}
