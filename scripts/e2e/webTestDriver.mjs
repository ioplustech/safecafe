import { decodeFunctionData, parseAbi } from "viem"
import { mockValidators, stringifyBigints } from "./mockChain.mjs"

const eth = 10n ** 18n
const transactionAbis = [
  parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
  parseAbi([
    "function stake(address validator, uint256 amount)",
    "function initiateWithdrawal(address validator, uint256 amount)",
    "function claimWithdrawal()",
  ]),
  parseAbi([
    "function claim(address account, uint256 cumulativeAmount, bytes32 expectedMerkleRoot, bytes32[] merkleProof)",
  ]),
]

export function createWebTestDriver({ account, baseUrl, chain, page }) {
  if (!account) throw new Error("createWebTestDriver requires account")
  if (!baseUrl) throw new Error("createWebTestDriver requires baseUrl")
  if (!chain) throw new Error("createWebTestDriver requires chain")
  if (!page) throw new Error("createWebTestDriver requires page")

  async function install() {
    await installCleanStorage(page)
    await chain.installWallet(page, typeof account === "string" ? account : account.address)
    await installInternalApiMocks(page, chain)
  }

  async function open() {
    await page.goto(baseUrl, { waitUntil: "networkidle" })
  }

  async function connectWallet() {
    const connectButton = page.getByRole("button", { name: "Connect wallet" }).first()
    if ((await connectButton.count()) > 0) await connectButton.click()
  }

  async function openAndConnect() {
    await install()
    await open()
    await connectWallet()
  }

  async function stake({ amount, validatorLabel = mockValidators[0].label }) {
    await openDashboard()
    await selectValidatorAction({ action: "Stake", validatorLabel })
    await page.getByLabel(/Stake Amount/).fill(String(amount))
    await submitPrimaryAction()
  }

  async function unstake({ amount, validatorLabel = mockValidators[0].label }) {
    await openDashboard()
    await selectValidatorAction({ action: "Unstake", validatorLabel })
    await page.getByLabel(/Unstake Amount/).fill(String(amount))
    await submitPrimaryAction()
  }

  async function claimWithdrawal() {
    await page.getByRole("button", { exact: true, name: "Withdrawals" }).click()
    await page.getByRole("button", { name: "Claim Withdrawals" }).click()
  }

  async function claimRewards() {
    await page.getByRole("button", { exact: true, name: "Rewards" }).click()
    await page.getByRole("button", { name: "Claim to wallet" }).click()
  }

  async function claimRewardsAndStake() {
    await selectDashboardAction("Claim Rewards")
    await page.locator(".primary-actions-panel .feature-button").click()
  }

  async function selectDashboardAction(action) {
    await openDashboard()
    await page.locator(".primary-actions-panel .action-button", { hasText: action }).first().click()
  }

  async function fillActionAmount(amount) {
    await page.locator(".primary-actions-panel input").fill(String(amount))
  }

  async function clickActionMax() {
    const input = page.locator(".primary-actions-panel .amount-input-wrap input")
    await page.locator(".primary-actions-panel .amount-input-wrap button", { hasText: "MAX" }).click()
    let currentValue = ""
    await expectEventually(async () => {
      currentValue = await input.inputValue()
      return currentValue.trim().length > 0 && currentValue !== "0"
    }, "Expected MAX to fill the action amount input.")
    await expectEventually(async () => {
      const previewText = await page.locator(".primary-actions-panel .transaction-preview").innerText()
      return previewText.includes(formatSafeAmountForSummary(toWei(currentValue)))
    }, "Expected transaction preview to reflect the MAX amount.")
  }

  async function expectDashboardActionActive(action) {
    await openDashboard()
    const actionButton = page.locator(".primary-actions-panel .action-button", { hasText: action }).first()
    await actionButton.waitFor()
    const className = await actionButton.getAttribute("class")
    if (!className?.split(/\s+/).includes("active")) {
      throw new Error(`Expected Dashboard action ${action} to be active, got class "${className ?? ""}"`)
    }
  }

  async function expectActionSelectDetail({ action, expectedText }) {
    await selectDashboardAction(action)
    const selectText = await page.locator(".primary-actions-panel .custom-select").innerText()
    if (!selectText.includes(expectedText)) {
      throw new Error(`Expected ${action} validator select to include "${expectedText}", got "${selectText}"`)
    }
  }

  async function expectCurrentActionSelectDetail(expectedText) {
    const selectText = await page.locator(".primary-actions-panel .custom-select").innerText()
    if (!selectText.includes(expectedText)) {
      throw new Error(`Expected current validator select to include "${expectedText}", got "${selectText}"`)
    }
  }

  async function expectOverviewValidatorPosition({ validatorLabel, amount }) {
    await openDashboard()
    await expectEventually(
      async () => {
        const text = await page.locator("body").innerText()
        return text.includes(validatorLabel) && text.includes(`${amount} SAFE`)
      },
      async () =>
        `Expected overview panel to show ${validatorLabel} ${amount} SAFE. Body=${JSON.stringify(
          (await page.locator("body").innerText()).slice(0, 2000),
        )}`,
    )
  }

  async function expectSummary({ claimableRewards, claimableWithdrawals, safeBalance, totalStaked }) {
    if (safeBalance !== undefined || totalStaked !== undefined) await openDashboard()
    if (safeBalance !== undefined) await waitForBodyText(page, `SAFE Balance\n${safeBalance}`)
    if (totalStaked !== undefined) await waitForBodyText(page, `Total Staked\n${totalStaked}`)
    if (claimableWithdrawals !== undefined) {
      await page.getByRole("button", { exact: true, name: "Withdrawals" }).click()
      await waitForBodyText(page, `Claimable Withdrawals\n${claimableWithdrawals}`)
    }
    if (claimableRewards !== undefined) {
      await page.getByRole("button", { exact: true, name: "Rewards" }).click()
      await waitForBodyText(page, `Claimable Rewards\n${claimableRewards}`)
    }
  }

  async function expectWalletTxCount(count) {
    await expectEventually(
      async () => {
        const txs = await walletTransactions()
        return txs.length === count
      },
      async () => `Expected ${count} wallet transactions, got ${stringifyBigints(await walletTransactions())}`,
    )
  }

  async function expectTxSequence(labels) {
    await expectWalletTxCount(labels.length)
    const actual = (await walletTransactions()).map((entry) => labelTransaction(entry.tx))
    if (actual.join(",") !== labels.join(",")) {
      throw new Error(`Expected wallet tx sequence ${labels.join(",")}, got ${actual.join(",")}`)
    }
  }

  async function expectLastTxSequence(labels) {
    await expectEventually(
      async () => {
        const txs = await walletTransactions()
        if (txs.length < labels.length) return false
        const actual = txs.slice(-labels.length).map((entry) => labelTransaction(entry.tx))
        return actual.join(",") === labels.join(",")
      },
      async () => {
        const actual = (await walletTransactions()).map((entry) => labelTransaction(entry.tx))
        return `Expected wallet tx suffix ${labels.join(",")}, got ${actual.join(",")}`
      },
    )
  }

  async function expectLastStakeAmount(amount) {
    await expectEventually(
      async () => {
        const txs = await walletTransactions()
        const stakeTx = [...txs].reverse().find((entry) => labelTransaction(entry.tx) === "stake")
        if (!stakeTx) return false
        const decoded = decodeKnownTransaction(stakeTx.tx)
        return decoded?.functionName === "stake" && decoded.args[1] === toWei(amount)
      },
      async () => `Expected last stake amount ${amount}, got ${stringifyBigints(await walletTransactions())}`,
    )
  }

  async function expectSafeBalance(amount) {
    await expectEventually(
      () => chain.state.safeBalance === toWei(amount),
      () => `Expected SAFE balance ${amount}, got ${chain.state.safeBalance}`,
    )
  }

  async function expectTotalStaked(amount) {
    await expectEventually(
      () => chain.state.validators.reduce((sum, validator) => sum + validator.userStake, 0n) === toWei(amount),
      () => `Expected total staked ${amount}, got ${chain.state.validators.map((item) => item.userStake).join(",")}`,
    )
  }

  async function expectValidatorStake({ amount, validatorLabel = mockValidators[0].label }) {
    await expectEventually(
      () => validatorState(validatorLabel).userStake === toWei(amount),
      async () =>
        `Expected ${validatorLabel} stake ${amount}, got ${validatorState(validatorLabel).userStake}. ` +
        `Submit=${await page
          .locator(".primary-actions-panel .form-row .primary-button")
          .first()
          .innerText()
          .catch(() => "<unavailable>")}. ` +
        `Input=${await page
          .locator(".primary-actions-panel .amount-input-wrap input")
          .inputValue()
          .catch(() => "<unavailable>")}. ` +
        `Notices=${JSON.stringify(await page.evaluate(() => window.__lastSubmitNotices ?? []).catch(() => []))}. ` +
        `RpcCalls=${stringifyBigints(chain.state.rpcCalls.slice(-12))}. ` +
        `Txs=${stringifyBigints(await walletTransactions())}. ` +
        `Pending=${stringifyBigints(chain.state.pendingWithdrawals)}`,
    )
  }

  async function expectPendingWithdrawal(amount) {
    await expectEventually(
      () => chain.state.pendingWithdrawals.some((item) => item.amount === toWei(amount)),
      () => `Expected pending withdrawal ${amount}, got ${stringifyBigints(chain.state.pendingWithdrawals)}`,
    )
  }

  async function expectNoPendingWithdrawals() {
    await expectEventually(
      () => chain.state.pendingWithdrawals.length === 0,
      () => `Expected no pending withdrawals, got ${stringifyBigints(chain.state.pendingWithdrawals)}`,
    )
  }

  async function expectCumulativeClaimed(amount) {
    await expectEventually(
      () => chain.state.cumulativeClaimed === toWei(amount),
      () => `Expected cumulative claimed ${amount}, got ${chain.state.cumulativeClaimed}`,
    )
  }

  async function walletTransactions() {
    return page.evaluate(() => window.__mockWalletTransactions ?? [])
  }

  async function walletPersonalSignCount() {
    return page.evaluate(() => window.__mockWalletPersonalSignCount ?? 0)
  }

  async function expectWalletPersonalSignCountAtLeast(count) {
    await expectEventually(
      async () => (await walletPersonalSignCount()) >= count,
      async () => `Expected at least ${count} personal_sign calls, got ${await walletPersonalSignCount()}`,
    )
  }

  async function expectRecentRpcRequestsAuthorized(count) {
    await expectEventually(
      () => {
        const recent = chain.state.rpcRequests.slice(-count)
        return recent.length >= count && recent.every((request) => request.authorization?.startsWith("Bearer "))
      },
      () =>
        `Expected last ${count} RPC gateway requests to be authorized, got ${stringifyBigints(
          chain.state.rpcRequests.slice(-count),
        )}`,
    )
  }

  async function clearRpcSession() {
    await page.evaluate(() => window.localStorage.removeItem("safecafe:rpc-session"))
  }

  async function clearAgentSessions() {
    await page.evaluate(() => {
      window.localStorage.removeItem("safecafe:agent:sessions")
      window.localStorage.removeItem("safecafe:agent:active-session")
    })
  }

  async function refreshLiveData() {
    const refreshButton = page.getByRole("button", { name: /Refresh SAFE balance and stake|刷新/ }).first()
    if ((await refreshButton.count()) > 0 && (await refreshButton.isVisible().catch(() => false))) {
      await refreshButton.click()
      await page.waitForLoadState("networkidle").catch(() => undefined)
      return
    }
    await page.reload({ waitUntil: "networkidle" })
  }

  async function expectNoVisibleText(text) {
    const matches = page.getByText(text)
    const count = await matches.count()
    for (let index = 0; index < count; index += 1) {
      if (await matches.nth(index).isVisible()) throw new Error(`Expected text not to be visible: ${text}`)
    }
  }

  async function selectValidatorAction({ action, validatorLabel }) {
    const validator = page.locator(".validator-row", { hasText: validatorLabel }).first()
    const actionLabel = action === "Stake" ? /^(Stake|Prepare stake)$/ : /^(Unstake|Prepare unstake)$/
    if ((await validator.count()) > 0) {
      await validator.getByRole("button", { name: actionLabel }).click()
      return
    }
    await page.getByRole("button", { name: actionLabel }).first().click()
  }

  async function selectValidatorTableAction({ action, validatorLabel }) {
    await page
      .getByRole("navigation", { name: "Primary navigation" })
      .getByRole("button", { name: "Validators" })
      .click()
    await selectValidatorAction({ action, validatorLabel })
    await expectCurrentActionSelectDetail(validatorLabel)
  }

  async function submitPrimaryAction() {
    const action = await page.locator(".primary-actions-panel .action-button.active strong").innerText()
    const submitLabel = action === "Claim Rewards" ? "Claim to wallet" : action
    const button = page.locator(".primary-actions-panel .form-row").getByRole("button", { name: submitLabel }).first()
    const txCountBefore = (await walletTransactions()).length
    await expectEventually(async () => !(await button.isDisabled()), "Expected primary action button to be enabled.")
    await button.click()
    await expectEventually(async () => {
      const txCountAfter = (await walletTransactions()).length
      const notices = await page
        .locator("[data-sonner-toast]")
        .allInnerTexts()
        .catch(() => [])
      await page.evaluate((items) => {
        window.__lastSubmitNotices = items
      }, notices)
      return txCountAfter > txCountBefore || notices.length > 0
    }, `Expected ${action} submit to produce a wallet transaction or notification.`)
  }

  async function openDashboard() {
    await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: "Overview" }).click()
  }

  function validatorState(label) {
    const validator = chain.state.validators.find((item) => item.label === label)
    if (!validator) throw new Error(`Unknown validator label ${label}`)
    return validator
  }

  return {
    clickActionMax,
    claimRewards,
    claimRewardsAndStake,
    claimWithdrawal,
    clearRpcSession,
    clearAgentSessions,
    connectWallet,
    expectCumulativeClaimed,
    expectActionSelectDetail,
    expectCurrentActionSelectDetail,
    expectDashboardActionActive,
    expectNoVisibleText,
    expectNoPendingWithdrawals,
    expectOverviewValidatorPosition,
    expectPendingWithdrawal,
    expectRecentRpcRequestsAuthorized,
    expectSafeBalance,
    expectSummary,
    expectTotalStaked,
    expectLastTxSequence,
    expectLastStakeAmount,
    expectTxSequence,
    expectValidatorStake,
    expectWalletPersonalSignCountAtLeast,
    expectWalletTxCount,
    install,
    open,
    openAndConnect,
    fillActionAmount,
    refreshLiveData,
    selectDashboardAction,
    selectValidatorTableAction,
    stake,
    submitPrimaryAction,
    unstake,
    walletPersonalSignCount,
    walletTransactions,
  }
}

async function installCleanStorage(page) {
  await page.addInitScript(() => {
    window.localStorage.removeItem("safecafe:agent:sessions")
    window.localStorage.removeItem("safecafe:agent:active-session")
  })
}

export async function installInternalApiMocks(page, chain) {
  await page.route("**/api/account/live?**", (route) => chain.fulfillAccountLive(route))
  await page.route("**/api/agent", (route) => chain.fulfillAgent(route))
  await page.route("**/api/auth/challenge", (route) => chain.fulfillAuthChallenge(route))
  await page.route("**/api/auth/verify", (route) => chain.fulfillAuthVerify(route))
  await page.route("**/api/price/safe", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: "CoinGecko", usd: 0.0927, fetchedAt: Date.now() }),
    }),
  )
  await page.route("**/api/safes?**", (route) => chain.fulfillSafes(route))
  await page.route("**/api/validators", (route) => chain.fulfillValidatorsApi(route))
  await page.route("**/api/rewards/proof?**", (route) => chain.fulfillRewardProof(route))
  await page.route("**/api/rpc/ethereum", (route) => chain.fulfillRpc(route))
  await page.route("**/assets/validator-info.json", (route) => chain.fulfillValidators(route))
  await page.route("**/proofs/**", (route) => chain.fulfillRewardProof(route))
}

export const installRoutes = installInternalApiMocks

export async function waitForBodyText(page, text) {
  await expectEventually(
    async () => {
      const body = await page.locator("body").innerText()
      return body.includes(text)
    },
    async () =>
      `Expected body text ${JSON.stringify(text)}. Body=${JSON.stringify(
        (await page.locator("body").innerText()).slice(0, 2200),
      )}`,
  )
}

export async function expectEventually(assertion, message) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await assertion()) return
    await wait(100)
  }
  throw new Error(typeof message === "function" ? await message() : message)
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function labelTransaction(tx) {
  const decoded = decodeKnownTransaction(tx)
  if (!decoded) return "unknown"
  if (decoded.functionName === "claim") return "claimRewards"
  return decoded.functionName
}

function decodeKnownTransaction(tx) {
  for (const abi of transactionAbis) {
    try {
      return decodeFunctionData({ abi, data: tx?.data })
    } catch {
      // Try the next ABI.
    }
  }
  return null
}

function toWei(amount) {
  const [whole, fraction = ""] = String(amount).split(".")
  return BigInt(whole || "0") * eth + BigInt(fraction.padEnd(18, "0").slice(0, 18))
}

function formatSafeAmountForSummary(value) {
  return (Number(value) / Number(eth)).toFixed(2)
}
