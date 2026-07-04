import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { ObjectManager } from "@filebase/sdk"

const distDir = join(process.cwd(), "dist")
const releasesPath = join(process.cwd(), "IPFS_RELEASES.md")
const cloudflareDocPath = join(process.cwd(), "CLOUDFLARE.md")
const readmePath = join(process.cwd(), "README.md")
const releaseRecordsDir = join(process.cwd(), "releases", "ipfs")
const managedReleaseFiles = new Set(["release-manifest.json", "release-record.json"])
const env = loadEnv()
const args = new Set(process.argv.slice(2))

if (args.has("--sync-records") || args.has("--sync-records-from-dist")) {
  const { manifest, sourcePath } = loadReleaseRecordForSync()
  updateReleaseArtifacts(manifest)
  console.log(`Synced IPFS release records from ${sourcePath}`)
  process.exit(0)
}

const config = {
  accessToken: requiredEnv("FILEBASE_ACCESS_TOKEN"),
  secretKey: requiredEnv("FILEBASE_SECRET_KEY"),
  bucket: env.FILEBASE_BUCKET || "safecafe",
  releaseKeyPrefix: env.FILEBASE_RELEASE_KEY_PREFIX || "releases",
}

if (!args.has("--skip-build")) {
  run("pnpm", ["build:web"])
}

if (!existsSync(distDir)) {
  throw new Error("dist/ does not exist. Run pnpm build:web first or omit --skip-build.")
}

const buildFiles = (await listFiles(distDir)).filter((file) => !managedReleaseFiles.has(file.key))
if (!buildFiles.some((file) => file.key === "index.html")) {
  throw new Error("dist/index.html is missing. Refusing to publish an incomplete web build.")
}

const baseManifest = createManifest(buildFiles)
const releaseManifestPath = join(distDir, "release-manifest.json")
writeFileSync(releaseManifestPath, JSON.stringify(baseManifest, null, 2))

const filesWithManifest = [
  ...buildFiles,
  {
    key: "release-manifest.json",
    path: releaseManifestPath,
    size: statSync(releaseManifestPath).size,
  },
].sort((a, b) => a.key.localeCompare(b.key))
const objectManager = new ObjectManager(config.accessToken, config.secretKey, {
  bucket: config.bucket,
  maxConcurrentUploads: Number(env.FILEBASE_UPLOAD_CONCURRENCY || 6),
})

const releaseKey = `${config.releaseKeyPrefix}/${baseManifest.name}-${baseManifest.version}-${Date.now()}.car`
console.log(`Publishing ${filesWithManifest.length} files from dist/ as an IPFS directory CAR`)
console.log(`Filebase bucket: ${config.bucket}`)
console.log(`Release object:  ${releaseKey}`)
const source = filesWithManifest.map((file) => ({
  path: file.key,
  content: readFileSync(file.path),
}))
let uploadResult
try {
  uploadResult = await objectManager.upload(releaseKey, source, {
    application: "safecafe",
    version: baseManifest.version,
    commit: baseManifest.commit,
  })
} catch (error) {
  if (isAwsError(error, "NoSuchBucket")) {
    throw new Error(
      `Filebase bucket "${config.bucket}" does not exist. Create an IPFS bucket with this name or set FILEBASE_BUCKET in .env.`,
    )
  }
  if (isAwsError(error, "AccountProblem")) {
    throw new Error(
      "Filebase rejected the upload for this account. Directory CAR upload should avoid direct HTML uploads; if this still fails, verify your bucket is an IPFS bucket and your Filebase plan allows IPFS uploads.",
    )
  }
  throw error
}

const cid = uploadResult.cid
const releaseRecord = {
  ...baseManifest,
  ipfs: {
    cid,
    uri: `ipfs://${cid}`,
    gateways: {
      filebase: `https://ipfs.filebase.io/ipfs/${cid}/`,
      ipfsIo: `https://ipfs.io/ipfs/${cid}/`,
      dweb: `https://${cid}.ipfs.dweb.link/`,
      ethLimo: "https://safe-staking.eth.limo/",
    },
  },
}
writeFileSync(join(distDir, "release-record.json"), JSON.stringify(releaseRecord, null, 2))
updateReleaseArtifacts(releaseRecord)

console.log("")
console.log("IPFS publish complete")
console.log(`CID:        ${cid}`)
console.log(`URI:        ipfs://${cid}`)
console.log(`Filebase:   https://ipfs.filebase.io/ipfs/${cid}/`)
console.log(`dweb.link:  https://${cid}.ipfs.dweb.link/`)
console.log("")
console.log("Next ENS step:")
console.log(`Set safe-staking.eth contenthash to ipfs://${cid}`)
console.log("")
console.log("Release manifest:")
console.log("dist/release-manifest.json")
console.log("Release record:")
console.log("dist/release-record.json")
console.log("releases/ipfs/latest.json")
console.log("Updated docs:")
console.log("IPFS_RELEASES.md")
console.log("CLOUDFLARE.md")
console.log("README.md")

function loadEnv() {
  const result = { ...process.env }
  if (!existsSync(".env")) return result

  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    const [, key, rawValue] = match
    if (result[key]) continue
    result[key] = unquote(rawValue.trim())
  }
  return result
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function requiredEnv(name) {
  const value = env[name]
  if (!value) throw new Error(`Missing ${name}. Add it to .env or the shell environment.`)
  return value
}

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" })
}

async function listFiles(root) {
  const entries = []
  await walk(root, entries)
  return entries.sort((a, b) => a.key.localeCompare(b.key))
}

async function walk(dir, entries) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(fullPath, entries)
      continue
    }
    if (!entry.isFile()) continue
    entries.push({
      key: relative(distDir, fullPath).replaceAll("\\", "/"),
      path: fullPath,
      size: statSync(fullPath).size,
    })
  }
}

function createManifest(files) {
  const commit = git(["rev-parse", "HEAD"])
  const status = git(["status", "--short"])
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"))
  return {
    name: packageJson.name,
    version: packageJson.version,
    createdAt: new Date().toISOString(),
    commit,
    dirty: status.length > 0,
    build: {
      command: "pnpm build:web",
      packageManager: packageJson.packageManager,
    },
    contracts: {
      safeToken: "0x5aFE3855358E112B5647B952709E6165e1c1eEEe",
      staking: "0x115E78f160e1E3eF163B05C84562Fa16fA338509",
      merkleDrop: "0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2",
    },
    files: files.map((file) => ({
      path: file.key,
      size: file.size,
      sha256: sha256(file.path),
    })),
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim()
}

function isAwsError(error, code) {
  return typeof error === "object" && error !== null && "Code" in error && error.Code === code
}

function updateReleaseArtifacts(manifest) {
  writeReleaseRecords(manifest)
  updateReleaseRegistry(manifest)
  updateCloudflareLatestRelease(manifest)
  updateReadmeLatestRelease(manifest)
}

function loadReleaseRecordForSync() {
  const candidates = [
    join(distDir, "release-record.json"),
    join(distDir, "release-manifest.json"),
    join(releaseRecordsDir, "latest.json"),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const manifest = JSON.parse(readFileSync(candidate, "utf8"))
    if (manifest.ipfs?.cid) return { manifest, sourcePath: relative(process.cwd(), candidate) }
  }
  throw new Error(
    "No IPFS release record found. Run pnpm ipfs:publish first, or keep releases/ipfs/latest.json in the repo.",
  )
}

function writeReleaseRecords(manifest) {
  mkdirSync(releaseRecordsDir, { recursive: true })
  const content = `${JSON.stringify(manifest, null, 2)}\n`
  writeFileSync(join(releaseRecordsDir, `${manifest.ipfs.cid}.json`), content)
  writeFileSync(join(releaseRecordsDir, "latest.json"), content)
}

function updateReleaseRegistry(manifest) {
  const header = [
    "# Safecafe IPFS Releases",
    "",
    "This file is updated by `pnpm ipfs:publish` after a successful Filebase/IPFS release.",
    "",
    "Set `safe-staking.eth` ENS contenthash to the latest `ipfs://...` URI after verifying the gateway links.",
    "",
    "| Published | Version | Commit | Dirty | CID | URI | Filebase | dweb.link | Manifest |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ]
  const current = existsSync(releasesPath) ? readFileSync(releasesPath, "utf8") : `${header.join("\n")}\n`
  const existingRows = current
    .split(/\r?\n/)
    .filter((line) => line.startsWith("| ") && !line.includes("---") && !line.includes(" Published "))
  const nextRow = releaseTableRow(manifest)
  const rows = [nextRow, ...existingRows.filter((line) => !line.includes(manifest.ipfs.cid))]
  writeFileSync(releasesPath, `${header.join("\n")}\n${rows.join("\n")}\n`)
}

function releaseTableRow(manifest) {
  const shortCommit = manifest.commit.slice(0, 12)
  const uri = manifest.ipfs.uri
  const filebase = manifest.ipfs.gateways.filebase
  const dweb = manifest.ipfs.gateways.dweb
  const manifestUrl = `${filebase}release-manifest.json`
  return [
    manifest.createdAt,
    manifest.version,
    shortCommit,
    manifest.dirty ? "yes" : "no",
    manifest.ipfs.cid,
    `[ipfs](${uri})`,
    `[filebase](${filebase})`,
    `[dweb](${dweb})`,
    `[manifest](${manifestUrl})`,
  ]
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |")
}

function updateCloudflareLatestRelease(manifest) {
  if (!existsSync(cloudflareDocPath)) return
  const start = "<!-- ipfs-latest:start -->"
  const end = "<!-- ipfs-latest:end -->"
  const block = [
    start,
    "## Latest IPFS Release",
    "",
    `- Version: \`${manifest.version}\``,
    `- Commit: \`${manifest.commit}\``,
    `- Dirty build: \`${manifest.dirty ? "yes" : "no"}\``,
    `- CID: \`${manifest.ipfs.cid}\``,
    `- ENS contenthash: \`${manifest.ipfs.uri}\``,
    `- Filebase: ${manifest.ipfs.gateways.filebase}`,
    `- dweb.link: ${manifest.ipfs.gateways.dweb}`,
    `- Build manifest: ${manifest.ipfs.gateways.filebase}release-manifest.json`,
    "- Release record: [releases/ipfs/latest.json](releases/ipfs/latest.json)",
    "",
    "After verifying the links, set `safe-staking.eth` contenthash to the ENS contenthash above.",
    end,
  ].join("\n")
  const current = readFileSync(cloudflareDocPath, "utf8")
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`)
  const next = pattern.test(current)
    ? current.replace(pattern, block)
    : current.replace("## Local Cloudflare Preview", `${block}\n\n## Local Cloudflare Preview`)
  writeFileSync(cloudflareDocPath, next)
}

function updateReadmeLatestRelease(manifest) {
  if (!existsSync(readmePath)) return
  const start = "<!-- ipfs-latest:start -->"
  const end = "<!-- ipfs-latest:end -->"
  const block = [
    start,
    "## Latest IPFS Release",
    "",
    `- CID: \`${manifest.ipfs.cid}\``,
    `- ENS contenthash: \`${manifest.ipfs.uri}\``,
    `- Filebase: ${manifest.ipfs.gateways.filebase}`,
    "- Release record: [releases/ipfs/latest.json](releases/ipfs/latest.json)",
    "",
    end,
  ].join("\n")
  const current = readFileSync(readmePath, "utf8")
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`)
  const next = pattern.test(current)
    ? current.replace(pattern, block)
    : current.replace("## Resilience", `${block}\n\n## Resilience`)
  writeFileSync(readmePath, next)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
