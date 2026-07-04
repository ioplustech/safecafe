import type { Command } from "commander"
import type { Hex } from "viem"
import {
  CONTRACTS,
  fetchRewardProof,
  fetchValidators,
  formatDelay,
  formatSafe,
  mockAccount,
  mockSummary,
  mockValidators,
  planClaimRewards,
  planClaimWithdrawal,
  planStake,
  planUnstake,
  readAccountSnapshot,
  readHealth,
} from "../src/protocol"
import { output } from "../src/shared/cli"
import { parseAddress, totalAmount } from "../src/shared/utils"
import {
  assertRewardsClaimable,
  assertStakePossible,
  assertUnstakePossible,
  assertWithdrawalClaimable,
  createClient,
  type GlobalOptions,
  handlePlan,
  resolvePlanningAccount,
  resolveValidator,
  type WriteOptions,
} from "./context"

export function registerCommands(program: Command) {
  program
    .command("status")
    .description("Show protocol health and, optionally, one account summary")
    .option("--account <address>", "EOA or Safe address")
    .action(async (options: { account?: string }) => {
      const globals = program.opts<GlobalOptions>()
      if (globals.mock) {
        const payload = {
          mode: "mock",
          account: options.account ?? mockAccount,
          health: { rpc: "healthy", blockNumber: 19234221n, merkleRoot: "matched" },
          summary: mockSummary,
        }
        output(globals, payload, () => {
          console.log("Safecafe is ready")
          console.log(`Account:               ${payload.account}`)
          console.log(`SAFE balance:          ${formatSafe(mockSummary.safeBalance)}`)
          console.log(`Total staked:          ${formatSafe(mockSummary.totalStaked)}`)
          console.log(`Claimable rewards:     ${formatSafe(mockSummary.claimableRewards)}`)
          console.log(`Claimable withdrawals: ${formatSafe(mockSummary.claimableWithdrawals)}`)
        })
        return
      }

      const client = createClient(globals)
      const health = await readHealth(client)
      const account = options.account ? parseAddress(options.account, "account") : undefined
      const snapshot = account ? await readAccountSnapshot(client, account) : null
      output(globals, { health, account, snapshot }, () => {
        console.log("Safecafe protocol check")
        console.log(`RPC:              healthy`)
        console.log(`Block:            ${health.blockNumber}`)
        console.log(`Withdrawal delay: ${formatDelay(health.withdrawDelay)}`)
        console.log(`Merkle root:      ${health.merkleRoot}`)
        if (account && snapshot) {
          console.log("")
          console.log(`Account:          ${account}`)
          console.log(`SAFE balance:     ${formatSafe(snapshot.safeBalance)}`)
          console.log(`Total staked:     ${formatSafe(snapshot.totalStaked)}`)
          console.log(`Pending queue:    ${formatSafe(totalAmount(snapshot.pendingWithdrawals))}`)
        }
      })
    })

  program
    .command("validators")
    .description("List Safenet staking validators")
    .option("--active", "Only show active validators")
    .option("--sort <field>", "Sort by name, participation, commission, or stake", "participation")
    .action(async (options: { active?: boolean; sort: string }) => {
      const globals = program.opts<GlobalOptions>()
      const validators = globals.mock ? mockValidators : await fetchValidators()
      const filtered = validators
        .filter((validator) => !options.active || validator.status === "active")
        .sort((a, b) => {
          if (options.sort === "name") return a.label.localeCompare(b.label)
          if (options.sort === "commission") return a.commission - b.commission
          if (options.sort === "stake") return Number(b.totalStake - a.totalStake)
          return b.participationRate - a.participationRate
        })

      output(globals, filtered, () => {
        console.log("Safenet validators")
        for (const validator of filtered) {
          console.log(
            `${validator.label.padEnd(22)} ${validator.status.padEnd(8)} participation ${validator.participationRate
              .toFixed(1)
              .padStart(
                6,
              )}%  fee ${validator.commission.toFixed(1).padStart(5)}%  stake ${formatSafe(validator.totalStake)}`,
          )
        }
      })
    })

  program
    .command("stake")
    .description("Plan, export, or send a stake transaction")
    .requiredOption("--validator <address-or-name>", "Validator address or known label")
    .requiredOption("--amount <safe>", "SAFE amount")
    .option("--account <address>", "Account used for planning")
    .option("--dry-run", "Only print the transaction plan", true)
    .option("--safe-payload <path>", "Write a Safe Transaction Builder JSON payload")
    .option("--send", "Submit the planned transactions from a local EOA hot wallet")
    .option("--private-key-prompt", "Prompt for the private key with hidden terminal input")
    .option("--private-key-stdin", "Read the private key from stdin")
    .option("--private-key-env <name>", "Read the private key from an environment variable")
    .option("--yes", "Confirm live transaction submission")
    .action(async (options: WriteOptions & { validator: string; amount: string }) => {
      const globals = program.opts<GlobalOptions>()
      const validator = await resolveValidator(options.validator, globals.mock)
      const account = resolvePlanningAccount(options, globals)
      const allowance =
        globals.mock || !account ? 0n : (await readAccountSnapshot(createClient(globals), account)).stakingAllowance
      if (!globals.mock && account) await assertStakePossible(globals, account, validator, options.amount)
      await handlePlan(globals, planStake({ validator, amount: options.amount, account, allowance }), options)
    })

  program
    .command("unstake")
    .description("Plan, export, or send an unstake transaction")
    .requiredOption("--validator <address-or-name>", "Validator address or known label")
    .requiredOption("--amount <safe>", "SAFE amount")
    .option("--account <address>", "Account used for planning")
    .option("--dry-run", "Only print the transaction plan", true)
    .option("--safe-payload <path>", "Write a Safe Transaction Builder JSON payload")
    .option("--send", "Submit the planned transactions from a local EOA hot wallet")
    .option("--private-key-prompt", "Prompt for the private key with hidden terminal input")
    .option("--private-key-stdin", "Read the private key from stdin")
    .option("--private-key-env <name>", "Read the private key from an environment variable")
    .option("--yes", "Confirm live transaction submission")
    .action(async (options: WriteOptions & { validator: string; amount: string }) => {
      const globals = program.opts<GlobalOptions>()
      const validator = await resolveValidator(options.validator, globals.mock)
      const account = resolvePlanningAccount(options, globals)
      if (!globals.mock && account) await assertUnstakePossible(globals, account, validator, options.amount)
      await handlePlan(globals, planUnstake({ validator, amount: options.amount, account }), options)
    })

  program
    .command("withdrawals")
    .description("Show withdrawal queue for an account")
    .requiredOption("--account <address>", "EOA or Safe address")
    .action(async (options: { account: string }) => {
      const globals = program.opts<GlobalOptions>()
      if (globals.mock) {
        output(globals, mockSummary, () => {
          console.log(`Pending withdrawals:    ${formatSafe(mockSummary.pendingWithdrawals)} SAFE`)
          console.log(`Ready to claim:         ${formatSafe(mockSummary.claimableWithdrawals)} SAFE`)
          console.log(`Protocol delay:         ${formatDelay(mockSummary.withdrawDelay)}`)
        })
        return
      }

      const account = parseAddress(options.account, "account")
      const snapshot = await readAccountSnapshot(createClient(globals), account)
      output(globals, snapshot.pendingWithdrawals, () => {
        if (!snapshot.pendingWithdrawals.length) {
          console.log("No withdrawals are pending.")
          return
        }
        snapshot.pendingWithdrawals.forEach((withdrawal, index) => {
          const date = new Date(Number(withdrawal.claimableAt) * 1000).toISOString()
          console.log(`#${index + 1} ${formatSafe(withdrawal.amount)} SAFE ready at ${date}`)
        })
      })
    })

  program
    .command("claim-withdrawal")
    .description("Plan, export, or send a withdrawal claim")
    .option("--account <address>", "Account used for planning")
    .option("--dry-run", "Only print the transaction plan", true)
    .option("--safe-payload <path>", "Write a Safe Transaction Builder JSON payload")
    .option("--send", "Submit the planned transactions from a local EOA hot wallet")
    .option("--private-key-prompt", "Prompt for the private key with hidden terminal input")
    .option("--private-key-stdin", "Read the private key from stdin")
    .option("--private-key-env <name>", "Read the private key from an environment variable")
    .option("--yes", "Confirm live transaction submission")
    .action(async (options: WriteOptions) => {
      const globals = program.opts<GlobalOptions>()
      const account = resolvePlanningAccount(options, globals)
      if (!globals.mock && account) await assertWithdrawalClaimable(globals, account)
      await handlePlan(globals, planClaimWithdrawal(account), options)
    })

  program
    .command("rewards")
    .description("Show reward proof and claimable reward status")
    .requiredOption("--account <address>", "EOA or Safe address")
    .action(async (options: { account: string }) => {
      const globals = program.opts<GlobalOptions>()
      if (globals.mock) {
        output(globals, { account: options.account, claimable: mockSummary.claimableRewards }, () => {
          console.log(`Account:          ${options.account}`)
          console.log(`Claimable rewards: ${formatSafe(mockSummary.claimableRewards)} SAFE`)
          console.log("Proof status:     sample data")
        })
        return
      }

      const account = parseAddress(options.account, "account")
      const [proof, snapshot, health] = await Promise.all([
        fetchRewardProof(account),
        readAccountSnapshot(createClient(globals), account),
        readHealth(createClient(globals)),
      ])
      const cumulativeAmount = proof ? BigInt(proof.cumulativeAmount) : 0n
      const claimable =
        cumulativeAmount > snapshot.cumulativeClaimed ? cumulativeAmount - snapshot.cumulativeClaimed : 0n
      const rootMatched = proof ? proof.merkleRoot.toLowerCase() === health.merkleRoot.toLowerCase() : false
      output(globals, { account, proofFound: !!proof, rootMatched, claimable, proof }, () => {
        console.log(`Account:      ${account}`)
        console.log(`Proof found:  ${proof ? "yes" : "no"}`)
        console.log(`Claimable:    ${formatSafe(claimable)} SAFE`)
        if (proof) console.log(`Root matched: ${rootMatched ? "yes" : "no"}`)
      })
    })

  program
    .command("claim-rewards")
    .description("Plan, export, or send a reward claim")
    .requiredOption("--account <address>", "Reward account")
    .option("--dry-run", "Only print the transaction plan", true)
    .option("--safe-payload <path>", "Write a Safe Transaction Builder JSON payload")
    .option("--send", "Submit the planned transactions from a local EOA hot wallet")
    .option("--private-key-prompt", "Prompt for the private key with hidden terminal input")
    .option("--private-key-stdin", "Read the private key from stdin")
    .option("--private-key-env <name>", "Read the private key from an environment variable")
    .option("--yes", "Confirm live transaction submission")
    .action(async (options: WriteOptions & { account: string }) => {
      const globals = program.opts<GlobalOptions>()
      const account = parseAddress(options.account, "account")
      if (globals.mock) {
        await handlePlan(
          globals,
          planClaimRewards({
            account,
            cumulativeAmount: mockSummary.claimableRewards,
            merkleRoot: `0x${"0".repeat(64)}` as Hex,
            proof: [],
          }),
          options,
        )
        return
      }
      await assertRewardsClaimable(globals, account)
      const proof = await fetchRewardProof(account)
      if (!proof?.proof) throw new Error("No claimable proof found for account")
      await handlePlan(
        globals,
        planClaimRewards({
          account,
          cumulativeAmount: BigInt(proof.cumulativeAmount),
          merkleRoot: proof.merkleRoot,
          proof: proof.proof,
        }),
        options,
      )
    })

  program
    .command("contracts")
    .description("Print contract addresses")
    .action(() => {
      const globals = program.opts<GlobalOptions>()
      output(globals, CONTRACTS, () => {
        console.log(`SAFE token:        ${CONTRACTS.safeToken}`)
        console.log(`Staking contract:  ${CONTRACTS.staking}`)
        console.log(`Rewards contract:  ${CONTRACTS.merkleDrop}`)
        console.log(`Multicall3:        ${CONTRACTS.multicall3}`)
      })
    })

  program
    .command("guide")
    .description("Print the Safecafe guided workflow")
    .action(() => {
      console.log("Safecafe guided flow")
      console.log("")
      console.log("1. Check the protocol and your account")
      console.log("   safecafe status --account 0xYourSafe")
      console.log("")
      console.log("2. Pick a validator")
      console.log("   safecafe validators --active --sort participation")
      console.log("")
      console.log("3. Prepare a stake")
      console.log('   safecafe stake --account 0xYourSafe --validator "Core Contributors" --amount 100 --dry-run')
      console.log("")
      console.log("4. Export a Safe payload")
      console.log(
        '   safecafe stake --account 0xYourSafe --validator "Core Contributors" --amount 100 --safe-payload ./safecafe-safe.json',
      )
      console.log("")
      console.log("5. Collect rewards when proof is available")
      console.log("   safecafe rewards --account 0xYourSafe")
    })
}
