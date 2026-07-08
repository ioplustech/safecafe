import assert from "node:assert/strict"
import { encodeFunctionData, getAddress, parseAbi } from "viem"
import { createMockChain, mockContracts, mockValidators } from "./mockChain.mjs"

const eth = 10n ** 18n
const account = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"])
const stakingAbi = parseAbi([
  "function stake(address validator, uint256 amount)",
  "function initiateWithdrawal(address validator, uint256 amount)",
])
const safeAccountAbi = parseAbi([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
])

const chain = createMockChain({ account, safeBalance: 2n * eth, stakingAllowance: 0n, coreStake: 1n * eth })

assert.throws(
  () =>
    chain.applyTransaction(
      account,
      {
        to: mockContracts.staking,
        data: encodeFunctionData({
          abi: stakingAbi,
          functionName: "stake",
          args: [mockValidators[0].address, 3n * eth],
        }),
        value: "0x0",
      },
      `0x${"01".repeat(32)}`,
    ),
  /insufficient allowance/,
)

chain.applyTransaction(
  account,
  {
    to: mockContracts.safeToken,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [mockContracts.staking, 1n * eth],
    }),
    value: "0x0",
  },
  `0x${"02".repeat(32)}`,
)
chain.applyTransaction(
  account,
  {
    to: mockContracts.staking,
    data: encodeFunctionData({
      abi: stakingAbi,
      functionName: "stake",
      args: [mockValidators[0].address, 1n * eth],
    }),
    value: "0x0",
  },
  `0x${"03".repeat(32)}`,
)

assert.equal(chain.state.safeBalance, 1n * eth)
assert.equal(chain.state.validators[0].userStake, 2n * eth)

assert.throws(
  () =>
    chain.applyTransaction(
      account,
      {
        to: mockContracts.staking,
        data: encodeFunctionData({
          abi: stakingAbi,
          functionName: "initiateWithdrawal",
          args: [mockValidators[0].address, 3n * eth],
        }),
        value: "0x0",
      },
      `0x${"04".repeat(32)}`,
    ),
  /Stake too low/,
)

const safeAddress = "0x1111111111111111111111111111111111111111"
const safeChain = createMockChain({
  account,
  coreStake: 0n,
  safeBalance: 2n * eth,
  safeOwners: [account],
  safes: [safeAddress],
  safeThreshold: 1n,
  stakingAllowance: 0n,
})

safeChain.applyTransaction(
  account,
  {
    to: safeAddress,
    data: encodeFunctionData({
      abi: safeAccountAbi,
      functionName: "execTransaction",
      args: [
        mockContracts.safeToken,
        0n,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [mockContracts.staking, 1n * eth],
        }),
        0,
        0n,
        0n,
        0n,
        getAddress("0x0000000000000000000000000000000000000000"),
        getAddress("0x0000000000000000000000000000000000000000"),
        "0x",
      ],
    }),
    value: "0x0",
  },
  `0x${"05".repeat(32)}`,
)
safeChain.applyTransaction(
  account,
  {
    to: safeAddress,
    data: encodeFunctionData({
      abi: safeAccountAbi,
      functionName: "execTransaction",
      args: [
        mockContracts.staking,
        0n,
        encodeFunctionData({
          abi: stakingAbi,
          functionName: "stake",
          args: [mockValidators[0].address, 1n * eth],
        }),
        0,
        0n,
        0n,
        0n,
        getAddress("0x0000000000000000000000000000000000000000"),
        getAddress("0x0000000000000000000000000000000000000000"),
        "0x",
      ],
    }),
    value: "0x0",
  },
  `0x${"06".repeat(32)}`,
)

assert.equal(safeChain.state.safeBalance, 1n * eth)
assert.equal(safeChain.state.validators[0].userStake, 1n * eth)

console.log("Mock chain reducer tests passed")
