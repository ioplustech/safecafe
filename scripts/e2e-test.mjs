import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { chromium } from "@playwright/test"

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

async function assertChatScrolledToBottom(dialog) {
  const list = dialog.locator(".agent-message-list")
  await list.waitFor()
  let metrics = { bottomGap: Number.POSITIVE_INFINITY, lastVisible: false }
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) {
    metrics = await list.evaluate((element) => {
      const messages = element.querySelectorAll(".agent-message-log .agent-message")
      const lastMessage = messages[messages.length - 1]
      const listRect = element.getBoundingClientRect()
      const lastRect = lastMessage?.getBoundingClientRect()
      return {
        bottomGap: element.scrollHeight - element.scrollTop - element.clientHeight,
        lastVisible: Boolean(lastRect && lastRect.bottom <= listRect.bottom + 2 && lastRect.top >= listRect.top - 2),
      }
    })
    if (metrics.bottomGap <= 16 && metrics.lastVisible) return
    await wait(100)
  }
  if (metrics.bottomGap > 16 || !metrics.lastVisible) {
    throw new Error(
      `Expected chat to scroll to latest message, got bottomGap=${metrics.bottomGap}, lastVisible=${metrics.lastVisible}`,
    )
  }
}

const preview = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "pages",
    "dev",
    "dist",
    "--ip",
    "127.0.0.1",
    "--port",
    String(previewPort),
    "--env-file",
    ".env",
    "--compatibility-date",
    "2026-05-14",
    "--log-level",
    "error",
  ],
  {
    stdio: ["ignore", "pipe", "pipe"],
  },
)

let logs = ""
preview.stdout.on("data", (chunk) => {
  logs += chunk.toString()
})
preview.stderr.on("data", (chunk) => {
  logs += chunk.toString()
})

let browser
try {
  await waitForServer(preview)
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
  const consoleErrors = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => {
    consoleErrors.push(error.message)
  })
  await page.goto(baseUrl, { waitUntil: "networkidle" })
  if (consoleErrors.length > 0) {
    throw new Error(`Unexpected browser console errors: ${consoleErrors.join("\n")}`)
  }

  const apiResponse = await page.request.post(`${baseUrl}/api/agent`, {
    data: { message: "help me stake", messages: [], context: { validatorLabels: [] } },
  })
  if (!apiResponse.ok()) throw new Error(`Expected /api/agent to be available, got ${apiResponse.status()}`)
  const apiJson = await apiResponse.json()
  if (typeof apiJson.content !== "string" || apiJson.content.length === 0) {
    throw new Error("Expected /api/agent to return content")
  }
  const streamResponse = await page.request.post(`${baseUrl}/api/agent`, {
    headers: { accept: "text/event-stream" },
    data: {
      message: "help me stake",
      stream: true,
      messages: [],
      context: { agentAccess: "locked", validatorLabels: [] },
    },
  })
  const streamBody = await streamResponse.text()
  if (!streamBody.includes('"type":"thinking"') || !streamBody.includes('"type":"final"')) {
    throw new Error("Expected /api/agent stream to include thinking and final events")
  }

  const launcher = page.getByRole("button", { name: "Open Staking Agent" })
  await launcher.waitFor({ state: "visible", timeout: 10_000 })
  const beforeDrag = await launcher.boundingBox()
  await launcher.dragTo(page.locator("body"), { targetPosition: { x: 440, y: 360 }, force: true })
  const afterDrag = await launcher.boundingBox()
  if (!beforeDrag || !afterDrag || Math.abs(afterDrag.x - beforeDrag.x) < 80) {
    throw new Error("Expected desktop launcher drag to change position")
  }
  await launcher.dragTo(page.locator("body"), { targetPosition: { x: 24, y: 24 }, force: true })
  const afterLeftDrag = await launcher.boundingBox()
  if (!afterLeftDrag || afterLeftDrag.x < 280) throw new Error("Expected launcher drag to avoid the sidebar brand area")
  await launcher.click()

  const dialog = page.getByRole("dialog", { name: "Staking Agent" })
  await dialog.waitFor({ state: "visible" })
  const dialogBox = await dialog.boundingBox()
  if (!dialogBox || dialogBox.x < 280 || dialogBox.y < 100) {
    throw new Error("Expected desktop dialog to open as a right-side assistant panel")
  }
  if (
    !(await dialog.getByLabel("Message the staking agent").evaluate((element) => element === document.activeElement))
  ) {
    throw new Error("Expected agent composer to receive focus when dialog opens")
  }
  for (let index = 0; index < 8; index += 1) await page.keyboard.press("Tab")
  const focusInsideDialog = await dialog.evaluate((element) => element.contains(document.activeElement))
  if (!focusInsideDialog) throw new Error("Expected Tab focus to stay inside the modal agent dialog")
  await dialog.getByText("Tell me what you want to do with your SAFE staking position.").waitFor()
  await dialog.getByText("Connect when you want an executable plan").waitFor()
  await dialog.getByText("Explore stake, unstake, claim, restake, and move-stake workflows.").waitFor()
  await dialog.getByRole("button", { name: "Claim rewards" }).waitFor()
  await dialog.getByRole("button", { name: "Agent sessions" }).waitFor()
  await dialog.getByRole("button", { name: "Agent sessions" }).click()
  await dialog.getByRole("menuitem", { name: "New session" }).waitFor()
  await dialog.getByRole("menuitem", { name: "Clear session" }).waitFor()
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden" })
  await page.getByRole("button", { name: "Switch language" }).click()
  const zhLauncherFromHeader = page.getByRole("button", { name: "打开质押 Agent" })
  await zhLauncherFromHeader.waitFor()
  await zhLauncherFromHeader.click()
  const localizedDialog = page.getByRole("dialog", { name: "质押 Agent" })
  await localizedDialog.waitFor()
  await localizedDialog.getByText("告诉我你想如何处理 SAFE 质押仓位。").waitFor()
  await page.keyboard.press("Escape")
  await localizedDialog.waitFor({ state: "hidden" })
  await page.getByRole("button", { name: "切换语言" }).click()
  await page.getByRole("button", { name: "Open Staking Agent" }).click()
  await dialog.waitFor()
  const messageLogRole = await dialog.locator(".agent-message-log").getAttribute("role")
  if (messageLogRole !== "log") throw new Error("Expected agent messages to render in an accessible log")

  let agentApiCalls = 0
  await page.route("**/api/agent", (route) => {
    agentApiCalls += 1
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body:
        'data: {"type":"thinking","content":"mock thinking"}\n\n' +
        'data: {"type":"delta","content":"mock"}\n\n' +
        'data: {"type":"final","content":"mock","source":"fallback"}\n\n' +
        "data: [DONE]\n\n",
    })
  })

  await dialog.getByLabel("Message the staking agent").fill("stake 100 SAFE")
  await dialog.getByRole("button", { name: "Send" }).click()
  await dialog.getByText("I can sketch this without wallet access.").waitFor()
  if (agentApiCalls !== 0) throw new Error("Expected disconnected wallet path not to call /api/agent")
  await dialog.getByLabel("Message the staking agent").fill("Core Contributors")
  await dialog.getByRole("button", { name: "Send" }).click()
  await dialog.getByText("I can explain that staking flow here.").waitFor()
  if (agentApiCalls !== 0) throw new Error("Expected wallet-required path not to call /api/agent")
  await dialog.getByRole("button", { name: "Agent sessions" }).click()
  await dialog.getByRole("menuitem", { name: "New session" }).click()
  await dialog.getByText("Connect when you want an executable plan").waitFor()
  await dialog.getByRole("button", { name: "Agent sessions" }).click()
  await dialog.getByRole("menuitem", { name: "Clear session" }).click()
  await dialog.getByRole("button", { name: "Claim rewards" }).waitFor()

  await dialog.getByLabel("Message the staking agent").fill("bridge SAFE to arbitrum")
  await dialog.getByRole("button", { name: "Send" }).click()
  await dialog.getByText("Unsupported instruction.").waitFor()

  await dialog.getByLabel("Message the staking agent").fill("automatically stake 100 SAFE every day")
  await dialog.getByRole("button", { name: "Send" }).click()
  await dialog.getByText("Unsupported instruction.").first().waitFor()

  await dialog.getByLabel("Message the staking agent").fill("stake 100 SAFE to Core Contributors every month")
  await dialog.getByRole("button", { name: "Send" }).click()
  await dialog.getByText("Unsupported instruction.").first().waitFor()

  await dialog.getByLabel("Message the staking agent").fill("stake 100 SAFE to Core Contributors monthly")
  await dialog.getByRole("button", { name: "Send" }).click()
  await dialog.getByText("Unsupported instruction.").first().waitFor()

  await dialog.getByLabel("Message the staking agent").fill("stake 100 SAFE to Core Contributors tomorrow")
  await dialog.getByRole("button", { name: "Send" }).click()
  await dialog.getByText("Unsupported instruction.").first().waitFor()

  await dialog.getByLabel("Message the staking agent").fill("每天自动复投奖励")
  await dialog.getByRole("button", { name: "Send" }).click()
  await dialog.getByText("Unsupported instruction.").first().waitFor()

  await dialog.getByLabel("Message the staking agent").fill("please sign transactions on my behalf")
  await dialog.getByRole("button", { name: "Send" }).click()
  await dialog.getByText("Unsupported instruction.").first().waitFor()

  await dialog.getByLabel("Message the staking agent").fill("sign the transaction for me")
  await dialog.getByRole("button", { name: "Send" }).click()
  await dialog.getByText("Unsupported instruction.").first().waitFor()

  await dialog.getByLabel("Message the staking agent").fill("x".repeat(180))
  await dialog.getByRole("button", { name: "Send" }).click()
  const latestUserMessage = dialog.locator(".agent-message.user").last()
  await latestUserMessage.waitFor()
  const overflows = await latestUserMessage.evaluate((element) => element.scrollWidth > element.clientWidth)
  if (overflows) throw new Error("Expected long user messages to wrap inside the chat bubble")

  await dialog.getByLabel("Message the staking agent").fill("领取奖励")
  await dialog.getByRole("button", { name: "Send" }).click()
  await dialog.getByText("I can explain that staking flow here.").first().waitFor()
  await assertChatScrolledToBottom(dialog)
  const messageGap = await dialog.locator(".agent-message-log").evaluate((element) => {
    const messages = Array.from(element.querySelectorAll(".agent-message"))
    const user = messages.findLast((item) => item.classList.contains("user"))
    if (!user) return 0
    const index = messages.indexOf(user)
    const next = messages[index + 1]
    if (!next) return 0
    return next.getBoundingClientRect().top - user.getBoundingClientRect().bottom
  })
  if (messageGap < 8) throw new Error(`Expected visible spacing between agent chat bubbles, got ${messageGap}`)

  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden" })
  if (!(await launcher.evaluate((element) => element === document.activeElement))) {
    throw new Error("Expected focus to return to the agent launcher after closing the dialog")
  }
  await launcher.click()
  await dialog.waitFor({ state: "visible" })

  await page.setViewportSize({ width: 390, height: 760 })
  await page.getByRole("dialog", { name: "Staking Agent" }).waitFor({ state: "visible" })
  await dialog.getByRole("button", { name: "Restake rewards" }).waitFor()
  await page.setViewportSize({ width: 320, height: 700 })
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  if (mobileOverflow) throw new Error("Expected 320px agent layout not to overflow horizontally")
  const mobileBoxesOk = await dialog.evaluate((element) => {
    const dialogRect = element.getBoundingClientRect()
    const selectors = [".agent-dialog-header", ".agent-header-actions", ".agent-session-trigger"]
    return selectors.every((selector) => {
      const target = element.querySelector(selector)
      if (!target) return false
      const rect = target.getBoundingClientRect()
      return rect.left >= dialogRect.left - 1 && rect.right <= dialogRect.right + 1
    })
  })
  if (!mobileBoxesOk) throw new Error("Expected agent header controls to stay inside the mobile dialog")
  await dialog.getByRole("button", { name: "Agent sessions" }).click()
  const sessionPopoverOk = await dialog.locator(".agent-session-popover").evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return rect.left >= -1 && rect.right <= window.innerWidth + 1
  })
  if (!sessionPopoverOk) throw new Error("Expected agent session menu to stay inside the mobile viewport")
  await page.keyboard.press("Escape")
  await page.setViewportSize({ width: 390, height: 760 })
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden" })
  const mobileBeforeDrag = await launcher.boundingBox()
  await launcher.dragTo(page.locator("body"), { targetPosition: { x: 180, y: 540 }, force: true })
  const mobileAfterDrag = await launcher.boundingBox()
  if (!mobileBeforeDrag || !mobileAfterDrag || Math.abs(mobileAfterDrag.x - mobileBeforeDrag.x) < 40) {
    throw new Error("Expected mobile launcher drag to change position")
  }
  await launcher.click()
  await dialog.waitFor({ state: "visible" })
  const html = await page.content()
  if (html.includes("SAFECAFE_LLM_API_KEY")) throw new Error("LLM API key name leaked into rendered page")

  const zhPage = await browser.newPage({ viewport: { width: 390, height: 760 } })
  const zhConsoleErrors = []
  zhPage.on("console", (message) => {
    if (message.type() === "error") zhConsoleErrors.push(message.text())
  })
  zhPage.on("pageerror", (error) => {
    zhConsoleErrors.push(error.message)
  })
  await zhPage.addInitScript(() => {
    window.localStorage.setItem("safecafe:locale", "zh")
  })
  await zhPage.goto(baseUrl, { waitUntil: "networkidle" })
  const zhLauncher = zhPage.getByRole("button", { name: "打开质押 Agent" })
  await zhLauncher.waitFor({ state: "visible", timeout: 10_000 })
  await zhLauncher.click()
  const zhDialog = zhPage.getByRole("dialog", { name: "质押 Agent" })
  await zhDialog.waitFor({ state: "visible" })
  await zhDialog.getByText("需要可执行计划时再连接钱包").waitFor()
  await zhDialog.getByLabel("给质押 Agent 发消息").fill("每天自动复投奖励")
  await zhDialog.getByRole("button", { name: "发送" }).click()
  await zhDialog.getByText("不支持的指令。").waitFor()
  if (zhConsoleErrors.length > 0) {
    throw new Error(`Unexpected zh browser console errors: ${zhConsoleErrors.join("\n")}`)
  }
} finally {
  await browser?.close()
  preview.kill("SIGTERM")
}

console.log("Browser e2e tests passed")
if (process.env.DEBUG_E2E_TEST) console.log(logs)
