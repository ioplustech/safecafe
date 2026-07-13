import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:net"
import { chromium } from "@playwright/test"
import { privateKeyToAccount } from "viem/accounts"
import { createMockChain } from "./e2e/mockChain.mjs"
import { createWebTestDriver, wait } from "./e2e/webTestDriver.mjs"

const args = parseArgs(process.argv.slice(2))
const serverMode = resolveServerMode(args)
const previewPort = serverMode === "external" ? null : await getAvailablePort()
const baseUrl = args.url ?? process.env.E2E_BASE_URL ?? `http://127.0.0.1:${previewPort}`
const account = privateKeyToAccount(`0x${"33".repeat(32)}`)
const initialCoreStake = 20n * 10n ** 18n + 12_345_678_901_234_567n
const chain = createMockChain({ account: account.address, coreStake: initialCoreStake })

let logs = ""
const preview = startServer(serverMode, previewPort)

preview?.stdout.on("data", (chunk) => {
  logs += chunk.toString()
})
preview?.stderr.on("data", (chunk) => {
  logs += chunk.toString()
})

let browser
try {
  await waitForServer(preview)
  console.log(`[live-mock] server=${serverMode} url=${baseUrl}`)
  browser = await chromium.launch({ headless: !args.headful })
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
  await runScenario("connect wallet and load account snapshot", async () => {
    await driver.openAndConnect()
    await driver.expectSummary({ safeBalance: "100.00" })
  })
  await runScenario("staking decision and trust surfaces", () => runDecisionSurfaceFlow(page, driver))
  await runScenario("safe multisig discovery and selection", () => runSafeDiscoveryFlow(page))
  await runScenario("safe threshold proposal flow", () => runSafeThresholdProposalFlow(page, driver, chain))
  await runScenario("safe threshold two-transaction proposal flow", () =>
    runSafeThresholdTwoTransactionProposalFlow(page, driver, chain),
  )
  await runScenario("dashboard tab switching and validation timing", () => runDashboardTabPersistenceFlow(driver))
  await runScenario("empty unstake tab switching", () => runEmptyUnstakeTabSwitchingFlow(driver, chain))
  await runScenario("staking overview validator positions", () => runDashboardValidatorDetailsFlow(driver))
  await runScenario("manual action unlocks protected RPC", () => runManualActionAuthFlow(driver))
  await runScenario("staking agent streaming guidance", () => runAgentFlow(page))
  await runScenario("staking agent restake action card", () => runAgentRestakeActionFlow(page, driver, chain))
  await runScenario("unstake max precision and withdrawal claim", () => runUnstakeMaxPrecisionFlow(driver, chain))
  await runScenario("stake with internal RPC simulation", () => runStakeFlow(driver))
  await runScenario("unstake with internal RPC simulation", () => runUnstakeFlow(driver, chain))
  await runScenario("claim pending withdrawal", () => runClaimWithdrawalFlow(driver))
  await runScenario("claim rewards from tab button", () => runClaimRewardsFlow(driver))
  await runScenario("claim rewards and stake feature", () => runClaimRewardsAndStakeFlow(driver, chain))

  if (consoleErrors.length > 0) {
    throw new Error(`Unexpected browser console errors: ${consoleErrors.join("\n")}`)
  }
  console.log(
    `[live-mock] passed txs=${(await driver.walletTransactions()).length} personalSign=${await driver.walletPersonalSignCount()}`,
  )
} finally {
  await browser?.close()
  await stopServer(preview)
}

async function runDashboardTabPersistenceFlow(driver) {
  await driver.selectDashboardAction("Stake")
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

async function runSafeDiscoveryFlow(page) {
  await page
    .getByRole("button", { name: /Wallet:/ })
    .first()
    .click()
  const walletDialog = page.locator(".modal-backdrop", { hasText: "Signer wallet" })
  await walletDialog.waitFor({ state: "visible" })
  await walletDialog.getByText("Choose a discovered Safe or enter another Safe manually.").waitFor()
  await walletDialog.getByRole("button", { name: "Use Safe multisig" }).click()
  await walletDialog.waitFor({ state: "hidden" })
  await page
    .getByRole("button", { name: /Staking account: 0x111111.*1\/1/ })
    .first()
    .click()
  await walletDialog.waitFor({ state: "visible" })
  const stakingSubjectRow = walletDialog.locator(".address-row", { hasText: "Staking account" })
  await stakingSubjectRow.getByText(/Safe 1\/1/).waitFor()
  await stakingSubjectRow.getByText("0x11111111...11111111").waitFor()
  await walletDialog.getByRole("button", { name: "Use current wallet" }).click()
  await walletDialog.waitFor({ state: "hidden" })
}

async function runSafeThresholdProposalFlow(page, driver, chain) {
  const originalSafes = chain.state.safes
  const originalOwners = chain.state.safeOwners
  const originalThreshold = chain.state.safeThreshold
  const originalAllowance = chain.state.stakingAllowance
  const originalSafeBalance = chain.state.safeBalance
  const originalStake = chain.state.validators[0].userStake
  const secondOwner = "0x2222222222222222222222222222222222222222"
  try {
    chain.state.safes = ["0x1111111111111111111111111111111111111111"]
    chain.state.safeOwners = [account.address, secondOwner]
    chain.state.safeThreshold = 2n
    chain.state.stakingAllowance = 2n * 10n ** 18n
    chain.state.safeProposals.clear()
    await page.evaluate(() => {
      window.localStorage.removeItem("safecafe:wallet-subjects")
    })
    await page.reload({ waitUntil: "networkidle" })
    await driver.connectWallet()
    await page
      .getByRole("button", { name: /Wallet:/ })
      .first()
      .click()
    const walletDialog = page.locator(".modal-backdrop", { hasText: "Signer wallet" })
    await walletDialog.waitFor({ state: "visible" })
    await walletDialog.getByRole("button", { name: "Use Safe multisig" }).click()
    await walletDialog.waitFor({ state: "hidden" })

    await driver.selectDashboardAction("Stake")
    await driver.fillActionAmount("2")
    const signCountBefore = await driver.walletPersonalSignCount()
    await driver.submitPrimaryAction()
    const proposalCard = page.locator(".execution-safe-proposal")
    await proposalCard.getByText("Safe proposal pending").waitFor()
    await proposalCard.getByText(/1\/2/).waitFor()
    if (chain.state.safeProposals.size !== 1) {
      throw new Error(`Expected one Safe proposal, got ${chain.state.safeProposals.size}`)
    }
    if (chain.state.validators[0].userStake !== originalStake) {
      throw new Error("Safe proposal should not execute before threshold is met.")
    }
    const signCountAfterProposal = await driver.walletPersonalSignCount()
    if (signCountAfterProposal < signCountBefore + 1) {
      throw new Error(`Expected Safe proposal to request a signature, got ${signCountAfterProposal - signCountBefore}`)
    }
    const proposal = [...chain.state.safeProposals.values()][0]
    proposal.confirmations.set(secondOwner, { owner: secondOwner, signature: `0x${"22".repeat(64)}1f` })
    await page.getByRole("button", { name: "Continue Safe flow" }).click()
    await page.getByText("Flow completed").waitFor()
    await driver.expectValidatorStake({ amount: formatSafeAmount(originalStake + 2n * 10n ** 18n) })
    await driver.expectSafeBalance(formatSafeAmount(originalSafeBalance - 2n * 10n ** 18n))
  } finally {
    chain.state.safes = originalSafes
    chain.state.safeOwners = originalOwners
    chain.state.safeThreshold = originalThreshold
    chain.state.stakingAllowance = originalAllowance
    chain.state.safeBalance = originalSafeBalance
    chain.state.validators[0].userStake = originalStake
    chain.state.safeProposals.clear()
    await page.evaluate(() => {
      window.localStorage.removeItem("safecafe:account-live-cache:v1")
      window.localStorage.removeItem("safecafe:wallet-subjects")
    })
    await page.reload({ waitUntil: "networkidle" })
    await driver.connectWallet()
  }
}

async function runSafeThresholdTwoTransactionProposalFlow(page, driver, chain) {
  const originalSafes = chain.state.safes
  const originalOwners = chain.state.safeOwners
  const originalThreshold = chain.state.safeThreshold
  const originalAllowance = chain.state.stakingAllowance
  const originalSafeBalance = chain.state.safeBalance
  const originalSafeNonce = chain.state.safeNonce
  const originalStake = chain.state.validators[0].userStake
  const secondOwner = "0x2222222222222222222222222222222222222222"
  const stakeAmount = 2n * 10n ** 18n
  try {
    chain.state.safes = ["0x1111111111111111111111111111111111111111"]
    chain.state.safeOwners = [account.address, secondOwner]
    chain.state.safeThreshold = 2n
    chain.state.stakingAllowance = 0n
    chain.state.safeNonce = 0n
    chain.state.safeProposals.clear()
    await page.evaluate(() => {
      window.localStorage.removeItem("safecafe:account-live-cache:v1")
      window.localStorage.removeItem("safecafe:safe-proposal:v1")
      window.localStorage.removeItem("safecafe:wallet-subjects")
    })
    await page.reload({ waitUntil: "networkidle" })
    await driver.connectWallet()
    await page
      .getByRole("button", { name: /Wallet:/ })
      .first()
      .click()
    const walletDialog = page.locator(".modal-backdrop", { hasText: "Signer wallet" })
    await walletDialog.waitFor({ state: "visible" })
    await walletDialog.getByRole("button", { name: "Use Safe multisig" }).click()
    await walletDialog.waitFor({ state: "hidden" })

    await driver.selectDashboardAction("Stake")
    await driver.fillActionAmount("2")
    await page.locator(".primary-actions-panel .form-row").getByRole("button", { name: "Stake" }).first().click()
    const notice = page.getByRole("alertdialog", { name: "Safe multisig flow" })
    await notice.getByText("This plan has 2 Safe transactions.").waitFor()
    await notice.getByRole("button", { name: "Continue Safe flow" }).click()

    const proposalCard = page.locator(".execution-safe-proposal")
    await proposalCard.getByText("Safe proposal pending").waitFor()
    await proposalCard.getByText(/1\/2/).waitFor()
    await proposalCard.getByText(/#1 .*Approve SAFE for staking contract/).waitFor()
    if (chain.state.safeProposals.size !== 1) {
      throw new Error(`Expected first Safe proposal, got ${chain.state.safeProposals.size}`)
    }
    if (chain.state.stakingAllowance !== 0n || chain.state.validators[0].userStake !== originalStake) {
      throw new Error("First Safe proposal should wait for approval before changing mock chain state.")
    }

    const firstProposal = [...chain.state.safeProposals.values()][0]
    firstProposal.confirmations.set(secondOwner, { owner: secondOwner, signature: `0x${"22".repeat(64)}1f` })
    await proposalCard.getByRole("button", { name: "Continue Safe flow" }).click()
    await proposalCard.getByText(/#2 .*Stake SAFE to validator/).waitFor()
    if (chain.state.safeProposals.size !== 2) {
      throw new Error(`Expected second Safe proposal after executing approve, got ${chain.state.safeProposals.size}`)
    }
    if (chain.state.stakingAllowance !== stakeAmount || chain.state.validators[0].userStake !== originalStake) {
      throw new Error("Approve should execute before the stake proposal is created.")
    }

    const secondProposal = [...chain.state.safeProposals.values()].at(-1)
    secondProposal.confirmations.set(secondOwner, { owner: secondOwner, signature: `0x${"33".repeat(64)}1f` })
    await proposalCard.getByRole("button", { name: "Continue Safe flow" }).click()
    await page.getByText("Flow completed").waitFor()
    await driver.expectValidatorStake({ amount: formatSafeAmount(originalStake + stakeAmount) })
    await driver.expectSafeBalance(formatSafeAmount(originalSafeBalance - stakeAmount))
  } finally {
    chain.state.safes = originalSafes
    chain.state.safeOwners = originalOwners
    chain.state.safeThreshold = originalThreshold
    chain.state.stakingAllowance = originalAllowance
    chain.state.safeBalance = originalSafeBalance
    chain.state.safeNonce = originalSafeNonce
    chain.state.validators[0].userStake = originalStake
    chain.state.safeProposals.clear()
    await page.evaluate(() => {
      window.localStorage.removeItem("safecafe:account-live-cache:v1")
      window.localStorage.removeItem("safecafe:safe-proposal:v1")
      window.localStorage.removeItem("safecafe:wallet-subjects")
    })
    await page.reload({ waitUntil: "networkidle" })
    await driver.connectWallet()
  }
}

async function runDecisionSurfaceFlow(page, driver) {
  await page.getByText("Current APY").waitFor()
  await page.getByText("Protocol TVL").waitFor()
  await page.getByText("Unstake delay").waitFor()
  const trustStrip = page.locator(".summary-trust-strip")
  await trustStrip.waitFor()
  await trustStrip.getByText("Ethereum Mainnet · Chain ID 1").waitFor()
  await page.getByText("Transaction Preview").waitFor()
  await page.getByText("Estimated Gas").waitFor()
  await page.getByText("Wallet confirmation").waitFor()
  await driver.selectDashboardAction("Claim Rewards")
  await page.getByRole("button", { name: "Claim to wallet" }).waitFor()
  await page.getByRole("button", { name: "Claim & restake" }).waitFor()
  await page.getByRole("button", { exact: true, name: "Withdrawals" }).click()
  const timeline = page.locator(".withdrawal-timeline")
  await timeline.getByText("Withdrawal Timeline").waitFor()
  await timeline.getByText("Submitted", { exact: true }).waitFor()
  await timeline.getByText("Unlocking", { exact: true }).waitFor()
  await timeline.getByText("Claimable", { exact: true }).waitFor()
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Overview" }).click()
  await driver.selectDashboardAction("Stake")
  await page.getByRole("button", { exact: true, name: "Rewards" }).click()
  const rewardsPanel = page.locator(".rewards-panel")
  await rewardsPanel.locator(".reward-action-heading h3", { hasText: "Claim to wallet" }).waitFor()
  await rewardsPanel.locator(".reward-action-heading h3", { hasText: "Claim & restake" }).waitFor()
  await rewardsPanel.locator(".custom-select-label-text", { hasText: "Core Contributors" }).waitFor()
}

async function runEmptyUnstakeTabSwitchingFlow(driver, chain) {
  const originalStakes = chain.state.validators.map((validator) => validator.userStake)
  try {
    for (const validator of chain.state.validators) validator.userStake = 0n
    await driver.selectDashboardAction("Stake")
    await driver.expectDashboardActionActive("Stake")
    await driver.selectDashboardAction("Unstake")
    await driver.expectDashboardActionActive("Unstake")
    await driver.expectNoVisibleText("Your stake on this validator is insufficient.")
  } finally {
    chain.state.validators.forEach((validator, index) => {
      validator.userStake = originalStakes[index] ?? 0n
    })
  }
}

async function runDashboardValidatorDetailsFlow(driver) {
  await driver.refreshLiveData()
  await driver.expectOverviewValidatorPosition({ validatorLabel: "Core Contributors", amount: "20.01" })
}

async function runManualActionAuthFlow(driver) {
  await driver.clearRpcSession()
  const signCountBefore = await driver.walletPersonalSignCount()
  await driver.stake({ amount: "1" })
  const signCountAfter = await driver.walletPersonalSignCount()
  if (signCountAfter !== signCountBefore + 1) {
    throw new Error(
      `Expected first manual action to unlock protected RPC with one signature, got ${
        signCountAfter - signCountBefore
      } signatures`,
    )
  }
  await driver.expectRecentRpcRequestsAuthorized(2)
  await driver.expectLastTxSequence(["approve", "stake"])
}

async function runUnstakeMaxPrecisionFlow(driver, chain) {
  await driver.refreshLiveData()
  const coreStakeBeforeMax = chain.state.validators[0].userStake
  const safeBalanceBeforeClaim = chain.state.safeBalance
  await driver.selectValidatorTableAction({ action: "Unstake", validatorLabel: "Core Contributors" })
  await driver.expectCurrentActionSelectDetail("Core Contributors")
  await driver.expectCurrentActionSelectDetail(`Your Stake ${formatSafeAmountForSummary(coreStakeBeforeMax)}`)
  await driver.clickActionMax()
  await driver.expectNoVisibleText("Your stake on this validator is insufficient.")
  await driver.submitPrimaryAction()
  await driver.expectValidatorStake({ amount: "0.00" })
  if (chain.state.pendingWithdrawals.at(-1)?.amount !== coreStakeBeforeMax) {
    throw new Error(
      `Expected MAX unstake amount ${coreStakeBeforeMax}, got ${chain.state.pendingWithdrawals.at(-1)?.amount}`,
    )
  }
  await driver.claimWithdrawal()
  await driver.expectSafeBalance(formatSafeAmount(safeBalanceBeforeClaim + coreStakeBeforeMax))
}

async function runStakeFlow(driver) {
  const signCountBefore = await driver.walletPersonalSignCount()
  await driver.stake({ amount: "10" })
  const signCountAfter = await driver.walletPersonalSignCount()
  if (signCountAfter !== signCountBefore) {
    throw new Error(
      `Expected regular stake to reuse RPC auth session, got ${signCountAfter - signCountBefore} signatures`,
    )
  }
  await driver.expectRecentRpcRequestsAuthorized(2)
  await driver.expectSafeBalance(formatSafeAmount(chain.state.safeBalance))
  await driver.expectValidatorStake({ amount: "10" })
  await driver.expectSummary({
    safeBalance: formatSafeAmountForSummary(chain.state.safeBalance),
    totalStaked: formatSafeAmountForSummary(totalStaked(chain)),
  })
  await driver.expectLastTxSequence(["approve", "stake"])
}

async function runUnstakeFlow(driver, chain) {
  await driver.unstake({ amount: "5" })
  await driver.expectValidatorStake({ amount: "5" })
  await driver.expectPendingWithdrawal("5")
  await driver.expectSummary({
    claimableWithdrawals: "5.00 SAFE",
    totalStaked: formatSafeAmountForSummary(totalStaked(chain)),
  })
}

async function runClaimWithdrawalFlow(driver) {
  await driver.claimWithdrawal()
  await driver.expectNoPendingWithdrawals()
  await driver.expectSafeBalance(formatSafeAmount(chain.state.safeBalance))
  await driver.expectSummary({ safeBalance: formatSafeAmountForSummary(chain.state.safeBalance) })
}

async function runClaimRewardsAndStakeFlow(driver, chain) {
  const rewardAmount = 3_456_789_123_456_789_123n
  chain.state.rewardCumulativeAmount = chain.state.cumulativeClaimed + rewardAmount
  const expectedCumulativeClaimed = chain.state.rewardCumulativeAmount
  await driver.claimRewardsAndStake()
  await driver.expectCumulativeClaimed(formatSafeAmount(expectedCumulativeClaimed))
  await driver.expectSafeBalance(formatSafeAmount(chain.state.safeBalance))
  await driver.expectValidatorStake({ amount: formatSafeAmount(chain.state.validators[0].userStake) })
  await driver.expectLastTxSequence(["claimRewards", "approve", "stake"])
  await driver.expectLastStakeAmount(formatSafeAmount(rewardAmount))
  await driver.expectSummary({
    claimableRewards: "0.00",
    safeBalance: formatSafeAmountForSummary(chain.state.safeBalance),
    totalStaked: formatSafeAmountForSummary(totalStaked(chain)),
  })
  chain.state.rewardCumulativeAmount = chain.state.cumulativeClaimed + 8n * 10n ** 18n
}

async function runClaimRewardsFlow(driver) {
  const expectedCumulativeClaimed = chain.state.rewardCumulativeAmount
  const beforeTabClick = (await driver.walletTransactions()).length
  await driver.selectDashboardAction("Claim Rewards")
  await driver.expectWalletTxCount(beforeTabClick)
  await driver.submitPrimaryAction()
  await driver.expectCumulativeClaimed(formatSafeAmount(expectedCumulativeClaimed))
  await driver.expectSafeBalance(formatSafeAmount(chain.state.safeBalance))
  await driver.expectSummary({
    claimableRewards: "0.00",
    safeBalance: formatSafeAmountForSummary(chain.state.safeBalance),
  })
}

async function runAgentFlow(page) {
  await page.getByRole("button", { name: "Open Staking Agent" }).click()
  const dialog = page.getByRole("dialog", { name: "Staking Agent" })
  await dialog.waitFor({ state: "visible" })
  await expectAgentLauncherHidden(page)
  const beforeChatRequests = chain.state.agentRequests
  await dialog.getByLabel("Message the staking agent").fill("hello")
  await dialog.getByRole("button", { name: "Send" }).click()
  await waitForDialogText(dialog, "Mock Agent stream complete. Every transaction still needs wallet confirmation.")
  await expectLatestThinkingCollapsed(dialog)
  await dialog.getByRole("button", { name: "Show reasoning" }).last().click()
  await dialog.getByText("Mock model reasoning for this staking response.").waitFor()
  await dialog.getByRole("button", { name: "Hide reasoning" }).last().click()
  await expectLatestThinkingCollapsed(dialog)
  if (chain.state.agentRequests <= beforeChatRequests) {
    throw new Error("Expected general Agent chat to call /api/agent")
  }
  await dialog.waitFor({ state: "visible" })
  await dialog.getByRole("button", { name: "Close agent" }).click()
  await dialog.waitFor({ state: "hidden" })
}

async function runAgentRestakeActionFlow(page, driver, chain) {
  chain.state.rewardCumulativeAmount = chain.state.cumulativeClaimed + 2_500_000_000_000_000_000n
  await driver.clearAgentSessions()
  await driver.refreshLiveData()
  await driver.expectSummary({ claimableRewards: "2.50" })
  await page.getByRole("button", { name: "Open Staking Agent" }).click()
  const dialog = page.getByRole("dialog", { name: "Staking Agent" })
  await dialog.waitFor({ state: "visible" })
  await dialog.getByLabel("Message the staking agent").fill("复投")
  await dialog.getByRole("button", { name: "Send" }).click()
  await waitForDialogText(dialog, "Which validator should receive the restaked rewards?")
  await dialog.getByLabel("Message the staking agent").fill("全部复投到 Gnosis")
  await dialog.getByRole("button", { name: "Send" }).click()
  await waitForDialogText(dialog, "Ready to review")
  await waitForDialogText(dialog, "Claim staking rewards")
  await waitForDialogText(dialog, "Restake 2.5 SAFE to Gnosis")
  await dialog.getByLabel("I reviewed the warnings and transaction order.").check()
  const confirmButton = dialog.getByRole("button", { name: "Open wallet to confirm" })
  await confirmButton.waitFor()
  if (await confirmButton.isDisabled()) {
    throw new Error(
      `Expected Agent confirm button to be enabled.\n${await dialog.innerText()}\nRecent RPC calls:\n${JSON.stringify(
        chain.state.rpcCalls.slice(-12),
        null,
        2,
      )}`,
    )
  }
  await dialog.getByLabel("Message the staking agent").fill("继续")
  await dialog.getByRole("button", { name: "Send" }).click()
  try {
    await driver.expectLastTxSequence(["claimRewards", "approve", "stake"])
  } catch (error) {
    const txs = await driver.walletTransactions()
    const notifications = await page
      .locator("[data-sonner-toast]")
      .allInnerTexts()
      .catch(() => [])
    throw new Error(
      `Expected Agent confirm to send wallet transactions, got ${txs.length}.\nDialog:\n${await dialog.innerText()}\nNotifications:\n${notifications.join("\n")}\n${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  await driver.expectLastStakeAmount("2.5")
  await dialog.getByRole("button", { name: "Close agent" }).click()
  await dialog.waitFor({ state: "hidden" })
}

async function expectAgentLauncherHidden(page) {
  await page.waitForFunction(() => {
    const launcher = document.querySelector(".agent-launcher")
    if (!(launcher instanceof HTMLElement)) return false
    const styles = getComputedStyle(launcher)
    return styles.opacity === "0" && styles.pointerEvents === "none"
  })
}

async function expectLatestThinkingCollapsed(dialog) {
  const latestThinkingToggle = dialog.getByRole("button", { name: "Show reasoning" }).last()
  await latestThinkingToggle.waitFor()
  const expanded = await latestThinkingToggle.getAttribute("aria-expanded")
  if (expanded !== "false") throw new Error(`Expected latest Agent reasoning to be collapsed, got ${expanded}`)
}

async function runScenario(name, fn) {
  console.log(`[live-mock] ${name}`)
  await fn()
}

async function waitForDialogText(dialog, text) {
  try {
    await dialog.getByText(text).last().waitFor()
  } catch (error) {
    const dialogText = await dialog.innerText().catch(() => "<dialog text unavailable>")
    throw new Error(
      `Expected Agent dialog text "${text}". Agent API calls: ${chain.state.agentRequests}.\n${dialogText}\n${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function startServer(mode, port) {
  if (mode === "external") return null
  if (mode === "dev") {
    return spawn("pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", String(port)], {
      env: {
        ...process.env,
        SAFECAFE_AUTH_SECRET: process.env.SAFECAFE_AUTH_SECRET ?? "safecafe-live-mock-auth-secret",
        SAFECAFE_RPC_ALLOW_ALL_WALLETS: process.env.SAFECAFE_RPC_ALLOW_ALL_WALLETS ?? "true",
        VITE_AGENT_LAUNCHER_DRAGGABLE: process.env.VITE_AGENT_LAUNCHER_DRAGGABLE ?? "true",
        VITE_RPC_URL: process.env.VITE_RPC_URL ?? "/api/rpc/ethereum",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
  }
  if (mode === "wrangler") {
    return spawn(
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
        String(port),
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
  }
  throw new Error(`Unsupported live mock server mode: ${mode}`)
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
    if (processHandle && processHandle.exitCode !== null) {
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

async function stopServer(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return
  processHandle.kill("SIGTERM")
  await Promise.race([once(processHandle, "exit"), wait(2_000)])
  if (processHandle.exitCode === null) processHandle.kill("SIGKILL")
}

function parseArgs(rawArgs) {
  const parsed = { headful: false, server: undefined, url: undefined }
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]
    if (arg === "--headful") {
      parsed.headful = true
      continue
    }
    if (arg === "--server") {
      parsed.server = rawArgs[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith("--server=")) {
      parsed.server = arg.slice("--server=".length)
      continue
    }
    if (arg === "--url") {
      parsed.url = rawArgs[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith("--url=")) {
      parsed.url = arg.slice("--url=".length)
      continue
    }
    throw new Error(`Unknown live mock argument: ${arg}`)
  }
  return parsed
}

function resolveServerMode(parsedArgs) {
  const mode = parsedArgs.server ?? process.env.E2E_SERVER ?? (process.env.E2E_BASE_URL ? "external" : "dev")
  if (mode !== "dev" && mode !== "wrangler" && mode !== "external") {
    throw new Error(`E2E server mode must be dev, wrangler, or external. Received: ${mode}`)
  }
  if (mode === "external" && !parsedArgs.url && !process.env.E2E_BASE_URL) {
    throw new Error("External live mock mode requires --url or E2E_BASE_URL.")
  }
  return mode
}

function formatSafeAmount(value) {
  const whole = value / 10n ** 18n
  const fraction = (value % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : String(whole)
}

function formatSafeAmountForSummary(value) {
  const scaled = (value + 5n * 10n ** 15n) / 10n ** 16n
  return `${scaled / 100n}.${(scaled % 100n).toString().padStart(2, "0")}`
}

function totalStaked(mockChain) {
  return mockChain.state.validators.reduce((sum, validator) => sum + validator.userStake, 0n)
}
