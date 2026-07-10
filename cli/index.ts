import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Command } from "commander"
import { SAFECAFE_VERSION } from "../src/shared/version"
import { registerCommands } from "./commands"

loadDotEnv()

const program = new Command()

program
  .name("safecafe")
  .description("Guided non-custodial Safenet staking CLI")
  .version(SAFECAFE_VERSION)
  .option("--rpc <url>", "Ethereum RPC URL")
  .option("--json", "Output machine-readable JSON")
  .option("--mock", "Use bundled sample data")
  .showHelpAfterError("(use --help for Safecafe commands)")

registerCommands(program)

if (process.argv.length <= 2) {
  program.outputHelp()
  process.exit(0)
}

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

function loadDotEnv() {
  const path = join(process.cwd(), ".env")
  if (!existsSync(path)) return
  const source = readFileSync(path, "utf8")
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const equalsIndex = trimmed.indexOf("=")
    if (equalsIndex <= 0) continue
    const key = trimmed.slice(0, equalsIndex).trim()
    if (!key || process.env[key] !== undefined) continue
    const rawValue = trimmed.slice(equalsIndex + 1).trim()
    process.env[key] = unquoteEnvValue(rawValue)
  }
}

function unquoteEnvValue(value: string) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}
