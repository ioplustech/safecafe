import { spawnSync } from "node:child_process"

const passthroughArgs = process.argv.slice(2)
const command = process.env.SAFECAFE_CLI_COMMAND ?? "tsx"
const entry = process.env.SAFECAFE_CLI_ENTRY ?? "cli/index.ts"
const commandArgs = [entry, ...passthroughArgs]

const result = spawnSync(command, commandArgs, {
  stdio: "inherit",
  shell: process.platform === "win32",
})

if (result.error) {
  console.error(result.error.message)
}

// This wrapper is for package-manager convenience scripts. Exiting non-zero
// makes pnpm append ELIFECYCLE, which looks like an internal CLI crash.
process.exit(0)
