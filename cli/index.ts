import { Command } from "commander"
import { SAFECAFE_VERSION } from "../src/shared/version"
import { registerCommands } from "./commands"

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
