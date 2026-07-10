import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cli = join(process.cwd(), "cli/dist/index.js")
const account = "0xbf3d000000000000000000000000000000008c49"
const validator = "Core Contributors"
const workdir = mkdtempSync(join(tmpdir(), "safecafe-cli-"))
const sessionEnv = {
  ...process.env,
  SAFECAFE_CLI_SESSION_DIR: join(workdir, "sessions"),
}

function run(args, expected) {
  const output = execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", env: sessionEnv })
  for (const text of expected) {
    if (!output.includes(text)) {
      throw new Error(`Expected "${text}" in: safecafe ${args.join(" ")}`)
    }
  }
  return output
}

function runNoArgs() {
  const output = execFileSync(process.execPath, [cli], { encoding: "utf8", env: sessionEnv })
  if (!output.includes("Usage: safecafe")) throw new Error("Expected no-argument CLI call to print help")
}

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

  run(
    ["agent", "--mock", "--prompt", "stake 10 SAFE to Core Contributors"],
    ["Agent intent: stake", "Executable now", "Stake 10 SAFE"],
  )
  run(["agent", "--mock", "--prompt", "show my staking status"], ["Live staking summary", "SAFE balance"])
  run(["agent", "--mock", "--prompt", "stake 10 SAFE"], ["Which validator should receive this stake?"])
  run(
    ["agent", "--mock", "--prompt", "to Core Contributors"],
    ["Agent intent: stake", "Executable now", "Stake 10 SAFE"],
  )
  run(["agent", "--mock", "--refresh"], ["Agent intent: stake", "Executable now"])
  run(["agent", "--mock", "--resume"], ["Agent intent: stake", "Executable now"])
  run(["agent", "--mock", "--cancel"], ["Last Agent conversation cleared."])

  const hiddenCommands = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8", env: sessionEnv })
  for (const oldCommand of ["brew", "cool", "tab", "beans", "collect-withdrawal", "collect-rewards"]) {
    if (hiddenCommands.includes(oldCommand)) {
      throw new Error(`Old command name is still exposed: ${oldCommand}`)
    }
  }

  const signingHelp = [
    hiddenCommands,
    ...["stake", "unstake", "claim-withdrawal", "claim-rewards", "agent"].map((command) =>
      execFileSync(process.execPath, [cli, command, "--help"], { encoding: "utf8", env: sessionEnv }),
    ),
  ].join("\n")
  for (const signingFlag of [
    "--send",
    "--signer",
    "--private-key-prompt",
    "--private-key-stdin",
    "--private-key-env",
    "--resume",
  ]) {
    if (!signingHelp.includes(signingFlag)) {
      throw new Error(`Expected advanced signing flag to be exposed: ${signingFlag}`)
    }
  }
  if (signingHelp.includes("--session")) {
    throw new Error("Legacy session flag should no longer be exposed")
  }
  if (signingHelp.includes("--continue")) {
    throw new Error("Legacy continue flag should no longer be exposed")
  }
  if (signingHelp.includes("--private-key <")) {
    throw new Error("Raw private-key command argument must not be exposed")
  }
  if (signingHelp.includes("--safe-payload")) {
    throw new Error("Safe payload export should no longer be exposed")
  }
} finally {
  rmSync(workdir, { recursive: true, force: true })
}

console.log("CLI integration tests passed")
