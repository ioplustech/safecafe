import { execFileSync, spawn } from "node:child_process"

const previewPort = 4173
const baseUrl = `http://127.0.0.1:${previewPort}`

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForServer(processHandle) {
  const deadline = Date.now() + 15_000
  let lastError
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Preview server exited early with code ${processHandle.exitCode}`)
    }
    try {
      const response = await fetch(baseUrl)
      if (response.ok) return
    } catch (error) {
      lastError = error
    }
    await wait(300)
  }
  throw lastError ?? new Error("Preview server did not become ready")
}

async function expectRoute(path, expectedText) {
  const response = await fetch(`${baseUrl}${path}`)
  if (!response.ok) throw new Error(`Expected ${path} to respond with 2xx, got ${response.status}`)
  const html = await response.text()
  if (!html.includes(expectedText)) throw new Error(`Expected ${path} HTML to contain ${expectedText}`)
}

const preview = spawn(
  "pnpm",
  ["preview", "--host", "127.0.0.1", "--port", String(previewPort)],
  { stdio: ["ignore", "pipe", "pipe"] },
)

let logs = ""
preview.stdout.on("data", (chunk) => {
  logs += chunk.toString()
})
preview.stderr.on("data", (chunk) => {
  logs += chunk.toString()
})

try {
  await waitForServer(preview)
  await expectRoute("/", "Safecafe")
  await expectRoute("/stake", "Safecafe")
  await expectRoute("/operators", "Safecafe")
  await expectRoute("/rewards", "Safecafe")

  const help = execFileSync(process.execPath, ["cli/dist/index.js", "--help"], { encoding: "utf8" })
  for (const command of ["operators", "stake", "unstake", "withdrawals", "rewards", "claim-withdrawal", "claim-rewards"]) {
    if (!help.includes(command)) throw new Error(`Expected CLI help to expose ${command}`)
  }
} finally {
  preview.kill("SIGTERM")
}

console.log("System smoke tests passed")
if (process.env.DEBUG_SYSTEM_TEST) console.log(logs)
