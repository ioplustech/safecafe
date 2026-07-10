import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { chromium } from "@playwright/test"
import { createMockChain } from "./e2e/mockChain.mjs"
import { createWebTestDriver } from "./e2e/webTestDriver.mjs"

const externalBaseUrl = process.env.SAFECAFE_E2E_BASE_URL ?? process.env.E2E_BASE_URL ?? process.env.BASE_URL
const previewPort = externalBaseUrl ? null : await getAvailablePort()
const baseUrl = externalBaseUrl ?? `http://127.0.0.1:${previewPort}`
const account = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

let logs = ""
const preview = externalBaseUrl
  ? null
  : spawn("pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", String(previewPort)], {
      env: {
        ...process.env,
        VITE_AGENT_LAUNCHER_DRAGGABLE: process.env.VITE_AGENT_LAUNCHER_DRAGGABLE ?? "true",
        VITE_RPC_URL: process.env.VITE_RPC_URL ?? "/api/rpc/ethereum",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

preview?.stdout.on("data", (chunk) => {
  logs += chunk.toString()
})
preview?.stderr.on("data", (chunk) => {
  logs += chunk.toString()
})

let browser
try {
  if (preview) await waitForServer(preview)
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const chain = createMockChain({
    account,
    safeBalance: 1000n * 10n ** 18n,
    coreStake: 100n * 10n ** 18n,
  })
  const driver = createWebTestDriver({ account, baseUrl, chain, page })
  await driver.install()
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window)
    const waitForStream = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (!new URL(url, window.location.href).pathname.endsWith("/api/agent")) return originalFetch(input, init)
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          const send = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
          send({ type: "thinking", content: "Checking wallet context" })
          await waitForStream(180)
          send({ type: "thinking", content: "Checking wallet context\nReading staking snapshot" })
          await waitForStream(180)
          send({ type: "delta", content: "First streamed sentence. " })
          await waitForStream(180)
          send({ type: "delta", content: "Second streamed sentence before final." })
          await waitForStream(180)
          send({
            type: "final",
            content: "First streamed sentence. Second streamed sentence before final.",
            source: "llm",
          })
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
        },
      })
    }
  })

  await driver.open()
  await driver.connectWallet()
  await page.getByRole("button", { name: /Staking Agent/i }).click()
  const dialog = page.getByRole("dialog", { name: /Staking Agent|质押 Agent|Staking-Agent|스테이킹 Agent/i })
  await dialog.getByRole("button", { name: /Sign in|签名登录|Einloggen|로그인/i }).click()
  const composer = dialog.getByRole("textbox", {
    name: /Message the staking agent|给质押 Agent 发消息|Nachricht an den Staking Agent|스테이킹 Agent에 메시지 보내기/i,
  })
  await page.waitForFunction(() => {
    const field = document.querySelector(".agent-composer textarea")
    return field instanceof HTMLTextAreaElement && !field.disabled
  })
  await composer.fill("hello")
  await page.getByRole("button", { name: /Send|发送|Senden|보내기/i }).click()
  await page.getByRole("button", { name: /Stop|停止|Stoppen|중지/i }).click()
  const stopConfirm = page.getByRole("alertdialog", {
    name: /Stop this Agent run|停止本次 Agent 响应|Diesen Agent-Lauf stoppen|이 Agent 실행을 중지/i,
  })
  await stopConfirm.waitFor({ state: "visible" })
  await stopConfirm.getByText(/current response|当前回复|aktuelle Antwort|현재 응답/i).waitFor()
  await stopConfirm.getByRole("button", { name: /Keep waiting|继续等待|Weiter warten|계속 기다리기/i }).click()
  await stopConfirm.waitFor({ state: "hidden" })

  await page.getByRole("button", { name: /Show reasoning|展示 thinking|Argumentation anzeigen|추론 보기/i }).click()
  const thinkingLocator = page.locator(".agent-thinking p").last()
  await thinkingLocator.waitFor({ state: "visible", timeout: 5_000 })
  const thinkingFirst = await thinkingLocator.innerText()
  assert.equal(thinkingFirst.includes("Checking wallet context"), true)

  const assistantLocator = page.locator(".agent-message.assistant .agent-message-content").last()
  await page.waitForFunction(() => {
    const items = Array.from(document.querySelectorAll(".agent-message.assistant .agent-message-content"))
    return items.at(-1)?.textContent?.includes("First streamed sentence.")
  })
  const partialContent = await assistantLocator.innerText()
  assert.equal(partialContent, "First streamed sentence. ")

  await page.getByRole("button", { name: /Close agent|关闭 Agent|Agent schließen|Agent 닫기/i }).click()
  await page.waitForTimeout(260)
  await page.getByRole("button", { name: /Staking Agent|质押 Agent|Staking-Agent|스테이킹 Agent/i }).click()

  await page.waitForFunction(() => {
    const thinking = Array.from(document.querySelectorAll(".agent-thinking p")).at(-1)?.textContent ?? ""
    return thinking.includes("Reading staking snapshot")
  })
  const thinkingSecond = await thinkingLocator.innerText()
  assert.equal(thinkingSecond, "Checking wallet context\nReading staking snapshot")

  await page.waitForFunction(() => {
    const items = Array.from(document.querySelectorAll(".agent-message.assistant .agent-message-content"))
    return items.at(-1)?.textContent?.includes("Second streamed sentence before final.")
  })
  const finalContent = await assistantLocator.innerText()
  assert.equal(finalContent, "First streamed sentence. Second streamed sentence before final.")
  console.log("agent-stream-ui ok")
} finally {
  await browser?.close()
  await stopServer(preview)
}

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
        reject(new Error("Failed to allocate a local test port"))
      })
    })
  })
}

async function waitForServer(processHandle) {
  const deadline = Date.now() + 15_000
  let lastError
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Agent stream UI server exited early with code ${processHandle.exitCode}\n${logs}`)
    }
    try {
      const response = await fetch(baseUrl)
      if (response.ok) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw lastError ?? new Error(`Agent stream UI server did not become ready\n${logs}`)
}

async function stopServer(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return
  processHandle.kill("SIGTERM")
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      processHandle.kill("SIGKILL")
      resolve()
    }, 2_000)
    processHandle.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
