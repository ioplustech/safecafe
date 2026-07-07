import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { createServer } from "node:net"
import { chromium } from "@playwright/test"
import { privateKeyToAccount } from "viem/accounts"
import { createMockChain } from "./e2e/mockChain.mjs"
import { createWebTestDriver, wait } from "./e2e/webTestDriver.mjs"

const rounds = Number.parseInt(process.env.UI_SWEEP_ROUNDS ?? "3", 10)
const previewPort = await getAvailablePort()
const baseUrl = process.env.E2E_BASE_URL || `http://127.0.0.1:${previewPort}`
const outputDir = `output/playwright/ui-sweep-${new Date().toISOString().replace(/[:.]/g, "-")}`
const account = privateKeyToAccount(`0x${"44".repeat(32)}`)
const initialCoreStake = 20n * 10n ** 18n + 12_345_678_901_234_567n

await mkdir(outputDir, { recursive: true })

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
try {
  if (preview) await waitForServer(preview)
  browser = await chromium.launch({ headless: true })
  for (let round = 1; round <= rounds; round += 1) {
    await runRound(browser, round)
  }
} finally {
  await browser?.close()
  preview?.kill("SIGTERM")
}

if (issues.length > 0) {
  console.log(JSON.stringify({ outputDir, issues }, null, 2))
  process.exitCode = 1
} else {
  console.log(JSON.stringify({ outputDir, issues: [] }, null, 2))
}

async function runRound(browser, round) {
  const chain = createMockChain({ account: account.address, coreStake: initialCoreStake })
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } })
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
    await driver.install()
    await page.goto(baseUrl, { waitUntil: "networkidle" })
    await screenshot(page, round, "01-dashboard-restored")

    await clickIfVisible(page.getByRole("button", { name: /wallet/i }).first())
    await screenshot(page, round, "02-wallet-modal")
    await pressEscape(page)

    await exerciseLanguageMenu(page, round)
    await exerciseDashboard(page, round, driver)
    await exerciseValidators(page, round)
    await exerciseRewardsAndWithdrawals(page, round)
    await exerciseSettings(page, round)
    await exerciseAgent(page, round)
    await exerciseMobile(browser, round, chain)

    if (consoleErrors.length > 0) {
      issues.push({ round, type: "console-error", messages: consoleErrors })
    }
  } catch (error) {
    issues.push({ round, type: "exception", message: error instanceof Error ? error.message : String(error) })
    await screenshot(page, round, "failure")
  } finally {
    await context.close()
  }
}

async function exerciseLanguageMenu(page, round) {
  await clickIfVisible(page.locator(".language-pill").first())
  await screenshot(page, round, "03-language-open")
  await clickIfVisible(page.locator(".page").first())
  await screenshot(page, round, "04-language-closed")
}

async function exerciseDashboard(page, round, driver) {
  await clickIfVisible(page.getByRole("button", { name: "Safecafe dashboard" }))
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
  await clickIfVisible(page.getByRole("button", { exact: true, name: "Validators" }))
  await screenshot(page, round, "10-validators")
  await clickIfVisible(page.getByRole("button", { name: "Active only" }).first())
  await screenshot(page, round, "11-validators-active-only")
  await clickIfVisible(page.getByRole("button", { name: "All validators" }).first())
  await page.getByPlaceholder("Search validators").fill("gnosis")
  await screenshot(page, round, "12-validators-search")
  await page.getByPlaceholder("Search validators").fill("")
  await openSelectAndPickFirst(page, round, "13-validators-sort-select")
  await clickIfVisible(page.locator(".validator-row .row-arrow").first())
  await screenshot(page, round, "14-validator-detail")
  await pressEscape(page)
  await clickIfVisible(page.locator(".validator-row").first().getByRole("button", { name: "Stake" }))
  await page.locator(".primary-actions-panel").waitFor()
  await wait(500)
  await screenshot(page, round, "15-validator-stake-shortcut")
}

async function exerciseRewardsAndWithdrawals(page, round) {
  await clickIfVisible(page.getByRole("button", { exact: true, name: "Rewards" }))
  await screenshot(page, round, "16-rewards")
  await clickIfVisible(page.getByRole("button", { exact: true, name: "Withdrawals" }))
  await screenshot(page, round, "17-withdrawals")
}

async function exerciseSettings(page, round) {
  await clickIfVisible(page.getByRole("button", { exact: true, name: "Settings" }))
  await screenshot(page, round, "18-settings")
  await clickIfVisible(page.getByRole("button", { name: /Safecafe v/i }).first())
  await screenshot(page, round, "19-version-toast")
}

async function exerciseAgent(page, round) {
  await clickIfVisible(page.locator(".agent-launcher").first())
  await screenshot(page, round, "20-agent-open")
  await clickIfVisible(page.getByRole("button", { name: /Claim rewards/i }).first())
  await wait(800)
  await screenshot(page, round, "21-agent-preset")
  await clickIfVisible(page.getByRole("button", { name: /New/i }).first())
  await screenshot(page, round, "22-agent-new-session")
  await pressEscape(page)
}

async function exerciseMobile(browser, round, chain) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })
  const page = await context.newPage()
  try {
    const driver = createWebTestDriver({ account: account.address, baseUrl, chain, page })
    await driver.install()
    await page.goto(baseUrl, { waitUntil: "networkidle" })
    await screenshot(page, round, "23-mobile-dashboard")
    await clickIfVisible(page.locator(".menu-button").first())
    await screenshot(page, round, "24-mobile-menu")
    await clickIfVisible(page.getByRole("button", { name: "Validators" }).first())
    await screenshot(page, round, "25-mobile-validators")
  } finally {
    await context.close()
  }
}

async function openSelectAndPickFirst(page, round, name) {
  const select = page.locator(".custom-select > button").first()
  if ((await select.count()) === 0 || !(await select.isVisible())) return
  await select.click()
  await screenshot(page, round, name)
  const firstOption = page.locator(".floating-select-menu button").first()
  if ((await firstOption.count()) > 0) await firstOption.click()
}

async function clickIfVisible(locator) {
  if ((await locator.count()) === 0) return false
  const target = locator.first()
  if (!(await target.isVisible())) return false
  await target.click()
  await wait(200)
  return true
}

async function pressEscape(page) {
  await page.keyboard.press("Escape")
  await wait(150)
}

async function screenshot(page, round, name) {
  await collectLayoutIssues(page, round, name)
  await page.screenshot({ path: `${outputDir}/round-${round}-${name}.png`, fullPage: true })
}

async function collectLayoutIssues(page, round, name) {
  const report = await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    const overflowWidth = document.documentElement.scrollWidth - viewportWidth
    const minTargetSize = window.innerWidth <= 820 ? 44 : 40
    const smallTargets = Array.from(document.querySelectorAll("button, a, input, textarea, [role='button']"))
      .filter((element) => {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.bottom >= 0 &&
          rect.top <= window.innerHeight
        )
      })
      .map((element) => {
        const rect = element.getBoundingClientRect()
        const label =
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ||
          element.className ||
          element.tagName
        return {
          className: typeof element.className === "string" ? element.className : "",
          height: Math.round(rect.height),
          label,
          tagName: element.tagName,
          width: Math.round(rect.width),
        }
      })
      .filter((item) => item.width < minTargetSize || item.height < minTargetSize)
      .slice(0, 12)

    const toast = document.querySelector("[data-sonner-toast]")
    const summaryCard = document.querySelector(".summary-card")
    let toastOverlapsSummary = false
    if (toast && summaryCard) {
      const a = toast.getBoundingClientRect()
      const b = summaryCard.getBoundingClientRect()
      toastOverlapsSummary = !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom)
    }

    return { overflowWidth, smallTargets, toastOverlapsSummary }
  })

  if (report.overflowWidth > 1) {
    issues.push({ round, step: name, type: "horizontal-overflow", overflowWidth: report.overflowWidth })
  }
  if (report.toastOverlapsSummary) {
    issues.push({ round, step: name, type: "toast-overlaps-summary" })
  }
  const materialSmallTargets = report.smallTargets.filter(
    (item) =>
      !["×", "›", "Close notification"].includes(String(item.label)) &&
      !String(item.className).split(/\s+/).includes("validator-address-link"),
  )
  if (materialSmallTargets.length > 0) {
    issues.push({ round, step: name, type: "small-touch-targets", targets: materialSmallTargets })
  }
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
