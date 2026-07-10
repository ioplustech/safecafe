import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateKeyToAccount } from "viem/accounts"
import { planStake } from "../src/protocol/txPlan.ts"
import {
  readSigningKeyring,
  readSigningPrivateKey,
  selectEoaSigningKey,
  selectSafeSigningKey,
  sendSafePlanTransactions,
} from "../src/shared/cli.ts"

const safeAddress = "0x1111111111111111111111111111111111111111"
const pk1 = `0x${"11".repeat(32)}`
const pk2 = `0x${"22".repeat(32)}`
const owner1 = privateKeyToAccount(pk1).address
const owner2 = privateKeyToAccount(pk2).address

const plan = {
  ...planStake({
    account: safeAddress,
    allowance: 0n,
    amount: "10",
    validator: "0xCc00DE0eA14c08669b26DcBFE365dBD9890B04D9",
  }),
  account: safeAddress,
}

const txState = {
  confirmations: new Map(),
  executed: 0,
  transactionHash: "0xabc123",
}

function createProtocolKitFactory() {
  return async ({ signer }) => {
    const ownerAddress = privateKeyToAccount(signer).address
    return {
      async createTransaction({ transactions }) {
        return {
          data: { txs: transactions },
          encodedSignatures() {
            return `${ownerAddress}:sig`
          },
        }
      },
      async executeTransaction(transaction) {
        txState.executed += 1
        return {
          hash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          transactionResponse: {
            async wait() {
              return {
                blockNumber: 123n,
                status: "success",
                transaction,
              }
            },
          },
        }
      },
      async getChainId() {
        return 1n
      },
      async getThreshold() {
        return 2
      },
      async getTransactionHash() {
        return txState.transactionHash
      },
      async isOwner(address) {
        return address === owner1 || address === owner2
      },
      async signTransaction(transaction) {
        return {
          data: transaction.data,
          encodedSignatures() {
            return `${ownerAddress}:sig`
          },
          ownerAddress,
          signatures: new Map([[ownerAddress, `${ownerAddress}:sig`]]),
        }
      },
    }
  }
}

function createApiKitFactory() {
  return {
    async confirmTransaction(safeTxHash, signature) {
      assert.equal(safeTxHash, txState.transactionHash)
      const [owner] = String(signature).split(":")
      txState.confirmations.set(owner, signature)
      return { signature }
    },
    async getTransaction(safeTxHash) {
      assert.equal(safeTxHash, txState.transactionHash)
      if (!txState.confirmations.size) throw new Error("Not found")
      return {
        confirmations: [...txState.confirmations.entries()].map(([owner, signature]) => ({ owner, signature })),
        nonce: "0",
      }
    },
    async getTransactionConfirmations(safeTxHash) {
      assert.equal(safeTxHash, txState.transactionHash)
      return {
        results: [...txState.confirmations.entries()].map(([owner, signature]) => ({ owner, signature })),
      }
    },
    async proposeTransaction({ safeTxHash, senderAddress, senderSignature }) {
      assert.equal(safeTxHash, txState.transactionHash)
      txState.confirmations.set(senderAddress, senderSignature)
    },
  }
}

const factory = createProtocolKitFactory()
const apiKit = createApiKitFactory()

const first = await sendSafePlanTransactions(plan, {
  createSafeApiKit() {
    return apiKit
  },
  createSafeProtocolKit: factory,
  privateKey: pk1,
})

assert.deepEqual(first, {
  confirmations: 1,
  mode: "safe-proposed",
  safeTxHash: txState.transactionHash,
  threshold: 2,
})
assert.equal(txState.executed, 0)

const second = await sendSafePlanTransactions(plan, {
  createSafeApiKit() {
    return apiKit
  },
  createSafeProtocolKit: factory,
  privateKey: pk2,
})

assert.deepEqual(second, {
  mode: "safe-executed",
  safeTxHash: txState.transactionHash,
  threshold: 2,
})
assert.equal(txState.executed, 1)

const tempDir = mkdtempSync(join(tmpdir(), "safecafe-cli-key-"))
const keyFile = join(tempDir, "safe.key")
writeFileSync(keyFile, `${pk1}\n`)

try {
  assert.equal(await readSigningPrivateKey({}, { SAFECAFE_CLI_PRIVATE_KEY: pk2 }), pk2)
  assert.equal(await readSigningPrivateKey({}, { SAFECAFE_CLI_PRIVATE_KEY_FILE: keyFile }), pk1)
  const keyring = await readSigningKeyring(
    {},
    {
      SAFECAFE_CLI_PRIVATE_KEYS: `${pk1},${pk2}`,
      SAFECAFE_CLI_SIGNER_ADDRESS: owner2,
    },
  )
  assert.deepEqual(
    keyring.map((key) => key.address),
    [owner1, owner2],
  )
  assert.equal(selectEoaSigningKey(keyring, owner2).privateKey, pk2)
  assert.equal(selectEoaSigningKey(keyring, owner2, owner2).privateKey, pk2)

  const ownerKey = await selectSafeSigningKey(keyring, {
    createSafeProtocolKit: factory,
    preferredSigner: owner1,
    safeAddress,
  })
  assert.equal(ownerKey.privateKey, pk1)

  await assert.rejects(
    () =>
      selectSafeSigningKey(keyring, {
        createSafeProtocolKit: factory,
        safeAddress,
      }),
    /Multiple configured signers can operate Safe/,
  )

  await assert.rejects(
    () =>
      selectSafeSigningKey(keyring, {
        createSafeProtocolKit: factory,
        preferredSigner: "0x3333333333333333333333333333333333333333",
        safeAddress,
      }),
    /is not present in the configured keyring/,
  )
} finally {
  rmSync(tempDir, { force: true, recursive: true })
}

console.log("CLI Safe flow tests passed")
