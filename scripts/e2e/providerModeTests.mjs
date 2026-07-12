import { privateKeyToAccount } from "viem/accounts"
import { createMockChain } from "./mockChain.mjs"
import { createWebTestDriver } from "./webTestDriver.mjs"

const account = privateKeyToAccount(`0x${"55".repeat(32)}`)
const customRpcUrl = "https://custom-rpc.example"
const customLlmBase = "https://custom-llm.example/v1"
const userSafeApiKey = "user-safe-api-key"

export async function runProviderModeTests({ baseUrl, browser }) {
  await runScenario("custom RPC bypasses Safecafe chain-data APIs", () => runCustomRpcMode({ baseUrl, browser }))
  await runScenario("custom LLM bypasses Safecafe Agent API", () => runCustomLlmMode({ baseUrl, browser }))
  await runScenario("user Safe API key bypasses Safecafe Safe proxy", () => runUserSafeApiMode({ baseUrl, browser }))
  await runScenario("invalid user Safe API key is rejected on first Safe request", () =>
    runInvalidUserSafeApiMode({ baseUrl, browser }),
  )
}

async function runCustomRpcMode({ baseUrl, browser }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } })
  const page = await context.newPage()
  const errors = collectPageErrors(page)
  const chain = createMockChain({ account: account.address })
  const driver = createWebTestDriver({ account: account.address, baseUrl, chain, page })
  let accountLiveCalls = 0
  let gatewayCalls = 0
  let customRpcCalls = 0
  try {
    await driver.install()
    await page.addInitScript(({ rpcUrl }) => window.localStorage.setItem("safecafe:custom-rpc-url", rpcUrl), {
      rpcUrl: customRpcUrl,
    })
    await page.route("**/api/account/live?**", async (route) => {
      accountLiveCalls += 1
      await chain.fulfillAccountLive(route)
    })
    await page.route("**/api/rpc/ethereum", async (route) => {
      gatewayCalls += 1
      await chain.fulfillRpc(route)
    })
    await page.route(`${customRpcUrl}/**`, async (route) => {
      customRpcCalls += 1
      await chain.fulfillRpc(route)
    })

    await page.goto(`${baseUrl}/settings`, { waitUntil: "networkidle" })
    await page.getByText("Custom RPC is active.").waitFor()
    try {
      await driver.expectSummary({ safeBalance: "100.00" })
    } catch (error) {
      throw new Error(
        `Custom RPC did not load live data. custom=${customRpcCalls}, accountLive=${accountLiveCalls}, gateway=${gatewayCalls}, rpc=${JSON.stringify(
          chain.state.rpcCalls,
        )}, errors=${JSON.stringify(errors)}. ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    await driver.stake({ amount: "1" })

    if (customRpcCalls === 0) throw new Error("Expected custom RPC mode to call the configured RPC URL")
    if (accountLiveCalls !== 0 || gatewayCalls !== 0) {
      throw new Error(
        `Expected custom RPC mode to bypass Safecafe chain-data APIs, got accountLive=${accountLiveCalls}, gateway=${gatewayCalls}`,
      )
    }
    if ((await driver.walletPersonalSignCount()) !== 0) {
      throw new Error("Expected custom RPC mode not to request Safecafe gateway authentication")
    }
    assertNoPageErrors(errors, "custom RPC")
  } finally {
    await context.close()
  }
}

async function runCustomLlmMode({ baseUrl, browser }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } })
  const page = await context.newPage()
  const errors = collectPageErrors(page)
  const chain = createMockChain({ account: account.address })
  const driver = createWebTestDriver({ account: account.address, baseUrl, chain, page })
  let agentApiCalls = 0
  let customLlmCalls = 0
  let customLlmAuthorized = false
  try {
    await driver.install()
    await page.addInitScript(
      ({ apiBase }) => {
        window.localStorage.setItem(
          "safecafe:user-llm-config",
          JSON.stringify({ apiBase, apiKey: "user-llm-key", maxTokens: 256, model: "user-model" }),
        )
      },
      { apiBase: customLlmBase },
    )
    await page.route("**/api/agent", async (route) => {
      agentApiCalls += 1
      await chain.fulfillAgent(route)
    })
    await page.route(`${customLlmBase}/chat/completions`, async (route) => {
      customLlmCalls += 1
      customLlmAuthorized = route.request().headers().authorization === "Bearer user-llm-key"
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
        body: 'data: {"choices":[{"delta":{"content":"Custom provider reply."}}]}\n\ndata: [DONE]\n\n',
      })
    })

    await driver.open()
    await driver.expectSummary({ safeBalance: "100.00" })
    await page.getByRole("button", { name: "Open Staking Agent" }).click()
    const dialog = page.getByRole("dialog", { name: "Staking Agent" })
    await dialog.waitFor({ state: "visible" })
    await dialog.getByRole("button", { name: "Using custom LLM" }).waitFor()
    await dialog.getByLabel("Message the staking agent").fill("hello from custom provider")
    await dialog.getByRole("button", { name: "Send" }).click()
    await dialog.getByText("Custom provider reply.").waitFor()

    if (customLlmCalls === 0 || !customLlmAuthorized) {
      throw new Error("Expected custom LLM mode to call the configured provider with the user API key")
    }
    if (agentApiCalls !== 0) throw new Error(`Expected custom LLM mode to bypass /api/agent, got ${agentApiCalls}`)
    if ((await driver.walletPersonalSignCount()) !== 0) {
      throw new Error("Expected custom LLM chat not to request Safecafe Agent authentication")
    }
    assertNoPageErrors(errors, "custom LLM")
  } finally {
    await context.close()
  }
}

async function runUserSafeApiMode({ baseUrl, browser }) {
  const safeAddress = "0x1111111111111111111111111111111111111111"
  const secondOwner = "0x2222222222222222222222222222222222222222"
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } })
  const page = await context.newPage()
  const errors = collectPageErrors(page)
  const chain = createMockChain({
    account: account.address,
    safeOwners: [account.address, secondOwner],
    safeThreshold: 2n,
    safes: [safeAddress],
    stakingAllowance: 2n * 10n ** 18n,
  })
  const driver = createWebTestDriver({ account: account.address, baseUrl, chain, page })
  let backendSafeCalls = 0
  let directSafeCalls = 0
  let directSafeAuthorized = true
  let proposal = null
  try {
    await driver.install()
    await page.addInitScript(
      ({ apiKey, safe, signer }) => {
        window.localStorage.setItem("safecafe:user-safe-api-key", apiKey)
        window.localStorage.setItem("safecafe:wallet-subjects", JSON.stringify({ [signer.toLowerCase()]: safe }))
      },
      { apiKey: userSafeApiKey, safe: safeAddress, signer: account.address },
    )
    await page.route("**/api/safe/transaction", async (route) => {
      backendSafeCalls += 1
      await chain.fulfillSafeTxService(route)
    })
    await page.route("https://api.safe.global/tx-service/eth/api/**", async (route) => {
      directSafeCalls += 1
      directSafeAuthorized &&= route.request().headers().authorization === `Bearer ${userSafeApiKey}`
      const request = route.request()
      const url = new URL(request.url())
      if (request.method() === "GET" && url.pathname.endsWith("/confirmations/")) {
        if (!proposal) {
          await route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({ detail: "Not found" }),
          })
          return
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ results: [{ owner: proposal.sender, signature: proposal.signature }] }),
        })
        return
      }
      if (request.method() === "POST" && url.pathname.includes(`/v2/safes/${safeAddress}/multisig-transactions/`)) {
        proposal = request.postDataJSON()
        await route.fulfill({ status: 201, contentType: "application/json", body: "{}" })
        return
      }
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Unexpected" }),
      })
    })

    await driver.open()
    await driver.expectSummary({ safeBalance: "100.00" })
    await driver.stake({ amount: "1" })
    const proposalCard = page.locator(".execution-safe-proposal")
    await proposalCard.getByText("Safe proposal pending").waitFor()
    await proposalCard.getByText(/1\/2/).waitFor()

    if (directSafeCalls === 0 || !directSafeAuthorized || !proposal) {
      throw new Error("Expected user Safe API mode to call Safe Transaction Service directly with the user API key")
    }
    if (backendSafeCalls !== 0) {
      throw new Error(`Expected user Safe API mode to bypass /api/safe/transaction, got ${backendSafeCalls}`)
    }
    assertNoPageErrors(errors, "user Safe API")
  } finally {
    await context.close()
  }
}

async function runInvalidUserSafeApiMode({ baseUrl, browser }) {
  const safeAddress = "0x1111111111111111111111111111111111111111"
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } })
  const page = await context.newPage()
  const errors = collectPageErrors(page)
  const chain = createMockChain({
    account: account.address,
    safeOwners: [account.address, "0x2222222222222222222222222222222222222222"],
    safeThreshold: 2n,
    safes: [safeAddress],
    stakingAllowance: 2n * 10n ** 18n,
  })
  const driver = createWebTestDriver({ account: account.address, baseUrl, chain, page })
  try {
    await driver.install()
    await page.addInitScript(
      ({ apiKey, safe, signer }) => {
        window.localStorage.setItem("safecafe:user-safe-api-key", apiKey)
        window.localStorage.setItem("safecafe:wallet-subjects", JSON.stringify({ [signer.toLowerCase()]: safe }))
      },
      { apiKey: userSafeApiKey, safe: safeAddress, signer: account.address },
    )
    await page.route("https://api.safe.global/tx-service/eth/api/**", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Invalid API key" }),
      }),
    )

    await driver.open()
    await driver.expectSummary({ safeBalance: "100.00" })
    await driver.stake({ amount: "1" })
    const invalidKeyMessage =
      "Safe API key is invalid or not allowed. Update your Safe API key in Settings, or try again later."
    await page.getByText(invalidKeyMessage).first().waitFor()
    const storedKey = await page.evaluate(() => window.localStorage.getItem("safecafe:user-safe-api-key"))
    if (storedKey !== null) throw new Error("Expected a rejected user Safe API key to be removed from storage")
    await page.getByRole("button", { exact: true, name: "Settings" }).click()
    await page
      .locator(".llm-settings-panel", { hasText: "Safe Transaction Service" })
      .getByText(invalidKeyMessage)
      .waitFor()
    const unexpectedErrors = errors.filter(
      (error) => !error.includes("server responded with a status of 401 (Unauthorized)"),
    )
    assertNoPageErrors(unexpectedErrors, "invalid user Safe API")
  } finally {
    await context.close()
  }
}

function collectPageErrors(page) {
  const errors = []
  page.on("console", (message) => {
    const value = message.text()
    if (message.type() === "error" && !value.includes("404 (Not Found)")) errors.push(value)
  })
  page.on("pageerror", (error) => errors.push(error.message))
  return errors
}

function assertNoPageErrors(errors, mode) {
  if (errors.length > 0) throw new Error(`Unexpected ${mode} browser errors: ${errors.join("\n")}`)
}

async function runScenario(name, callback) {
  console.log(`[provider-mode] ${name}`)
  await callback()
}
