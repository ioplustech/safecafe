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

export type ReleaseTrustState =
  | { kind: "loading"; record: null }
  | { kind: "missing"; record: null }
  | { kind: "manifest" | "record"; record: IpfsReleaseRecord }

export const safeStakingEnsName = "safe-staking.eth"
export const safeStakingEthLimoUrl = "https://safe-staking.eth.limo/"

export async function readCurrentReleaseTrust(): Promise<ReleaseTrustState> {
  const record = await readReleaseJson("/release-record.json", "/latest.json")
  if (record?.ipfs?.cid) return { kind: "record", record }
  const manifest = await readReleaseJson("/release-manifest.json")
  return manifest ? { kind: "manifest", record: manifest } : { kind: "missing", record: null }
}

export function compactCid(cid: string) {
  if (cid.length <= 18) return cid
  return `${cid.slice(0, 10)}...${cid.slice(-8)}`
}

export function findReleaseFile(record: IpfsReleaseRecord | null, path: string): IpfsReleaseFile | null {
  return record?.files.find((file) => file.path === path) ?? null
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
