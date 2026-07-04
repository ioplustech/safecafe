import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:net"

const previewPort = await getAvailablePort()
const baseUrl = `http://127.0.0.1:${previewPort}`

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => {
        if (typeof address === "object" && address?.port) {
          resolve(address.port)
          return
        }
        reject(new Error("Failed to allocate a local preview port"))
      })
    })
  })
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForServer(processHandle) {
  const deadline = Date.now() + 15_000
  let lastError
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Preview server exited early with code ${processHandle.exitCode}\n${logs}`)
    }
    try {
      const response = await fetch(baseUrl)
      if (response.ok) return
    } catch (error) {
      lastError = error
    }
    await wait(300)
  }
  throw lastError ?? new Error(`Preview server did not become ready\n${logs}`)
}

async function expectRoute(path, expectedText) {
  const response = await fetch(`${baseUrl}${path}`)
  if (!response.ok) throw new Error(`Expected ${path} to respond with 2xx, got ${response.status}`)
  const html = await response.text()
  if (!html.includes(expectedText)) throw new Error(`Expected ${path} HTML to contain ${expectedText}`)
}

const preview = spawn("pnpm", ["preview", "--host", "127.0.0.1", "--port", String(previewPort)], {
  stdio: ["ignore", "pipe", "pipe"],
})

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
  await expectRoute("/withdrawals", "Safecafe")
  await expectRoute("/validators", "Safecafe")
  await expectRoute("/rewards", "Safecafe")

  const help = execFileSync(process.execPath, ["cli/dist/index.js", "--help"], { encoding: "utf8" })
  for (const command of [
    "validators",
    "stake",
    "unstake",
    "withdrawals",
    "rewards",
    "claim-withdrawal",
    "claim-rewards",
  ]) {
    if (!help.includes(command)) throw new Error(`Expected CLI help to expose ${command}`)
  }
} finally {
  preview.kill("SIGTERM")
}

console.log("System smoke tests passed")
if (process.env.DEBUG_SYSTEM_TEST) console.log(logs)
