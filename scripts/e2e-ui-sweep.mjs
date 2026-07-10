import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { createServer } from "node:net"
import { chromium } from "@playwright/test"
import { privateKeyToAccount } from "viem/accounts"
import { createMockChain } from "./e2e/mockChain.mjs"
import { createWebTestDriver, wait } from "./e2e/webTestDriver.mjs"

const rounds = Number.parseInt(process.env.UI_SWEEP_ROUNDS ?? "3", 10)
const strictMode = process.env.UI_SWEEP_STRICT === "true"
const previewPort = await getAvailablePort()
const baseUrl = process.env.E2E_BASE_URL || `http://127.0.0.1:${previewPort}`
const outputDir = `output/playwright/ui-sweep-${new Date().toISOString().replace(/[:.]/g, "-")}`
const account = privateKeyToAccount(`0x${"44".repeat(32)}`)
const initialCoreStake = 20n * 10n ** 18n + 12_345_678_901_234_567n

await mkdir(outputDir, { recursive: true })
logSweep(`starting e2e UI sweep rounds=${rounds} output=${outputDir}`)
if (process.env.E2E_BASE_URL) {
  logSweep(`using existing app baseUrl=${baseUrl}`)
} else {
  logSweep(`starting Cloudflare Pages preview baseUrl=${baseUrl}`)
}

let logs = ""
const preview = process.env.E2E_BASE_URL
  ? null
  : spawn(
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
        "--binding",
        "SAFECAFE_RPC_ALLOW_ALL_WALLETS=true",
        "--binding",
        "SAFECAFE_AUTH_SECRET=safecafe-ui-sweep-auth-secret",
        "--compatibility-date",
        "2026-05-14",
        "--log-level",
        "error",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    )

preview?.stdout.on("data", (chunk) => {
  logs += chunk.toString()
})
preview?.stderr.on("data", (chunk) => {
  logs += chunk.toString()
})

let browser
const issues = []
const warnings = []
const findingIndex = new Map()
try {
  if (preview) {
    logSweep("waiting for preview server")
    await waitForServer(preview)
    logSweep("preview server ready")
  }
  logSweep(`ready baseUrl=${baseUrl} rounds=${rounds} output=${outputDir}`)
  logSweep("launching Chromium")
  browser = await chromium.launch({ headless: true })
  logSweep("Chromium ready")
  for (let round = 1; round <= rounds; round += 1) {
    await runRound(browser, round)
  }
} finally {
  if (browser) {
    await browser.close()
    logSweep("Chromium closed")
  }
  if (preview) {
    preview.kill("SIGTERM")
    logSweep("preview server stopped")
  }
}

const shouldFail = issues.length > 0 || (strictMode && warnings.length > 0)
if (shouldFail) {
  logSweep(
    `completed with blockers=${issues.length}, warnings=${warnings.length}, strict=${strictMode}: ${summarizeIssueTypes(
      [...issues, ...warnings],
    )}`,
  )
  console.log(JSON.stringify({ outputDir, strictMode, issues, warnings }, null, 2))
  process.exitCode = 1
} else {
  logSweep(`completed with no blockers and ${warnings.length} warning(s)`)
  console.log(JSON.stringify({ outputDir, strictMode, issues: [], warnings }, null, 2))
}

async function runRound(browser, round) {
  logSweep(`round ${round}/${rounds} start`)
  const chain = createMockChain({ account: account.address, coreStake: initialCoreStake })
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1366, height: 900 } })
  const page = await context.newPage()
  const consoleErrors = []
  page.on("console", (message) => {
    const text = message.text()
    if (message.type() === "error" && !text.includes("404 (Not Found)")) consoleErrors.push(text)
  })
  page.on("pageerror", (error) => {
    consoleErrors.push(error.message)
  })
  try {
    const driver = createWebTestDriver({ account: account.address, baseUrl, chain, page })
    logSweep(`round ${round}: installing mock wallet and loading app`)
    await driver.install()
    await page.goto(baseUrl, { waitUntil: "networkidle" })
    logSweep(`round ${round}: app loaded`)
    await screenshot(page, round, "01-dashboard-restored")

    logSweep(`round ${round}: wallet/language/dashboard`)
    await clickRequired(page.getByRole("button", { name: /wallet/i }), "open wallet dialog")
    await page.getByRole("dialog", { name: "Wallet" }).waitFor({ state: "visible" })
    await screenshot(page, round, "02-wallet-modal")
    await pressEscape(page)

    await exerciseLanguageMenu(page, round)
    await exerciseDashboard(page, round, driver)
    logSweep(`round ${round}: validators/rewards/settings`)
    await exerciseValidators(page, round)
    await exerciseRewardsAndWithdrawals(page, round)
    await exerciseSettings(page, round)
    logSweep(`round ${round}: agent/mobile`)
    await exerciseAgent(page, round)
    await exerciseMobile(browser, round, chain)

    if (consoleErrors.length > 0) {
      logSweep(`round ${round}: captured ${consoleErrors.length} console error(s)`)
      recordFinding(issues, { round, type: "console-error", messages: consoleErrors })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logSweep(`round ${round}: failed ${message}`)
    recordFinding(issues, { round, type: "exception", message })
    await screenshot(page, round, "failure")
  } finally {
    await context.close()
    logSweep(`round ${round}/${rounds} done`)
  }
}

async function exerciseLanguageMenu(page, round) {
  await clickRequired(page.getByRole("button", { name: "Switch language" }), "open language menu")
  await page.getByRole("menu").waitFor({ state: "visible" })
  await screenshot(page, round, "03-language-open")
  await pressEscape(page)
  await page.getByRole("menu").waitFor({ state: "hidden" })
  await screenshot(page, round, "04-language-closed")
}

async function exerciseDashboard(page, round, driver) {
  await driver.selectDashboardAction("Unstake")
  await screenshot(page, round, "05-dashboard-unstake")
  await driver.clickActionMax()
  await screenshot(page, round, "06-dashboard-max")
  await driver.selectDashboardAction("Stake")
  await driver.fillActionAmount("1.25")
  await screenshot(page, round, "07-dashboard-stake")
  await openSelectAndPickFirst(page, round, "08-dashboard-validator-select")
  await driver.selectDashboardAction("Claim Rewards")
  await screenshot(page, round, "09-dashboard-claim-rewards")
}

async function exerciseValidators(page, round) {
  await clickRequired(page.getByRole("button", { exact: true, name: "Validators" }), "open validators")
  await screenshot(page, round, "10-validators")
  await clickRequired(page.getByRole("button", { name: "All validators" }), "enable active-only filter")
  await page.getByRole("button", { name: "Active only" }).waitFor({ state: "visible" })
  await screenshot(page, round, "11-validators-active-only")
  await clickRequired(page.getByRole("button", { name: "Active only" }), "show all validators")
  await page.getByRole("button", { name: "All validators" }).waitFor({ state: "visible" })
  await page.getByPlaceholder("Search validators").fill("gnosis")
  await screenshot(page, round, "12-validators-search")
  await page.getByPlaceholder("Search validators").fill("")
  await openSelectAndPickFirst(page, round, "13-validators-sort-select")
  await clickRequired(page.locator(".validator-row .row-arrow"), "open validator detail")
  await screenshot(page, round, "14-validator-detail")
  await pressEscape(page)
  await clickRequired(page.locator(".validator-row").first().getByRole("button", { name: "Stake" }), "prepare stake")
  await page.locator(".primary-actions-panel").waitFor()
  await wait(500)
  await screenshot(page, round, "15-validator-stake-shortcut")
}

async function exerciseRewardsAndWithdrawals(page, round) {
  await dismissToasts(page)
  await clickRequired(page.getByRole("button", { exact: true, name: "Rewards" }), "open rewards")
  await screenshot(page, round, "16-rewards")
  await clickRequired(page.getByRole("button", { exact: true, name: "Withdrawals" }), "open withdrawals")
  await screenshot(page, round, "17-withdrawals")
}

async function exerciseSettings(page, round) {
  await clickRequired(page.getByRole("button", { exact: true, name: "Settings" }), "open settings")
  await screenshot(page, round, "18-settings")
  await page
    .locator(".sidebar-version")
    .filter({ hasText: /Version / })
    .waitFor({ state: "visible" })
  await screenshot(page, round, "19-version-label")
}

async function exerciseAgent(page, round) {
  await clickRequired(page.locator(".agent-launcher"), "open Agent")
  const dialog = page.getByRole("dialog", { name: "Staking Agent" })
  await dialog.waitFor({ state: "visible" })
  await dialog.getByRole("button", { name: "Sign in" }).waitFor({ state: "visible" })
  await screenshot(page, round, "20-agent-locked")
  await clickRequired(dialog.getByRole("button", { name: "Sign in" }), "authenticate Agent")
  await waitForEnabled(dialog.getByRole("button", { name: "Claim rewards" }), "authenticated Agent preset")
  await screenshot(page, round, "21-agent-authenticated")
  await clickRequired(dialog.getByRole("button", { name: "Claim rewards" }), "run Agent preset")
  await dialog.getByText("Mock Agent stream complete. Every transaction still needs wallet confirmation.").waitFor()
  await screenshot(page, round, "22-agent-preset")
  await clickRequired(dialog.getByRole("button", { name: "Agent sessions" }), "open Agent sessions")
  await clickRequired(dialog.getByRole("menuitem", { name: "New session" }), "create Agent session")
  await screenshot(page, round, "23-agent-new-session")
  await clickRequired(dialog.getByRole("button", { name: "Close agent" }), "close Agent")
  await dialog.waitFor({ state: "hidden" })
}

async function exerciseMobile(browser, round, chain) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    reducedMotion: "reduce",
  })
  const page = await context.newPage()
  try {
    const driver = createWebTestDriver({ account: account.address, baseUrl, chain, page })
    await driver.install()
    await page.goto(baseUrl, { waitUntil: "networkidle" })
    await screenshot(page, round, "24-mobile-dashboard")
    await clickRequired(page.locator(".menu-button"), "open mobile menu")
    await screenshot(page, round, "25-mobile-menu")
    await clickRequired(page.getByRole("button", { name: "Validators" }), "open mobile validators")
    await screenshot(page, round, "26-mobile-validators")
  } finally {
    await context.close()
  }
}

async function openSelectAndPickFirst(page, round, name) {
  const scope = name.includes("sort") ? page.locator(".validator-toolbar") : page.locator(".primary-actions-panel")
  const select = scope.locator(".custom-select-value-button")
  await clickRequired(select, `open ${name}`)
  const listbox = page.locator(".floating-select-menu")
  await listbox.waitFor({ state: "visible" })
  await screenshot(page, round, name)
  await clickRequired(listbox.getByRole("option"), `choose ${name} option`)
}

async function clickRequired(locator, description) {
  const target = await firstVisible(locator)
  if (!target) throw new Error(`Required interaction is missing: ${description}`)
  if (!(await target.isEnabled())) throw new Error(`Required interaction is disabled: ${description}`)
  await target.click()
  await wait(200)
}

async function firstVisible(locator) {
  const count = await locator.count()
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index)
    if (await candidate.isVisible()) return candidate
  }
  return null
}

async function waitForEnabled(locator, description) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const target = await firstVisible(locator)
    if (target && (await target.isEnabled())) return
    await wait(100)
  }
  throw new Error(`Required interaction did not become enabled: ${description}`)
}

async function dismissToasts(page) {
  for (;;) {
    const closeButton = await firstVisible(page.getByRole("button", { name: "Close notification" }))
    if (!closeButton) return
    await closeButton.evaluate((element) => element.click()).catch(() => undefined)
    await wait(100)
  }
}

async function pressEscape(page) {
  await page.keyboard.press("Escape")
  await wait(150)
}

async function screenshot(page, round, name) {
  const findingCountBefore = issues.length + warnings.length
  logSweep(`round ${round}: capturing ${name}`)
  await page.evaluate(() => window.scrollTo(0, 0))
  await wait(100)
  await collectLayoutIssues(page, round, name)
  await page.screenshot({
    path: `${outputDir}/round-${round}-${name}.png`,
    animations: "disabled",
    fullPage: true,
  })
  const findingDelta = issues.length + warnings.length - findingCountBefore
  if (findingDelta > 0) logSweep(`round ${round}: ${name} added ${findingDelta} unique finding(s)`)
}

async function collectLayoutIssues(page, round, name) {
  const report = await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    const overflowWidth = document.documentElement.scrollWidth - viewportWidth
    const recommendedTargetSize = window.innerWidth <= 820 ? 44 : 40
    const minimumTargetSize = 24
    const targets = new Map()
    for (const element of document.querySelectorAll("button, a, input, textarea, [role='button']")) {
      if (element instanceof HTMLButtonElement && element.disabled) continue
      const logicalTarget = element.closest(".custom-select-control") ?? element
      if (targets.has(logicalTarget)) continue
      const rect = logicalTarget.getBoundingClientRect()
      const style = window.getComputedStyle(logicalTarget)
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        style.visibility === "hidden" ||
        style.display === "none" ||
        rect.bottom < 0 ||
        rect.top > window.innerHeight
      ) {
        continue
      }
      const width = Math.round(rect.width)
      const height = Math.round(rect.height)
      const severity =
        width < minimumTargetSize || height < minimumTargetSize
          ? "blocker"
          : width < recommendedTargetSize || height < recommendedTargetSize
            ? "warning"
            : null
      if (!severity) continue
      const label =
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ||
        element.className ||
        element.tagName
      targets.set(logicalTarget, {
        className: typeof logicalTarget.className === "string" ? logicalTarget.className : "",
        height,
        label,
        severity,
        tagName: logicalTarget.tagName,
        width,
      })
    }

    const toast = document.querySelector("[data-sonner-toast]")
    const summaryCard = document.querySelector(".summary-card")
    let toastOverlapsSummary = false
    if (toast && summaryCard) {
      const a = toast.getBoundingClientRect()
      const b = summaryCard.getBoundingClientRect()
      toastOverlapsSummary = !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom)
    }

    return {
      overflowWidth,
      toastOverlapsSummary,
      touchTargets: Array.from(targets.values()),
      viewport: window.innerWidth <= 820 ? "mobile" : "desktop",
    }
  })

  if (report.overflowWidth > 1) {
    recordFinding(issues, { round, step: name, type: "horizontal-overflow", overflowWidth: report.overflowWidth })
  }
  if (report.toastOverlapsSummary) {
    recordFinding(issues, { round, step: name, type: "toast-overlaps-summary" })
  }
  const materialTouchTargets = report.touchTargets.filter(
    (item) =>
      !["×", "›", "Close notification"].includes(String(item.label)) &&
      !String(item.className).split(/\s+/).includes("validator-address-link"),
  )
  for (const target of materialTouchTargets) {
    const collection = target.severity === "blocker" ? issues : warnings
    recordFinding(
      collection,
      {
        firstSeen: { round, step: name },
        occurrences: 1,
        target,
        type: target.severity === "blocker" ? "touch-target-minimum" : "touch-target-recommended",
        viewport: report.viewport,
      },
      [report.viewport, target.className, target.label, `${target.width}x${target.height}`].join("|"),
    )
  }
}

function recordFinding(collection, finding, dedupeKey) {
  if (!dedupeKey) {
    collection.push(finding)
    return
  }
  const scope = collection === warnings ? "warning" : "issue"
  const key = `${scope}:${dedupeKey}`
  const existing = findingIndex.get(key)
  if (existing) {
    existing.occurrences += 1
    return
  }
  findingIndex.set(key, finding)
  collection.push(finding)
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
        reject(new Error("Failed to allocate a local preview port"))
      })
    })
  })
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

function logSweep(message) {
  console.log(`[ui-sweep] ${message}`)
}

function summarizeIssueTypes(items) {
  const counts = new Map()
  for (const item of items) {
    counts.set(item.type, (counts.get(item.type) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([type, count]) => `${type}=${count}`)
    .join(", ")
}
