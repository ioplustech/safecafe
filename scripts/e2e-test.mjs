import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { chromium } from "@playwright/test"
import { privateKeyToAccount } from "viem/accounts"

const previewPort = await getAvailablePort()
const baseUrl = process.env.E2E_BASE_URL || `http://127.0.0.1:${previewPort}`

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

async function mockSafePrice(page) {
  await page.route("**/api/price/safe", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ usd: 0.0927, fetchedAt: Date.now() }),
    }),
  )
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
        "SAFECAFE_AUTH_SECRET=safecafe-e2e-auth-secret",
        "--binding",
        "VITE_AGENT_LAUNCHER_DRAGGABLE=true",
        "--binding",
        `VITE_RPC_URL=${baseUrl}/api/rpc/ethereum`,
        "--compatibility-date",
        "2026-05-14",
        "--log-level",
        "error",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
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
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => {
    consoleErrors.push(error.message)
  })
  await mockSafePrice(page)
  await page.addInitScript(() => {
    const originalMeasure = performance.measure.bind(performance)
    performance.measure = (name, startOrMeasureOptions, endMark) => {
      const detail = typeof startOrMeasureOptions === "object" ? startOrMeasureOptions?.detail : undefined
      const properties = detail?.devtools?.properties
      if (Array.isArray(properties)) {
        for (const [_key, value] of properties) {
          if (typeof value === "string" && /^\[\d+n?(,\d+n?)*\]$/.test(value)) {
            throw new Error(`React devtools performance detail contains a bigint tuple: ${value}`)
          }
        }
      }
      return originalMeasure(name, startOrMeasureOptions, endMark)
    }
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

  const testAccount = privateKeyToAccount(`0x${"22".repeat(32)}`)
  const challengeResponse = await page.request.post(`${baseUrl}/api/auth/challenge`, {
    data: { address: testAccount.address, chainId: 1 },
  })
  if (!challengeResponse.ok())
    throw new Error(`Expected /api/auth/challenge to work, got ${challengeResponse.status()}`)
  const challenge = await challengeResponse.json()
  if (challenge.strategy !== "signed-wallet-access") {
    throw new Error(`Expected signed-wallet-access strategy, got ${challenge.strategy}`)
  }
  const signature = await testAccount.signMessage({ message: challenge.message })
  const verifyResponse = await page.request.post(`${baseUrl}/api/auth/verify`, {
    data: {
      address: testAccount.address,
      challenge: challenge.challenge,
      message: challenge.message,
      signature,
    },
  })
  if (!verifyResponse.ok()) throw new Error(`Expected /api/auth/verify to work, got ${verifyResponse.status()}`)
  const session = await verifyResponse.json()
  const rpcResponse = await page.request.post(`${baseUrl}/api/rpc/ethereum`, {
    headers: { authorization: `Bearer ${session.token}` },
    data: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
  })
  if (!rpcResponse.ok()) throw new Error(`Expected authenticated RPC to work, got ${rpcResponse.status()}`)
  const rpcJson = await rpcResponse.json()
  if (typeof rpcJson.result !== "string" || !rpcJson.result.startsWith("0x")) {
    throw new Error(`Expected eth_blockNumber hex result, got ${JSON.stringify(rpcJson)}`)
  }

  const restoreContext = await browser.newContext({ viewport: { width: 1280, height: 840 } })
  try {
    const restorePage = await restoreContext.newPage()
    const restoreErrors = []
    restorePage.on("console", (message) => {
      const text = message.text()
      if (message.type() === "error" && !text.includes("404 (Not Found)")) restoreErrors.push(text)
    })
    restorePage.on("pageerror", (error) => {
      restoreErrors.push(error.message)
    })
    await mockSafePrice(restorePage)
    await restorePage.addInitScript(
      ({ address, token }) => {
        const listeners = new Map()
        window.ethereum = {
          request: async ({ method, params }) => {
            if (method === "eth_chainId") return "0x1"
            if (method === "eth_accounts") return [address]
            if (method === "eth_requestAccounts") return [address]
            if (method === "personal_sign") throw new Error("Unexpected signature request during wallet restore")
            if (method === "wallet_switchEthereumChain") return null
            throw new Error(`Unexpected wallet method ${method} ${JSON.stringify(params)}`)
          },
          on: (event, handler) => {
            const current = listeners.get(event) ?? []
            current.push(handler)
            listeners.set(event, current)
          },
          removeListener: (event, handler) => {
            listeners.set(
              event,
              (listeners.get(event) ?? []).filter((item) => item !== handler),
            )
          },
        }
        window.localStorage.removeItem("safecafe:wallet-disconnected")
        window.localStorage.setItem(
          "safecafe:rpc-session",
          JSON.stringify({
            address,
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            signer: address,
            subject: address,
            subjectKind: "self",
            token,
          }),
        )
      },
      { address: testAccount.address, token: session.token },
    )
    let accountLiveCalls = 0
    await restorePage.route("**/api/account/live?**", async (route) => {
      accountLiveCalls += 1
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          health: {
            blockNumber: "123",
            merkleRoot: `0x${"11".repeat(32)}`,
            withdrawDelay: "604800",
          },
          snapshot: {
            cumulativeClaimed: "0",
            nextClaimableWithdrawal: { amount: "0", claimableAt: "0" },
            pendingWithdrawals: [],
            safeBalance: "1000000000000000000",
            stakingAllowance: "0",
            totalStaked: "2000000000000000000",
            withdrawDelay: "604800",
          },
          validatorsWithPositions: [
            {
              address: "0xCc00DE0eA14c08669b26DcBFE365dBD9890B04D9",
              commission: 5,
              label: "Core Contributors",
              participationRate: 98,
              status: "active",
              totalStake: "3000000000000000000",
              userStake: "0",
            },
          ],
        }),
      })
    })
    await restorePage.route("**/assets/validator-info.json", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            address: "0xCc00DE0eA14c08669b26DcBFE365dBD9890B04D9",
            commission: 0.05,
            is_active: true,
            label: "Core Contributors",
            participation_rate_14d: 0.98,
          },
        ]),
      }),
    )
    await restorePage.route("**/proofs/**", (route) => route.fulfill({ status: 404, body: "" }))
    await restorePage.goto(baseUrl, { waitUntil: "networkidle" })
    if (restoreErrors.length > 0) {
      throw new Error(`Unexpected restore page errors: ${restoreErrors.join("\n")}`)
    }
    try {
      await restorePage.getByRole("button", { name: "Wallet" }).waitFor()
      await restorePage.waitForFunction(() => document.body.innerText.includes("SAFE Balance\n1.00"))
    } catch (error) {
      const bodyText = await restorePage
        .locator("body")
        .innerText({ timeout: 1000 })
        .catch(() => "")
      throw new Error(
        `Wallet restore UI did not settle.\n${bodyText}\n${error instanceof Error ? error.message : error}`,
      )
    }
    const restoreText = await restorePage.locator("body").innerText()
    if (!restoreText.includes(testAccount.address.slice(0, 6))) {
      throw new Error(`Expected restored account in UI.\n${restoreText}`)
    }
    if (accountLiveCalls === 0) throw new Error("Expected restored wallet live reads to use the account live API")
  } finally {
    await restoreContext.close()
  }

  const connectContext = await browser.newContext({ viewport: { width: 1280, height: 840 } })
  try {
    const connectPage = await connectContext.newPage()
    const connectErrors = []
    connectPage.on("console", (message) => {
      const text = message.text()
      if (message.type() === "error" && !text.includes("404 (Not Found)")) connectErrors.push(text)
    })
    connectPage.on("pageerror", (error) => {
      connectErrors.push(error.message)
    })
    await mockSafePrice(connectPage)
    await connectPage.addInitScript(
      ({ address }) => {
        const listeners = new Map()
        window.__walletCalls = { personalSign: 0, requestAccounts: 0 }
        window.ethereum = {
          request: async ({ method, params }) => {
            if (method === "eth_chainId") return "0x1"
            if (method === "eth_accounts") return []
            if (method === "eth_requestAccounts") {
              window.__walletCalls.requestAccounts += 1
              return [address]
            }
            if (method === "personal_sign") {
              window.__walletCalls.personalSign += 1
              throw new Error("Connect wallet must not request a signature")
            }
            if (method === "wallet_switchEthereumChain") return null
            throw new Error(`Unexpected wallet method ${method} ${JSON.stringify(params)}`)
          },
          on: (event, handler) => {
            const current = listeners.get(event) ?? []
            current.push(handler)
            listeners.set(event, current)
          },
          removeListener: (event, handler) => {
            listeners.set(
              event,
              (listeners.get(event) ?? []).filter((item) => item !== handler),
            )
          },
        }
        window.localStorage.setItem("safecafe:wallet-disconnected", "true")
        window.localStorage.removeItem("safecafe:rpc-session")
      },
      { address: testAccount.address },
    )
    let connectAccountLiveCalls = 0
    let connectAuthCalls = 0
    await connectPage.route("**/api/auth/**", (route) => {
      connectAuthCalls += 1
      route.fulfill({ status: 500, body: "Connect wallet must not call auth APIs" })
    })
    const connectLiveUrls = []
    await connectPage.route("**/api/account/live?**", async (route) => {
      connectAccountLiveCalls += 1
      connectLiveUrls.push(route.request().url())
      const isManualRefresh = new URL(route.request().url()).searchParams.get("refresh") === "true"
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          health: {
            blockNumber: "456",
            merkleRoot: `0x${"22".repeat(32)}`,
            withdrawDelay: "604800",
          },
          snapshot: {
            cumulativeClaimed: "0",
            nextClaimableWithdrawal: { amount: "0", claimableAt: "0" },
            pendingWithdrawals: [],
            safeBalance: isManualRefresh ? "7000000000000000000" : "5000000000000000000",
            stakingAllowance: "0",
            totalStaked: "0",
            withdrawDelay: "604800",
          },
          validatorsWithPositions: [
            {
              address: "0xCc00DE0eA14c08669b26DcBFE365dBD9890B04D9",
              commission: 5,
              label: "Core Contributors",
              participationRate: 98,
              status: "active",
              totalStake: "3000000000000000000",
              userStake: "0",
            },
          ],
        }),
      })
    })
    await connectPage.route("**/assets/validator-info.json", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            address: "0xCc00DE0eA14c08669b26DcBFE365dBD9890B04D9",
            commission: 0.05,
            is_active: true,
            label: "Core Contributors",
            participation_rate_14d: 0.98,
          },
        ]),
      }),
    )
    await connectPage.route("**/proofs/**", (route) => route.fulfill({ status: 404, body: "" }))
    await connectPage.goto(baseUrl, { waitUntil: "networkidle" })
    await connectPage.getByRole("button", { name: "Connect wallet" }).first().click()
    await connectPage.waitForFunction(() => document.body.innerText.includes("SAFE Balance\n5.00"))
    await connectPage.getByRole("button", { name: "Refresh SAFE balance and stake" }).click()
    await connectPage.waitForFunction(() => document.body.innerText.includes("SAFE Balance\n7.00"))
    const walletCalls = await connectPage.evaluate(() => window.__walletCalls)
    if (walletCalls.requestAccounts !== 1) {
      throw new Error(`Expected one wallet account request, got ${walletCalls.requestAccounts}`)
    }
    if (walletCalls.personalSign !== 0) {
      throw new Error(`Expected connect wallet not to sign, got ${walletCalls.personalSign} personal_sign calls`)
    }
    if (connectAuthCalls !== 0)
      throw new Error(`Expected connect wallet not to call auth APIs, got ${connectAuthCalls}`)
    if (connectAccountLiveCalls < 2) {
      throw new Error(
        `Expected connect wallet and manual refresh to load account live data, got ${connectAccountLiveCalls}`,
      )
    }
    if (!connectLiveUrls.some((url) => new URL(url).searchParams.get("refresh") === "true")) {
      throw new Error(
        `Expected manual refresh to call account live API with refresh=true, got ${connectLiveUrls.join("\n")}`,
      )
    }
    if (connectErrors.length > 0) {
      throw new Error(`Unexpected connect wallet page errors: ${connectErrors.join("\n")}`)
    }
  } finally {
    await connectContext.close()
  }

  const actionContext = await browser.newContext({ viewport: { width: 1280, height: 840 } })
  try {
    const actionPage = await actionContext.newPage()
    const actionErrors = []
    actionPage.on("console", (message) => {
      const text = message.text()
      if (message.type() === "error" && !text.includes("404 (Not Found)")) actionErrors.push(text)
    })
    actionPage.on("pageerror", (error) => {
      actionErrors.push(error.message)
    })
    await mockSafePrice(actionPage)
    await actionPage.addInitScript(
      ({ address }) => {
        const listeners = new Map()
        window.__walletCalls = { personalSign: 0, requestAccounts: 0, sendTransaction: 0 }
        window.ethereum = {
          request: async ({ method, params }) => {
            if (method === "eth_chainId") return "0x1"
            if (method === "eth_accounts") return []
            if (method === "eth_requestAccounts") {
              window.__walletCalls.requestAccounts += 1
              return [address]
            }
            if (method === "personal_sign") {
              window.__walletCalls.personalSign += 1
              return `0x${"11".repeat(65)}`
            }
            if (method === "eth_sendTransaction") {
              window.__walletCalls.sendTransaction += 1
              if (!Array.isArray(params) || !params[0]?.to || !params[0]?.data) {
                throw new Error(`Invalid transaction payload ${JSON.stringify(params)}`)
              }
              return `0x${"44".repeat(32)}`
            }
            if (method === "wallet_switchEthereumChain") return null
            throw new Error(`Unexpected wallet method ${method} ${JSON.stringify(params)}`)
          },
          on: (event, handler) => {
            const current = listeners.get(event) ?? []
            current.push(handler)
            listeners.set(event, current)
          },
          removeListener: (event, handler) => {
            listeners.set(
              event,
              (listeners.get(event) ?? []).filter((item) => item !== handler),
            )
          },
        }
        window.localStorage.setItem("safecafe:wallet-disconnected", "true")
        window.localStorage.removeItem("safecafe:rpc-session")
      },
      { address: testAccount.address },
    )
    await actionPage.route("**/api/auth/challenge", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          challenge: "mock-challenge",
          expiresAt: Math.floor(Date.now() / 1000) + 300,
          message: "Mock SafeCafe sign-in",
          signer: testAccount.address,
          subject: testAccount.address,
          subjectKind: "self",
          strategy: "signed-wallet-access",
        }),
      })
    })
    await actionPage.route("**/api/auth/verify", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          address: testAccount.address,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          signer: testAccount.address,
          subject: testAccount.address,
          subjectKind: "self",
          strategy: "signed-wallet-access",
          token: "mock-rpc-session",
        }),
      })
    })
    await actionPage.route("**/api/account/live?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          health: {
            blockNumber: "789",
            merkleRoot: `0x${"11".repeat(32)}`,
            withdrawDelay: "604800",
          },
          snapshot: {
            cumulativeClaimed: "0",
            nextClaimableWithdrawal: { amount: "210000000000000000000", claimableAt: "0" },
            pendingWithdrawals: [{ amount: "320000000000000000000", claimableAt: "9999999999" }],
            safeBalance: "1250000000000000000000",
            stakingAllowance: "0",
            totalStaked: "8400000000000000000000",
            withdrawDelay: "604800",
          },
          validatorsWithPositions: [
            {
              address: "0xCc00DE0eA14c08669b26DcBFE365dBD9890B04D9",
              commission: 5,
              label: "Core Contributors",
              participationRate: 98,
              status: "active",
              totalStake: "1200000000000000000000000",
              userStake: "2000000000000000000000",
            },
          ],
        }),
      })
    })
    await actionPage.route("**/proofs/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          cumulativeAmount: "95000000000000000000",
          merkleRoot: `0x${"11".repeat(32)}`,
          proof: [],
        }),
      }),
    )
    const fulfillMockRpc = async (route) => {
      const request = route.request()
      const body = request.postDataJSON()
      const method = Array.isArray(body) ? body[0]?.method : body?.method
      if (method === "eth_call") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: "0x" }),
        })
        return
      }
      if (method === "eth_getTransactionReceipt") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? 1,
            result: {
              blockHash: `0x${"55".repeat(32)}`,
              blockNumber: "0x1",
              contractAddress: null,
              cumulativeGasUsed: "0x5208",
              effectiveGasPrice: "0x1",
              from: testAccount.address,
              gasUsed: "0x5208",
              logs: [],
              logsBloom: `0x${"00".repeat(256)}`,
              status: "0x1",
              to: "0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2",
              transactionHash: `0x${"44".repeat(32)}`,
              transactionIndex: "0x0",
              type: "0x2",
            },
          }),
        })
        return
      }
      throw new Error(`Unexpected mock RPC method ${method}`)
    }
    await actionPage.route("**/api/rpc/ethereum", fulfillMockRpc)
    await actionPage.route("https://ethereum-rpc.publicnode.com/**", fulfillMockRpc)
    await actionPage.route("https://eth.llamarpc.com/**", fulfillMockRpc)
    await actionPage.goto(`${baseUrl}/rewards`, { waitUntil: "networkidle" })
    await actionPage.getByRole("button", { name: "Connect wallet" }).first().click()
    await actionPage.waitForFunction(() => document.body.innerText.includes("Claimable Rewards\n95.00"))
    const manualContent = await actionPage.locator("main").innerText()
    for (const forbidden of ["transaction plan", "Export Safe payload", "Confirm and sign"]) {
      if (manualContent.includes(forbidden)) {
        throw new Error(`Expected the manual rewards flow not to expose "${forbidden}"`)
      }
    }
    await actionPage.getByRole("button", { name: "Claim Rewards" }).click()
    await actionPage.waitForFunction(() => window.__walletCalls?.sendTransaction === 1)
    const actionWalletCalls = await actionPage.evaluate(() => window.__walletCalls)
    if (actionWalletCalls.personalSign < 1) {
      throw new Error(
        `Expected manual rewards action to authenticate the RPC gateway, got ${actionWalletCalls.personalSign}`,
      )
    }
    await actionPage.getByText("Submitted").waitFor()
    if (actionErrors.length > 0) {
      throw new Error(`Unexpected manual action page errors: ${actionErrors.join("\n")}`)
    }
  } finally {
    await actionContext.close()
  }

  await page.getByRole("button", { name: "Connect wallet" }).first().click()
  const warningToast = page.getByText("No injected wallet found.").first()
  await warningToast.waitFor({ state: "visible" })
  const toastBox = await warningToast.boundingBox()
  if (!toastBox || toastBox.width > 430) {
    throw new Error(`Expected compact notification region, got ${JSON.stringify(toastBox)}`)
  }
  await page.getByRole("button", { name: "Close notification" }).first().click()
  await warningToast.waitFor({ state: "detached" })
  await page.getByRole("button", { name: "Connect wallet" }).first().click()
  const warningToastAgain = page.getByText("No injected wallet found.").first()
  await warningToastAgain.waitFor({ state: "visible" })
  await page.getByRole("button", { name: "Close notification" }).first().click()
  await warningToastAgain.waitFor({ state: "detached" })

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
  if (!(await dialog.getByLabel("Message the staking agent").isDisabled())) {
    throw new Error("Expected disconnected agent composer to be disabled")
  }
  for (let index = 0; index < 8; index += 1) await page.keyboard.press("Tab")
  const focusInsideDialog = await dialog.evaluate((element) => element.contains(document.activeElement))
  if (!focusInsideDialog) throw new Error("Expected Tab focus to stay inside the modal agent dialog")
  await dialog.getByText("Tell me what you want to do with your SAFE staking position.").waitFor()
  await dialog.getByText("Connect a wallet to start chatting").waitFor()
  await dialog.getByText("After connecting, it can plan from live SAFE balance").waitFor()
  if ((await dialog.getByRole("button", { name: "Claim rewards" }).count()) > 0) {
    throw new Error("Expected disconnected agent prompt chips to stay hidden")
  }
  await dialog.getByRole("button", { name: "Agent sessions" }).waitFor()
  await dialog.getByRole("button", { name: "Agent sessions" }).click()
  await dialog.getByRole("menuitem", { name: "New session" }).waitFor()
  await dialog.getByRole("menuitem", { name: "Clear session" }).waitFor()
  await dialog.getByRole("menuitem", { name: "Clear all sessions" }).waitFor()
  await page.keyboard.press("Escape")
  await dialog.getByRole("menuitem", { name: "New session" }).waitFor({ state: "hidden" })
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "visible" })
  await dialog.getByRole("button", { name: "Close agent" }).click()
  await dialog.waitFor({ state: "hidden" })
  await page.getByRole("button", { name: "Switch language" }).click()
  await page.getByRole("menuitemradio", { name: /Deutsch/ }).waitFor()
  await page.getByRole("menuitemradio", { name: /한국어/ }).waitFor()
  await page.getByRole("menuitemradio", { name: /中文/ }).click()
  const zhLauncherFromHeader = page.getByRole("button", { name: "打开质押 Agent" })
  await zhLauncherFromHeader.waitFor()
  await zhLauncherFromHeader.click()
  const localizedDialog = page.getByRole("dialog", { name: "质押 Agent" })
  await localizedDialog.waitFor()
  await localizedDialog.getByText("告诉我你想如何处理 SAFE 质押仓位。").waitFor()
  await localizedDialog.getByText("连接钱包后开始对话").waitFor()
  await page.keyboard.press("Escape")
  await localizedDialog.waitFor({ state: "visible" })
  await localizedDialog.getByRole("button", { name: "关闭 Agent" }).click()
  await localizedDialog.waitFor({ state: "hidden" })
  await page.getByRole("button", { name: "切换语言" }).click()
  await page.getByRole("menuitemradio", { name: /English/ }).click()
  await page.getByRole("button", { name: "Open Staking Agent" }).click()
  await dialog.waitFor()
  const messageLogRole = await dialog.locator(".agent-message-log").getAttribute("role")
  if (messageLogRole !== "log") throw new Error("Expected agent messages to render in an accessible log")
  if ((await dialog.getByText("Wallet context changed. I cleared the pending Agent plan.").count()) > 0) {
    throw new Error("Expected wallet context changes to stay silent until the user asks the Agent something")
  }
  await page.evaluate(() => {
    window.localStorage.setItem(
      "safecafe:agent:sessions",
      JSON.stringify([
        {
          draft: null,
          draftKey: "",
          executablePlan: null,
          id: "persisted-agent-session",
          messages: [
            {
              content:
                "Line one of a deliberately long persisted Agent answer. " +
                "Line two keeps going with enough detail to exceed the compact message threshold. " +
                "Line three keeps going with more persisted context for the Agent conversation. " +
                "Line four keeps going so the user can expand it. " +
                "Line four and a half adds enough extra persisted text for the compact message threshold. " +
                "Line five should be collapsed until expanded.",
              id: "persisted-message",
              role: "assistant",
            },
          ],
          pendingIntentText: "",
          title: "Persisted Agent session",
          warningsAccepted: false,
        },
      ]),
    )
    window.localStorage.setItem("safecafe:agent:active-session", "persisted-agent-session")
  })
  await page.reload({ waitUntil: "networkidle" })
  await page.getByRole("button", { name: "Open Staking Agent" }).click()
  const restoredDialog = page.getByRole("dialog", { name: "Staking Agent" })
  await restoredDialog.waitFor({ state: "visible" })
  await restoredDialog.getByText("Line one of a deliberately long persisted Agent answer.").waitFor()
  await restoredDialog.getByText("Line five should be collapsed until expanded.").waitFor()
  const contentToggle = restoredDialog.locator(".agent-message-toggle").first()
  await contentToggle.waitFor()
  if ((await contentToggle.getAttribute("aria-expanded")) !== "true") {
    throw new Error("Expected long Agent content to be expanded by default")
  }
  await contentToggle.click()
  if ((await contentToggle.getAttribute("aria-expanded")) !== "false") {
    throw new Error("Expected long Agent content to collapse after clicking the content toggle")
  }

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

  if (!(await dialog.getByLabel("Message the staking agent").isDisabled())) {
    throw new Error("Expected disconnected agent composer to stay disabled")
  }
  if ((await dialog.getByRole("button", { name: "Send" }).count()) > 0) {
    throw new Error("Expected disconnected agent send button to be replaced by wallet connect")
  }
  if (agentApiCalls !== 0) throw new Error("Expected disconnected wallet path not to call /api/agent")
  await dialog.getByRole("button", { name: "Agent sessions" }).click()
  await dialog.getByRole("menuitem", { name: "New session" }).click()
  await dialog.getByText("Connect a wallet to start chatting").waitFor()
  await dialog.getByRole("button", { name: "Agent sessions" }).click()
  await dialog.getByRole("menuitem", { name: "Clear session" }).click()
  if ((await dialog.getByRole("button", { name: "Claim rewards" }).count()) > 0) {
    throw new Error("Expected disconnected agent prompt chips to stay hidden after clearing a session")
  }

  await dialog.getByRole("button", { name: "Close agent" }).click()
  await dialog.waitFor({ state: "hidden" })
  if (!(await launcher.evaluate((element) => element === document.activeElement))) {
    throw new Error("Expected focus to return to the agent launcher after closing the dialog")
  }
  await launcher.click()
  await dialog.waitFor({ state: "visible" })

  await page.setViewportSize({ width: 390, height: 760 })
  await page.getByRole("dialog", { name: "Staking Agent" }).waitFor({ state: "visible" })
  await dialog.getByText("Connect a wallet to start chatting").waitFor()
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
  await dialog.locator(".agent-session-popover").waitFor({ state: "hidden" })
  await page.setViewportSize({ width: 390, height: 760 })
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "visible" })
  await dialog.getByRole("button", { name: "Close agent" }).click()
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
  await mockSafePrice(zhPage)
  await zhPage.addInitScript(() => {
    window.localStorage.setItem("safecafe:locale", "zh")
  })
  await zhPage.goto(baseUrl, { waitUntil: "networkidle" })
  const zhLauncher = zhPage.getByRole("button", { name: "打开质押 Agent" })
  await zhLauncher.waitFor({ state: "visible", timeout: 10_000 })
  await zhLauncher.click()
  const zhDialog = zhPage.getByRole("dialog", { name: "质押 Agent" })
  await zhDialog.waitFor({ state: "visible" })
  await zhDialog.getByText("连接钱包后开始对话").waitFor()
  if (!(await zhDialog.getByLabel("给质押 Agent 发消息").isDisabled())) {
    throw new Error("Expected disconnected zh agent composer to be disabled")
  }
  if ((await zhDialog.getByRole("button", { name: "发送" }).count()) > 0) {
    throw new Error("Expected disconnected zh agent send button to be replaced by wallet connect")
  }
  if (zhConsoleErrors.length > 0) {
    throw new Error(`Unexpected zh browser console errors: ${zhConsoleErrors.join("\n")}`)
  }
} finally {
  await browser?.close()
  preview?.kill("SIGTERM")
}

console.log("Browser e2e tests passed")
if (process.env.DEBUG_E2E_TEST) console.log(logs)
