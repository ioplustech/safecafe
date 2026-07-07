import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { chromium } from "@playwright/test"
import { privateKeyToAccount } from "viem/accounts"
import { createMockChain } from "./e2e/mockChain.mjs"
import { createWebTestDriver, wait } from "./e2e/webTestDriver.mjs"

const previewPort = await getAvailablePort()
const baseUrl = process.env.E2E_BASE_URL || `http://127.0.0.1:${previewPort}`
const account = privateKeyToAccount(`0x${"33".repeat(32)}`)
const initialCoreStake = 20n * 10n ** 18n + 12_345_678_901_234_567n
const chain = createMockChain({ account: account.address, coreStake: initialCoreStake })

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
        "SAFECAFE_AUTH_SECRET=safecafe-live-mock-auth-secret",
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
try {
  if (preview) await waitForServer(preview)
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
  const consoleErrors = []
  page.on("console", (message) => {
    const text = message.text()
    if (message.type() === "error" && !text.includes("404 (Not Found)")) consoleErrors.push(text)
  })
  page.on("pageerror", (error) => {
    consoleErrors.push(error.message)
  })

  const driver = createWebTestDriver({ account: account.address, baseUrl, chain, page })
  await driver.openAndConnect()
  await driver.expectSummary({ safeBalance: "100.00" })

  await runDashboardTabPersistenceFlow(driver)
  await runDashboardValidatorDetailsFlow(driver)
  await runUnstakeMaxPrecisionFlow(driver, chain)
  await runStakeFlow(driver)
  await runUnstakeFlow(driver)
  await runClaimWithdrawalFlow(driver)
  await runClaimRewardsFlow(driver)

  if (consoleErrors.length > 0) {
    throw new Error(`Unexpected browser console errors: ${consoleErrors.join("\n")}`)
  }
  console.log("Live mock e2e tests passed")
} finally {
  await browser?.close()
  preview?.kill("SIGTERM")
}

async function runDashboardTabPersistenceFlow(driver) {
  await driver.expectDashboardActionActive("Stake")
  await driver.selectDashboardAction("Unstake")
  await driver.expectDashboardActionActive("Unstake")
  await driver.expectActionSelectDetail({ action: "Unstake", expectedText: "Your Stake 20.01 SAFE" })
  await driver.expectSummary({ claimableRewards: "8.00 SAFE" })
  await driver.expectDashboardActionActive("Unstake")
  await driver.fillActionAmount("1000000")
  await driver.selectDashboardAction("Stake")
  await driver.expectNoVisibleText("SAFE balance is insufficient for this stake amount.")
  await driver.expectDashboardActionActive("Stake")
  await driver.expectActionSelectDetail({ action: "Stake", expectedText: "0xCc00DE...0B04D9" })
  await driver.expectActionSelectDetail({ action: "Stake", expectedText: "Your Stake 20.01 SAFE" })
}

async function runDashboardValidatorDetailsFlow(driver) {
  await driver.expectOverviewValidatorPosition({ validatorLabel: "Core Contributors", amount: "20.01" })
}

async function runUnstakeMaxPrecisionFlow(driver, chain) {
  await driver.selectDashboardAction("Unstake")
  await driver.clickActionMax()
  await driver.expectNoVisibleText("Your stake on this validator is insufficient.")
  await driver.submitPrimaryAction()
  await driver.expectValidatorStake({ amount: "0.00" })
  if (chain.state.pendingWithdrawals.at(-1)?.amount !== initialCoreStake) {
    throw new Error(
      `Expected MAX unstake amount ${initialCoreStake}, got ${chain.state.pendingWithdrawals.at(-1)?.amount}`,
    )
  }
  await driver.claimWithdrawal()
  await driver.expectSafeBalance("120.012345678901234567")
}

async function runStakeFlow(driver) {
  await driver.clearRpcSession()
  const signCountBefore = await driver.walletPersonalSignCount()
  await driver.stake({ amount: "10" })
  const signCountAfter = await driver.walletPersonalSignCount()
  if (signCountAfter !== signCountBefore) {
    throw new Error(`Expected regular stake to avoid auth signing, got ${signCountAfter - signCountBefore} signatures`)
  }
  await driver.expectSafeBalance("110.012345678901234567")
  await driver.expectValidatorStake({ amount: "10" })
  await driver.expectSummary({ safeBalance: "110.01", totalStaked: "10.00" })
  await driver.expectLastTxSequence(["approve", "stake"])
}

async function runUnstakeFlow(driver) {
  await driver.unstake({ amount: "5" })
  await driver.expectValidatorStake({ amount: "5" })
  await driver.expectPendingWithdrawal("5")
  await driver.expectSummary({ claimableWithdrawals: "5.00 SAFE", totalStaked: "5.00" })
}

async function runClaimWithdrawalFlow(driver) {
  await driver.claimWithdrawal()
  await driver.expectNoPendingWithdrawals()
  await driver.expectSafeBalance("115.012345678901234567")
  await driver.expectSummary({ safeBalance: "115.01" })
}

async function runClaimRewardsFlow(driver) {
  const beforeTabClick = (await driver.walletTransactions()).length
  await driver.selectDashboardAction("Claim Rewards")
  await driver.expectWalletTxCount(beforeTabClick)
  await driver.submitPrimaryAction()
  await driver.expectCumulativeClaimed("8")
  await driver.expectSafeBalance("123.012345678901234567")
  await driver.expectSummary({ claimableRewards: "0.00", safeBalance: "123.01" })
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
