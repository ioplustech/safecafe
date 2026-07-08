import assert from "node:assert/strict"
import { chromium } from "@playwright/test"
import { createMockChain } from "./e2e/mockChain.mjs"
import { createWebTestDriver } from "./e2e/webTestDriver.mjs"

const baseUrl = process.env.SAFECAFE_E2E_BASE_URL ?? process.env.BASE_URL ?? "http://127.0.0.1:5175"
const account = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const chain = createMockChain({
  account,
  safeBalance: 1000n * 10n ** 18n,
  coreStake: 100n * 10n ** 18n,
})
const driver = createWebTestDriver({ account, baseUrl, chain, page })

try {
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
  await page
    .getByRole("textbox", {
      name: /Message the staking agent|给质押 Agent 发消息|Nachricht an den Staking Agent|스테이킹 Agent에 메시지 보내기/i,
    })
    .fill("hello")
  await page.getByRole("button", { name: /Send|发送|Senden|보내기/i }).click()

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
  await browser.close()
}
