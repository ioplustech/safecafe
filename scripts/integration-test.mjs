import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cli = join(process.cwd(), "cli/dist/index.js")
const account = "0xbf3d000000000000000000000000000000008c49"
const validator = "Core Contributors"

function run(args, expected) {
  const output = execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" })
  for (const text of expected) {
    if (!output.includes(text)) {
      throw new Error(`Expected "${text}" in: safecafe ${args.join(" ")}`)
    }
  }
  return output
}

function runNoArgs() {
  const output = execFileSync(process.execPath, [cli], { encoding: "utf8" })
  if (!output.includes("Usage: safecafe")) throw new Error("Expected no-argument CLI call to print help")
}

const workdir = mkdtempSync(join(tmpdir(), "safecafe-cli-"))

try {
  runNoArgs()
  run(["status", "--mock"], ["Safecafe is ready", "SAFE balance"])
  run(["validators", "--mock", "--active"], ["Safenet validators", "Core Contributors"])
  run(["withdrawals", "--mock", "--account", account], ["Pending withdrawals", "Ready to claim"])
  run(["rewards", "--mock", "--account", account], ["Claimable rewards", "Proof status"])
  run(["contracts"], ["SAFE token", "Staking contract", "Rewards contract"])
  run(["guide"], ["safecafe validators", "safecafe stake", "safecafe rewards"])

  run(
    ["stake", "--mock", "--validator", validator, "--amount", "100", "--dry-run"],
    ["Plan: Stake 100 SAFE", "Stake SAFE to validator"],
  )
  run(
    ["unstake", "--mock", "--validator", validator, "--amount", "25", "--dry-run"],
    ["Plan: Unstake 25 SAFE", "Initiate withdrawal from validator"],
  )
  run(["claim-withdrawal", "--mock", "--dry-run"], ["Claim withdrawal", "Claim next FIFO withdrawal"])
  run(["claim-rewards", "--mock", "--account", account, "--dry-run"], ["Claim staking rewards", "Claim Merkle rewards"])

  const payloadPath = join(workdir, "stake-safe.json")
  run(
    ["stake", "--mock", "--validator", validator, "--amount", "10", "--safe-payload", payloadPath],
    ["Safe Transaction Builder payload written"],
  )
  if (!existsSync(payloadPath)) throw new Error("Expected Safe payload file to be written")
  const payload = JSON.parse(readFileSync(payloadPath, "utf8"))
  if (!Array.isArray(payload.transactions) || payload.transactions.length === 0) {
    throw new Error("Expected Safe payload to contain at least one transaction")
  }

  const hiddenCommands = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" })
  for (const oldCommand of ["brew", "cool", "tab", "beans", "collect-withdrawal", "collect-rewards"]) {
    if (hiddenCommands.includes(oldCommand)) {
      throw new Error(`Old command name is still exposed: ${oldCommand}`)
    }
  }

  const signingHelp = [
    hiddenCommands,
    ...["stake", "unstake", "claim-withdrawal", "claim-rewards"].map((command) =>
      execFileSync(process.execPath, [cli, command, "--help"], { encoding: "utf8" }),
    ),
  ].join("\n")
  for (const signingFlag of ["--send", "--private-key-prompt", "--private-key-stdin", "--private-key-env"]) {
    if (!signingHelp.includes(signingFlag)) {
      throw new Error(`Expected advanced signing flag to be exposed: ${signingFlag}`)
    }
  }
  if (signingHelp.includes("--private-key <")) {
    throw new Error("Raw private-key command argument must not be exposed")
  }
} finally {
  rmSync(workdir, { recursive: true, force: true })
}

console.log("CLI integration tests passed")
