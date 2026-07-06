import fs from "node:fs"
import util from "node:util"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ethers } from "ethers"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_PATH = path.join(__dirname, "getChainList.json")
const getChainList = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"))
const chains = getChainList.chains

const colors = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  bgRedLight: "\x1b[41;37m",
  bgGreenLight: "\x1b[42;37m",
}

const logger = {
  green: (...args) => console.log(colors.green + colors.bold + "✔", formatArgs(args), colors.reset),
  warn: (...args) => console.log(colors.yellow + colors.bold + "⚠", formatArgs(args), colors.reset),
  error: (...args) => console.log(colors.red + colors.bold + colors.bgRedLight + "✖", formatArgs(args), colors.reset),
  success: (...args) =>
    console.log(colors.green + colors.bold + colors.bgGreenLight + "✔", formatArgs(args), colors.reset),
}

function formatArgs(args) {
  return args
    .map((arg) => {
      if (arg === null) return "null"
      if (arg === undefined) return "undefined"
      if (typeof arg !== "object") return String(arg)
      return util.inspect(arg, { colors: true, depth: null, breakLength: Infinity })
    })
    .join(" ")
}

const getNetworkName = (name) => {
  const n = name.toLowerCase()
  if (n.includes("sepolia")) return "Ethereum Sepolia"
  if (n.includes("hoodi")) return "Ethereum Hoodi"
  if (n.includes("holesky") || n.includes("hole")) return "Holesky"
  if (n.includes("stable")) return "Stable Testnet"
  if (n.includes("gnosis")) return "Gnosis"
  if (n.includes("ethereum")) return "Ethereum Mainnet"
  return ""
}

const rpcBuilder = (rpc) => {
  if (ethers.JsonRpcProvider) {
    return new ethers.JsonRpcProvider(rpc)
  }
  return new ethers.providers.JsonRpcProvider(rpc)
}

async function testRpc(chain) {
  const { name, rpc: rpcList } = chain
  logger.green(` Testing ${name} ${rpcList.length} rpcs!`)

  const updatedRpcList = await Promise.all(
    rpcList.map(async (rpc) => {
      // chainid.network returns strings; normalize to {url} objects
      const entry = typeof rpc === "string" ? { url: rpc } : rpc
      // skip rpcs with template variables (e.g. ${INFURA_API_KEY})
      if (entry.url.includes("${")) {
        return { ...entry, status: "invalid" }
      }
      try {
        const provider = rpcBuilder(entry.url)
        await Promise.race([
          provider.getBlockNumber(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
        ])
        delete entry.status
      } catch (error) {
        logger.warn(`${name} ${entry.url} is invalid: ${error.message}`)
        entry.status = "invalid"
      }
      return entry
    }),
  )

  const validCount = updatedRpcList.filter((rpc) => rpc.status !== "invalid").length
  logger.green(`${name} ${validCount} valid rpcs!`)
  return updatedRpcList
}

function saveChainList() {
  fs.writeFileSync(DATA_PATH, JSON.stringify({ chains }, null, 2))
  logger.green("Chain list saved!")
}

async function main() {
  const fromChainArg = process.argv.find((arg) => arg.includes("from"))
  if (!fromChainArg) {
    logger.error("Please provide from parameter (e.g., from=sepolia)")
    return
  }

  const from = fromChainArg.split("=")[1]
  const name = getNetworkName(from)
  if (!name) {
    logger.error("No network name found")
    return
  }

  const chain = chains.find((c) => c.name === name)
  if (!chain) {
    logger.error(`Chain not found for network: ${name}`)
    return
  }

  chain.rpc = await testRpc(chain)
  saveChainList()
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error)
    process.exit(1)
  })
