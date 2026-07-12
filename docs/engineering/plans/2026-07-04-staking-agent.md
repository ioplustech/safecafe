# Staking Agent Implementation Plan

> This is a historical implementation record for the Staking Agent. Prefer current source code, `README.md`, `cli/README.md`, `TESTING.md`, and `RESILIENCE.md` for product behavior. Older mentions of Safe payload export have been superseded by direct wallet confirmation and Safe Transaction Service proposal/confirmation/execution flows.

**Goal:** Build a non-custodial Staking Agent that turns bounded natural-language staking instructions into validated, reviewable multi-step transaction plans that the user must explicitly confirm with their wallet or Safe owner flow.

**Architecture:** The Agent is a deterministic planning layer over existing Safecafe wallet state, live reads, validator metadata, reward proofs, and `TxPlan` builders. Natural language is parsed into a constrained `AgentIntent` JSON shape, compiled into an `AgentPlan` made of existing protocol `TxPlan` primitives, simulated and risk-checked, then shown for explicit user review before any wallet request. No model or parser is allowed to generate calldata directly.

**Tech Stack:** React 19, TypeScript strict mode, Vite, viem, existing Safecafe protocol modules, Biome, pnpm.

## Global Constraints

- Language: UI copy must support English and Chinese through `src/app/i18n.ts`.
- Package manager: use `pnpm` only.
- Formatting/linting: keep Biome passing through `pnpm check`.
- Security: never auto-submit transactions; every on-chain transaction requires explicit wallet confirmation or Safe owner confirmation/execution.
- Non-custodial model: never request, store, transmit, or infer private keys in the web app.
- Agent safety: natural language can choose among supported intents only; calldata must be produced exclusively by existing audited plan builders in `src/protocol/txPlan.ts` or new typed builders reviewed in this plan.
- Network scope: Ethereum mainnet only, using existing `CHAIN_ID` and `ensureMainnet()` behavior.
- Initial implementation: the executable staking plan is local and deterministic. The optional server-side LLM proxy may provide conversational guidance, but it is never authoritative and must never generate calldata or submit transactions.
- Git discipline: do not commit automatically. Commit commands in task checkpoints are suggestions only and require explicit user approval before execution.

---

## 1. Feature Design

### 1.1 Capability Boundary

Supported in v1:

- **Stake**: stake a fixed SAFE amount to one active validator.
- **Unstake**: unstake a fixed SAFE amount from one validator where the connected account has enough stake.
- **Claim withdrawals**: claim the next FIFO withdrawal only when currently claimable.
- **Claim rewards**: claim Merkle rewards only when a proof exists, root matches live contract root, and claimable amount is positive.
- **Restake rewards**: claim rewards, then stake an explicit amount or `all claimed rewards` to one validator. Because wallet txs execute sequentially and on-chain state changes between txs, v1 must represent this as two reviewable phases unless using a Safe batch where the second amount is known and validated against current claimable rewards.
- **Rebalance**: unstake from one validator and optionally stake to another after the withdrawal delay. v1 must not pretend delayed withdrawals are immediately restakable; it should produce a two-phase plan: phase 1 initiate withdrawal, phase 2 reminder/claim/stake after claimable time.
- **Compound existing liquid SAFE**: stake available wallet SAFE or a percent of wallet SAFE to an active validator.
- **Multi-action review plan**: combine independent claim operations plus stake/unstake when all steps are valid and order is safe.

Explicitly unsupported in v1:

- Cross-chain operations.
- Bridging, swapping, borrowing, leverage, MEV routing, or DEX execution.
- Arbitrary calldata generation.
- Choosing validators by opaque yield prediction.
- Auto-signing, session keys, delegated wallet permissions, private key handling, or background execution.
- Strategies requiring future automation after the browser closes.
- Slippage-bearing operations.
- Partial withdrawals beyond what the staking contract exposes.
- “Move stake instantly” if protocol requires withdrawal delay.
- Plans that rely on stale reads or unknown reward proofs.

### 1.2 Supported Natural-Language Operation Types

The parser should map user text to one of these intents:

```ts
export type AgentIntent =
  | { kind: "stake"; amount: AgentAmount; validator: AgentValidatorRef }
  | { kind: "unstake"; amount: AgentAmount; validator: AgentValidatorRef }
  | { kind: "claim-withdrawal" }
  | { kind: "claim-rewards" }
  | { kind: "restake-rewards"; amount: AgentAmount; validator: AgentValidatorRef }
  | { kind: "rebalance"; from: AgentValidatorRef; to: AgentValidatorRef; amount: AgentAmount }
  | { kind: "compound-liquid"; amount: AgentAmount; validator: AgentValidatorRef }
```

Amount forms:

```ts
export type AgentAmount =
  | { type: "safe"; value: string }
  | { type: "percent-wallet"; value: number }
  | { type: "percent-validator-stake"; value: number }
  | { type: "all-wallet" }
  | { type: "all-validator-stake" }
  | { type: "all-claimable-rewards" }
```

Validator references:

```ts
export type AgentValidatorRef =
  | { type: "address"; value: Address }
  | { type: "label"; value: string }
  | { type: "best-active" }
```

`best-active` in v1 must be deterministic and transparent: choose the active validator with highest `participationRate`, then lowest `commission`, then highest `totalStake`, then label sort. The UI must show why it chose that validator.

### 1.3 User Interaction Flow

1. User sees a floating Staking Agent launcher on every app screen. The launcher defaults to the lower-right corner, can be dragged within the viewport, and remembers its last safe position in `localStorage`.
2. User clicks the launcher to open a chat-style dialog. The dialog opens as a compact panel on desktop and a bottom sheet on mobile. It never submits wallet requests on open.
3. If no wallet is connected, the chat shows read-only examples, explains that wallet connection is only needed for live validation/execution, and offers a connect button.
4. The Agent greets the user with friendly guided prompts such as:
   - “Claim rewards”
   - “Stake 100 SAFE”
   - “Restake rewards”
   - “Move stake between validators”
5. User enters natural-language instruction, for example:
   - “Stake 100 SAFE to Core Contributors.”
   - “Claim rewards and restake them to the best active validator.”
   - “Unstake 25% from Gnosis.”
   - “Move 500 SAFE from Gnosis to Core Contributors when it becomes available.”
6. User clicks send or presses Enter. Shift+Enter inserts a newline. No wallet signature is requested.
7. Agent appends a user message and assistant status message, then parses the instruction into `AgentIntent` and renders:
   - Parsed intent summary.
   - Required assumptions.
   - Unsupported or ambiguous fields.
8. If ambiguous, the chat asks one clarifying question at a time, for example “Which validator did you mean?” or “Use wallet balance or staked balance?” User answers in the same dialog.
9. Agent compiles intent into `AgentPlan` using live account snapshot, validators, reward proof, Merkle root, allowance, withdrawal queue, and selected language messages.
10. Agent runs the same simulation path used by regular transaction plans.
11. UI displays a review card inside the chat:
   - Plan phases.
   - Transaction steps.
   - Expected balance/stake changes.
   - Required approvals.
   - Warnings and blocked reasons.
   - “This is not automatic. Your wallet will ask you to confirm each transaction.”
12. User chooses one of:
   - “Apply to manual workflow” to populate existing single-action UI.
   - “Submit transactions” for wallet confirmation or Safe owner confirmation, using existing execution logic.
   - “Edit instruction.”
13. After execution, Agent refreshes live reads and marks completed steps in the chat history. It does not schedule future actions automatically.

Launcher behavior:

- Default position: lower-right corner, above the footer on desktop and above mobile safe-area bottom inset.
- Dragging starts after a small pointer movement threshold so ordinary clicks still open the dialog.
- Position is clamped to the viewport and recalculated on resize/orientation change.
- Keyboard users can focus the launcher and press Enter/Space to open. Dragging is optional; fixed lower-right behavior remains usable.
- The dialog has close/minimize controls, Escape closes it, focus is trapped while open, and focus returns to the launcher when closed.
- New message badges are local-only and cleared when the chat opens.
- The chat history is session-local by default; do not persist natural-language instructions unless a future explicit setting is added.

### 1.4 Permission and Safety Model

Hard rules:

- No transaction can be submitted during parse or compile.
- Agent cannot bypass `ensureMainnet()`.
- Agent cannot submit if `simulation.status === "failed"`.
- Agent cannot submit a plan built from stale account data. Stale means the plan references a snapshot older than the latest `liveBlock` refresh after instruction parse; if the account, chain, validator set, reward proof, or Merkle root changes, the plan becomes invalid.
- Agent cannot submit if the user changes account or chain after drafting.
- Agent cannot generate calldata. It can only call typed plan builders.
- Agent cannot create approvals above the exact required stake amount in v1.
- Agent cannot execute delayed phase 2 rebalance automatically.
- Agent cannot hide warnings. Warnings from child `TxPlan`s must be promoted to the review screen.
- Agent cannot claim rewards if Merkle root mismatches.
- Agent cannot stake to inactive validators.
- Agent cannot unstake more than `validator.userStake`.
- Agent cannot stake more than `safeBalance` unless the source is claimable rewards in a reviewed claim-then-stake sequence.
- Agent cannot use “best” validator without showing deterministic ranking criteria.
- Agent cannot obscure wallet prompts or transaction review surfaces. The chat dialog must close or shrink before a wallet confirmation request if it would overlap the wallet UI.
- Agent cannot treat a drag/drop movement as approval. Only explicit CTA buttons in the review card can apply or submit a plan.

Risk controls:

- Add an `AgentRisk` model with severity `info | warning | blocked`.
- Plans with any `blocked` risk cannot be submitted.
- Plans with warnings require explicit checkbox acknowledgement before submit.
- Any multi-transaction plan shows transaction count and order before wallet prompt.
- Any plan containing ERC20 approval highlights exact approval amount and spender.

### 1.5 Boundary Cases

Parser boundaries:

- Empty input -> ask for instruction.
- Multiple conflicting intents -> ask user to split or choose one.
- Unknown validator name -> show close matches.
- Ambiguous “all” -> ask “all wallet SAFE” vs “all staked SAFE” vs “all claimable rewards”.
- Percent without base -> ask for base.
- Amount below/zero/invalid decimals -> block.
- Unsupported terms like “swap”, “bridge”, “borrow”, “leverage”, “airdrop”, “delegate access”, “every day”, “automatically forever” -> block with unsupported-operation risk.

State boundaries:

- Wallet disconnected -> parse allowed, compile blocked.
- Wrong chain -> parse allowed, compile prompts switch, submit blocked until switched.
- Live reads failed -> compile blocked.
- Validator metadata unavailable -> compile blocked for validator-selecting intents; claim-only may proceed if account state is available.
- Reward proof API unavailable -> reward intents blocked; stake/unstake unaffected.
- Merkle root mismatch -> reward intents blocked.
- No claimable withdrawal -> claim withdrawal blocked.
- Pending but not claimable withdrawal -> explain next claimable timestamp.
- Stake intent requires approval -> plan includes exact approve tx first.
- Wallet does not support sequential transactions well -> use the Safe owner flow where applicable.
- Account changes after draft -> invalidate plan.
- `amount=max` with balance changing after approval/claim -> require refresh and rebuild.

Execution boundaries:

- User rejects wallet signature -> stop, preserve draft, show rejected state.
- First tx succeeds and second fails -> refresh live reads, mark partial completion, require rebuild before retry.
- Approval succeeds but stake rejected -> show remaining next step and require rebuild.
- Transaction receipt timeout -> show pending hash, refresh reads when possible.
- Safe multisig execution for multi-phase delayed rebalance -> execute only the current claimable phase; include note for future phase.

## 2. Technical方案

### 2.1 Module Map

Create focused Agent modules under `src/agent`:

- `src/agent/types.ts`
  - Owns `AgentIntent`, `AgentAmount`, `AgentPlan`, `AgentPlanPhase`, `AgentStep`, `AgentRisk`, `AgentContext`, `AgentDraft`.
- `src/agent/parser.ts`
  - Deterministic parser from text to `AgentParseResult`. Uses regex and known validator labels; no external calls.
- `src/agent/amounts.ts`
  - Resolves `AgentAmount` into decimal SAFE string and bigint using wallet/validator/reward context.
- `src/agent/validators.ts`
  - Resolves validator references and deterministic `best-active` ranking.
- `src/agent/compiler.ts`
  - Converts validated intent + context into `AgentPlan` using protocol plan builders.
- `src/agent/risk.ts`
  - Central validation and risk generation.
- `src/agent/index.ts`
  - Exports public Agent API.
- `src/app/AgentLauncher.tsx`
  - Floating draggable launcher, open/closed state, viewport clamping, local position persistence, unread badge.
- `src/app/AgentChatDialog.tsx`
  - Chat dialog/bottom sheet, guided prompt chips, message list, instruction composer, parsed summary, risk list, plan phase cards, CTA buttons.

Modify existing files:

- `src/protocol/txPlan.ts`
  - Add optional `source?: "manual" | "agent"` only if useful for display; avoid if not needed.
  - Consider adding `combineTxPlans(title, plans)` only after tests prove duplication.
- `src/app/App.tsx`
  - Build `AgentContext` from existing `account`, `liveSnapshot`, `validators`, `summary`, `rewardProof`, `liveMerkleRoot`, `chainId`, `liveBlock`.
  - Mount `<AgentLauncher />` once at the app shell level so it is available from every route.
  - Reuse simulation, transaction submission, Safe owner execution, and wallet connect through explicit callbacks passed into the chat dialog.
- `src/app/i18n.ts`
  - Add Agent UI copy in English and Chinese.
- `src/styles.css`
  - Add launcher, drag states, dialog, message bubbles, prompt chips, plan cards, and mobile bottom-sheet styles.
- `scripts/system-test.mjs`
  - Check that the launcher renders on existing routes and does not break SPA routing.

### 2.2 Key Interfaces

`src/agent/types.ts`:

```ts
import type { Address } from "viem"
import type { AccountSnapshot, TxPlan, ValidatorInfo } from "../protocol"
import type { AccountSummary } from "../app/types"

export type AgentIntentKind =
  | "stake"
  | "unstake"
  | "claim-withdrawal"
  | "claim-rewards"
  | "restake-rewards"
  | "rebalance"
  | "compound-liquid"

export type AgentAmount =
  | { type: "safe"; value: string }
  | { type: "percent-wallet"; value: number }
  | { type: "percent-validator-stake"; value: number }
  | { type: "all-wallet" }
  | { type: "all-validator-stake" }
  | { type: "all-claimable-rewards" }

export type AgentValidatorRef =
  | { type: "address"; value: Address }
  | { type: "label"; value: string }
  | { type: "best-active" }

export type AgentIntent =
  | { kind: "stake"; amount: AgentAmount; validator: AgentValidatorRef }
  | { kind: "unstake"; amount: AgentAmount; validator: AgentValidatorRef }
  | { kind: "claim-withdrawal" }
  | { kind: "claim-rewards" }
  | { kind: "restake-rewards"; amount: AgentAmount; validator: AgentValidatorRef }
  | { kind: "rebalance"; from: AgentValidatorRef; to: AgentValidatorRef; amount: AgentAmount }
  | { kind: "compound-liquid"; amount: AgentAmount; validator: AgentValidatorRef }

export type AgentRisk = {
  severity: "info" | "warning" | "blocked"
  code: string
  message: string
}

export type AgentPlanPhase = {
  id: string
  title: string
  executableNow: boolean
  plans: TxPlan[]
  risks: AgentRisk[]
}

export type AgentPlan = {
  id: string
  instruction: string
  intent: AgentIntent
  account: Address
  createdAtBlock: bigint | null
  phases: AgentPlanPhase[]
  risks: AgentRisk[]
}

export type AgentContext = {
  account: Address | null
  chainId: number | null
  liveBlock: bigint | null
  liveSnapshot: AccountSnapshot | null
  summary: AccountSummary
  validators: ValidatorInfo[]
  rewardProof: Awaited<ReturnType<typeof import("../protocol").fetchRewardProof>> | null
  liveMerkleRoot: string | null
}

export type AgentParseResult =
  | { status: "ok"; intent: AgentIntent; risks: AgentRisk[] }
  | { status: "needs-clarification"; question: string; risks: AgentRisk[] }
  | { status: "blocked"; risks: AgentRisk[] }
```

`src/agent/parser.ts`:

```ts
export function parseAgentInstruction(input: string, validators: ValidatorInfo[]): AgentParseResult
```

Parsing approach:

- Lowercase and normalize whitespace.
- Detect unsupported keywords first.
- Detect claim withdrawal/rewards phrases.
- Detect restake rewards phrases.
- Detect rebalance/move phrases with `from ... to ...`.
- Detect stake/unstake phrases with amount and validator.
- Resolve validator label candidates by exact lowercase label first, then `includes` matches.
- Return clarification instead of guessing when more than one validator matches.

`src/agent/compiler.ts`:

```ts
export function compileAgentPlan(instruction: string, intent: AgentIntent, context: AgentContext): AgentPlan
export function flattenExecutableTxPlan(plan: AgentPlan): TxPlan | null
```

`flattenExecutableTxPlan` returns a single combined `TxPlan` only when every phase is executable now and no blocked risks exist. For delayed rebalance it returns `null` and UI should display current phase only.

### 2.3 Integration Points

Existing reusable pieces:

- Live state: `readAccountSnapshot`, `readValidatorPositions`, `readHealth`, `fetchRewardProof` in `App.tsx`.
- Plan builders: `planStake`, `planUnstake`, `planClaimWithdrawal`, `planClaimRewards`.
- Simulation: existing `simulateTxPlan` in `App.tsx`.
- Submission: existing `submitPlan` in `App.tsx` after setting `txPlan`.
- Safe execution: existing wallet/Safe owner execution path.
- Validator UI/copy: `ValidatorInfo`, `formatSafe`, `compactAddress`, `TxPlanPanel` patterns.

Needed extraction before clean Agent UI:

- Move `TxPlanPanel` from `views.tsx` to `src/app/txPlanPanel.tsx`, or export it from `views.tsx`. Prefer extraction only if Agent UI needs it directly.
- Add `combineTxPlans` to protocol only if Agent needs multi-plan execution in one review panel:

```ts
export function combineTxPlans(params: {
  action: TxPlanAction
  title: string
  account: Address
  plans: TxPlan[]
  warnings?: string[]
}): TxPlan {
  return {
    action: params.action,
    title: params.title,
    account: params.account,
    txs: params.plans.flatMap((plan) => plan.txs),
    warnings: [...params.plans.flatMap((plan) => plan.warnings), ...(params.warnings ?? [])],
  }
}
```

But this exact type may require widening `TxPlanAction` or adding `"agent"`; safer is:

```ts
export type TxPlanAction = "stake" | "unstake" | "claim-withdrawal" | "claim-rewards" | "agent-plan"
```

Then update `translateTxTitle`, `TxOutcomePreview`, and tests.

### 2.4 Implementation Phases

Phase A: Core Agent engine, no UI.

- Parser, amount resolver, validator resolver, compiler, risk tests.
- Can be tested entirely with Node scripts and mock data.

Phase B: UI draft flow.

- Add global floating chatbot launcher and dialog.
- Chat instruction -> parsed intent -> risk/plan preview.
- No submit from Agent yet; only “Apply first executable plan to manual review”.

Phase C: Execution integration.

- Combine executable now phases into a `TxPlan`.
- Reuse simulation/submission/Safe execution.
- Add warning acknowledgement.

Phase D: Optional external LLM adapter.

- Add only after deterministic v1 works.
- LLM output is limited to conversational guidance. Deterministic parser/compiler output remains the only source for executable plans.
- Do not send secrets or wallet session data to the LLM. Keep API keys server-side and send only minimal redacted context such as connection status, chain id, live-data availability, and validator labels.

## 3. Implementation Tasks

### Task 1: Agent Core Types and Tests

**Files:**
- Create: `src/agent/types.ts`
- Create: `src/agent/index.ts`
- Create: `scripts/agent-core-test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `AgentIntent`, `AgentAmount`, `AgentValidatorRef`, `AgentRisk`, `AgentPlan`, `AgentContext`, `AgentParseResult`.
- Consumes: existing protocol and app types only.

- [ ] **Step 1: Create `src/agent/types.ts`**

```ts
import type { Address } from "viem"
import type { AccountSnapshot, TxPlan, ValidatorInfo } from "../protocol"
import type { AccountSummary } from "../app/types"

export type AgentAmount =
  | { type: "safe"; value: string }
  | { type: "percent-wallet"; value: number }
  | { type: "percent-validator-stake"; value: number }
  | { type: "all-wallet" }
  | { type: "all-validator-stake" }
  | { type: "all-claimable-rewards" }

export type AgentValidatorRef =
  | { type: "address"; value: Address }
  | { type: "label"; value: string }
  | { type: "best-active" }

export type AgentIntent =
  | { kind: "stake"; amount: AgentAmount; validator: AgentValidatorRef }
  | { kind: "unstake"; amount: AgentAmount; validator: AgentValidatorRef }
  | { kind: "claim-withdrawal" }
  | { kind: "claim-rewards" }
  | { kind: "restake-rewards"; amount: AgentAmount; validator: AgentValidatorRef }
  | { kind: "rebalance"; from: AgentValidatorRef; to: AgentValidatorRef; amount: AgentAmount }
  | { kind: "compound-liquid"; amount: AgentAmount; validator: AgentValidatorRef }

export type AgentRisk = {
  severity: "info" | "warning" | "blocked"
  code: string
  message: string
}

export type AgentPlanPhase = {
  id: string
  title: string
  executableNow: boolean
  plans: TxPlan[]
  risks: AgentRisk[]
}

export type AgentPlan = {
  id: string
  instruction: string
  intent: AgentIntent
  account: Address
  createdAtBlock: bigint | null
  phases: AgentPlanPhase[]
  risks: AgentRisk[]
}

export type AgentContext = {
  account: Address | null
  chainId: number | null
  liveBlock: bigint | null
  liveSnapshot: AccountSnapshot | null
  summary: AccountSummary
  validators: ValidatorInfo[]
  rewardProof: { cumulativeAmount: string; merkleRoot: `0x${string}`; proof: `0x${string}`[] | null } | null
  liveMerkleRoot: string | null
}

export type AgentParseResult =
  | { status: "ok"; intent: AgentIntent; risks: AgentRisk[] }
  | { status: "needs-clarification"; question: string; risks: AgentRisk[] }
  | { status: "blocked"; risks: AgentRisk[] }
```

- [ ] **Step 2: Create `src/agent/index.ts`**

```ts
export * from "./types"
```

- [ ] **Step 3: Add core import smoke test script**

```js
import { pathToFileURL } from "node:url"

await import(pathToFileURL("./src/agent/index.ts").href)
console.log("Agent core tests passed")
```

Use `tsx` because TypeScript source is imported directly:

```json
"test:agent": "tsx scripts/agent-core-test.mjs"
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm test:agent
pnpm check
```

Expected: both pass.

- [ ] **Step 5: Review checkpoint**

Changed files for review: `src/agent/types.ts`, `src/agent/index.ts`, `scripts/agent-core-test.mjs`, `package.json`.
Suggested commit message if the user explicitly asks for a commit: `feat: add staking agent core types`.
Without explicit commit approval, run `git diff --stat` and report the changed scope.

### Task 2: Deterministic Natural-Language Parser

**Files:**
- Create: `src/agent/parser.ts`
- Modify: `src/agent/index.ts`
- Modify: `scripts/agent-core-test.mjs`

**Interfaces:**
- Consumes: `AgentParseResult` from Task 1, `ValidatorInfo`.
- Produces: `parseAgentInstruction(input: string, validators: ValidatorInfo[]): AgentParseResult`.

- [ ] **Step 1: Add parser tests**

Append to `scripts/agent-core-test.mjs`:

```js
import assert from "node:assert/strict"
import { parseAgentInstruction } from "../src/agent/parser.ts"
import { mockValidators } from "../src/protocol/mockData.ts"

function ok(input) {
  const result = parseAgentInstruction(input, mockValidators)
  assert.equal(result.status, "ok", input)
  return result.intent
}

assert.deepEqual(ok("stake 100 safe to Core Contributors"), {
  kind: "stake",
  amount: { type: "safe", value: "100" },
  validator: { type: "label", value: "Core Contributors" },
})
assert.deepEqual(ok("unstake 25% from Gnosis"), {
  kind: "unstake",
  amount: { type: "percent-validator-stake", value: 25 },
  validator: { type: "label", value: "Gnosis" },
})
assert.deepEqual(ok("claim rewards"), { kind: "claim-rewards" })
assert.deepEqual(ok("claim withdrawal"), { kind: "claim-withdrawal" })
assert.deepEqual(ok("claim rewards and restake all to best validator"), {
  kind: "restake-rewards",
  amount: { type: "all-claimable-rewards" },
  validator: { type: "best-active" },
})
assert.deepEqual(ok("move 500 safe from Gnosis to Core Contributors"), {
  kind: "rebalance",
  from: { type: "label", value: "Gnosis" },
  to: { type: "label", value: "Core Contributors" },
  amount: { type: "safe", value: "500" },
})

const unsupported = parseAgentInstruction("bridge SAFE to arbitrum", mockValidators)
assert.equal(unsupported.status, "blocked")
assert.equal(unsupported.risks[0].code, "unsupported-operation")

const empty = parseAgentInstruction("   ", mockValidators)
assert.equal(empty.status, "needs-clarification")
```

- [ ] **Step 2: Implement `src/agent/parser.ts`**

```ts
import { isAddress, type Address } from "viem"
import type { AgentAmount, AgentIntent, AgentParseResult, AgentValidatorRef } from "./types"
import type { ValidatorInfo } from "../protocol"

const unsupportedPattern = /\b(bridge|swap|borrow|lend|leverage|short|long|airdrop|delegate|session key|automatic|forever|daily|weekly)\b/i

export function parseAgentInstruction(input: string, validators: ValidatorInfo[]): AgentParseResult {
  const original = input.trim()
  const text = original.toLowerCase().replace(/\s+/g, " ")
  if (!text) {
    return { status: "needs-clarification", question: "What staking action should the Agent draft?", risks: [] }
  }
  if (unsupportedPattern.test(text)) {
    return {
      status: "blocked",
      risks: [{ severity: "blocked", code: "unsupported-operation", message: "This instruction asks for an unsupported operation." }],
    }
  }
  if (/claim\s+(a\s+)?withdrawal|claim\s+withdrawals/.test(text)) {
    return { status: "ok", intent: { kind: "claim-withdrawal" }, risks: [] }
  }
  if (/claim\s+rewards?\s+and\s+restake/.test(text)) {
    return { status: "ok", intent: { kind: "restake-rewards", amount: { type: "all-claimable-rewards" }, validator: parseValidatorRef(text, validators, "to") ?? { type: "best-active" } }, risks: [] }
  }
  if (/claim\s+rewards?/.test(text)) {
    return { status: "ok", intent: { kind: "claim-rewards" }, risks: [] }
  }
  if (/\b(move|rebalance)\b/.test(text)) {
    const amount = parseAmount(text, "validator")
    const from = parseValidatorRef(text, validators, "from")
    const to = parseValidatorRef(text, validators, "to")
    if (!amount || !from || !to) return { status: "needs-clarification", question: "Which amount and validators should be used for the rebalance?", risks: [] }
    return { status: "ok", intent: { kind: "rebalance", from, to, amount }, risks: [] }
  }
  if (/\bunstake\b/.test(text)) {
    const amount = parseAmount(text, "validator")
    const validator = parseValidatorRef(text, validators, "from") ?? parseValidatorRef(text, validators, "validator")
    if (!amount || !validator) return { status: "needs-clarification", question: "Which amount and validator should be unstaked?", risks: [] }
    return { status: "ok", intent: { kind: "unstake", amount, validator }, risks: [] }
  }
  if (/\bstake\b/.test(text)) {
    const amount = parseAmount(text, "wallet")
    const validator = parseValidatorRef(text, validators, "to") ?? parseValidatorRef(text, validators, "validator")
    if (!amount || !validator) return { status: "needs-clarification", question: "Which amount and validator should be staked?", risks: [] }
    return { status: "ok", intent: { kind: "stake", amount, validator }, risks: [] }
  }
  return { status: "needs-clarification", question: "I can draft stake, unstake, claim, restake, and rebalance plans. Which one do you want?", risks: [] }
}

function parseAmount(text: string, percentBase: "wallet" | "validator"): AgentAmount | null {
  if (/\ball\s+(wallet\s+)?safe\b|\bmax\b/.test(text)) return { type: percentBase === "wallet" ? "all-wallet" : "all-validator-stake" }
  const percent = text.match(/(\d+(?:\.\d+)?)\s*%/)
  if (percent) return { type: percentBase === "wallet" ? "percent-wallet" : "percent-validator-stake", value: Number(percent[1]) }
  const safe = text.match(/(\d+(?:\.\d{1,18})?)\s*safe\b/)
  if (safe) return { type: "safe", value: safe[1] }
  return null
}

function parseValidatorRef(text: string, validators: ValidatorInfo[], marker: "to" | "from" | "validator"): AgentValidatorRef | null {
  if (/best\s+(active\s+)?validator|best validator/.test(text)) return { type: "best-active" }
  const address = text.match(/0x[a-f0-9]{40}/i)?.[0]
  if (address && isAddress(address)) return { type: "address", value: address as Address }
  const afterMarker = marker === "validator" ? text : text.split(` ${marker} `)[1]
  if (!afterMarker) return null
  const matches = validators.filter((validator) => afterMarker.includes(validator.label.toLowerCase()))
  if (matches.length === 1) return { type: "label", value: matches[0].label }
  return null
}
```

- [ ] **Step 3: Export parser**

```ts
export * from "./parser"
export * from "./types"
```

- [ ] **Step 4: Run tests**

```bash
pnpm test:agent
pnpm check
```

Expected: pass.

- [ ] **Step 5: Review checkpoint**

Changed files for review: `src/agent/parser.ts`, `src/agent/index.ts`, `scripts/agent-core-test.mjs`.
Suggested commit message if the user explicitly asks for a commit: `feat: parse staking agent instructions`.
Without explicit commit approval, run `git diff --stat` and report the changed scope.

### Task 3: Amount and Validator Resolution

**Files:**
- Create: `src/agent/amounts.ts`
- Create: `src/agent/validators.ts`
- Modify: `src/agent/index.ts`
- Modify: `scripts/agent-core-test.mjs`

**Interfaces:**
- Produces: `resolveAgentAmount(amount, context, validator?)`, `resolveAgentValidator(ref, validators)`.

- [ ] **Step 1: Add tests**

Add assertions:

```js
import { resolveAgentAmount } from "../src/agent/amounts.ts"
import { resolveAgentValidator } from "../src/agent/validators.ts"

const eth = 10n ** 18n
const context = {
  summary: { safeBalance: 1000n * eth, totalStaked: 2000n * eth, pendingWithdrawals: 0n, claimableWithdrawals: 0n, claimableRewards: 50n * eth, withdrawDelay: 0n },
}
const core = mockValidators[0]
assert.equal(resolveAgentAmount({ type: "percent-wallet", value: 25 }, context, core).text, "250")
assert.equal(resolveAgentAmount({ type: "percent-validator-stake", value: 50 }, context, core).text, "1000")
assert.equal(resolveAgentAmount({ type: "all-claimable-rewards" }, context, core).text, "50")
assert.equal(resolveAgentValidator({ type: "best-active" }, mockValidators).validator.label, "Core Contributors")
```

- [ ] **Step 2: Implement amount resolver**

```ts
import { formatUnits } from "viem"
import type { ValidatorInfo } from "../protocol"
import type { AccountSummary } from "../app/types"
import type { AgentAmount } from "./types"

export type AgentAmountContext = { summary: AccountSummary }
export type ResolvedAgentAmount = { text: string; value: bigint }

export function resolveAgentAmount(amount: AgentAmount, context: AgentAmountContext, validator?: ValidatorInfo): ResolvedAgentAmount {
  if (amount.type === "safe") return { text: amount.value, value: parseSafeAmountText(amount.value) }
  if (amount.type === "all-wallet") return fromBigint(context.summary.safeBalance)
  if (amount.type === "all-validator-stake") {
    if (!validator) throw new Error("Validator stake amount requires a validator.")
    return fromBigint(validator.userStake)
  }
  if (amount.type === "all-claimable-rewards") return fromBigint(context.summary.claimableRewards)
  if (amount.type === "percent-wallet") return percent(context.summary.safeBalance, amount.value)
  if (amount.type === "percent-validator-stake") {
    if (!validator) throw new Error("Validator percentage requires a validator.")
    return percent(validator.userStake, amount.value)
  }
  throw new Error("Unsupported amount.")
}

function percent(base: bigint, value: number): ResolvedAgentAmount {
  if (!Number.isFinite(value) || value <= 0 || value > 100) throw new Error("Percent must be greater than 0 and at most 100.")
  return fromBigint((base * BigInt(Math.round(value * 100))) / 10000n)
}

function fromBigint(value: bigint): ResolvedAgentAmount {
  return { value, text: trimSafe(formatUnits(value, 18)) }
}

function trimSafe(value: string): string {
  return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")
}

function parseSafeAmountText(value: string): bigint {
  const clean = value.trim().replace(/,/g, "")
  if (!/^\d+(\.\d{1,18})?$/.test(clean)) throw new Error("Amount must be a SAFE decimal with at most 18 decimals.")
  const [whole, fraction = ""] = clean.split(".")
  const bigint = BigInt(whole) * 10n ** 18n + BigInt((fraction + "0".repeat(18)).slice(0, 18))
  if (bigint <= 0n) throw new Error("Amount must be greater than zero.")
  return bigint
}
```

- [ ] **Step 3: Implement validator resolver**

```ts
import { getAddress } from "viem"
import type { ValidatorInfo } from "../protocol"
import type { AgentValidatorRef } from "./types"

export function resolveAgentValidator(ref: AgentValidatorRef, validators: ValidatorInfo[]): { validator: ValidatorInfo; reason: string } {
  if (ref.type === "address") {
    const address = getAddress(ref.value)
    const validator = validators.find((item) => item.address === address)
    if (!validator) throw new Error(`Unknown validator: ${address}`)
    return { validator, reason: "Selected by address." }
  }
  if (ref.type === "label") {
    const normalized = ref.value.toLowerCase()
    const matches = validators.filter((item) => item.label.toLowerCase() === normalized)
    if (matches.length !== 1) throw new Error(`Unknown validator: ${ref.value}`)
    return { validator: matches[0], reason: "Selected by name." }
  }
  const active = validators.filter((item) => item.status === "active")
  if (!active.length) throw new Error("No active validators are available.")
  const [validator] = [...active].sort((a, b) => {
    if (b.participationRate !== a.participationRate) return b.participationRate - a.participationRate
    if (a.commission !== b.commission) return a.commission - b.commission
    if (a.totalStake !== b.totalStake) return a.totalStake > b.totalStake ? -1 : 1
    return a.label.localeCompare(b.label)
  })
  return { validator, reason: "Selected highest participation, then lowest commission, then highest total stake." }
}
```

- [ ] **Step 4: Export modules and run tests**

```bash
pnpm test:agent
pnpm check
```

- [ ] **Step 5: Review checkpoint**

Changed files for review: `src/agent/amounts.ts`, `src/agent/validators.ts`, `src/agent/index.ts`, `scripts/agent-core-test.mjs`.
Suggested commit message if the user explicitly asks for a commit: `feat: resolve staking agent amounts and validators`.
Without explicit commit approval, run `git diff --stat` and report the changed scope.

### Task 4: Compile Agent Intent to Safe TxPlan Phases

**Files:**
- Create: `src/agent/compiler.ts`
- Modify: `src/agent/index.ts`
- Modify: `scripts/agent-core-test.mjs`

**Interfaces:**
- Produces: `compileAgentPlan(instruction, intent, context): AgentPlan`, `flattenExecutableTxPlan(plan): TxPlan | null`.

- [ ] **Step 1: Add compiler tests**

Add:

```js
import { compileAgentPlan, flattenExecutableTxPlan } from "../src/agent/compiler.ts"
import { mockSummary } from "../src/protocol/mockData.ts"

const agentContext = {
  account,
  chainId: 1,
  liveBlock: 123n,
  liveSnapshot: {
    safeBalance: mockSummary.safeBalance,
    totalStaked: mockSummary.totalStaked,
    pendingWithdrawals: [],
    nextClaimableWithdrawal: [mockSummary.claimableWithdrawals, 0n],
    cumulativeClaimed: 0n,
    withdrawDelay: mockSummary.withdrawDelay,
    stakingAllowance: 0n,
  },
  summary: mockSummary,
  validators: mockValidators,
  rewardProof: { cumulativeAmount: String(mockSummary.claimableRewards), merkleRoot: "0x" + "11".repeat(32), proof: ["0x" + "22".repeat(32)] },
  liveMerkleRoot: "0x" + "11".repeat(32),
}

const stakePlan = compileAgentPlan("stake 100 safe to Core Contributors", ok("stake 100 safe to Core Contributors"), agentContext)
assert.equal(stakePlan.risks.some((risk) => risk.severity === "blocked"), false)
assert.equal(flattenExecutableTxPlan(stakePlan).txs.length, 2)

const rebalancePlan = compileAgentPlan("move 500 safe from Gnosis to Core Contributors", ok("move 500 safe from Gnosis to Core Contributors"), agentContext)
assert.equal(rebalancePlan.phases.length, 2)
assert.equal(rebalancePlan.phases[1].executableNow, false)
assert.equal(flattenExecutableTxPlan(rebalancePlan), null)
```

- [ ] **Step 2: Implement compiler**

Implementation rules:

- First validate `account`, `liveSnapshot`, `chainId === 1`.
- Resolve validators and amounts.
- Call existing plan builders.
- For `restake-rewards`, build claim rewards plan and stake plan using resolved reward amount.
- For `rebalance`, phase 1 uses `planUnstake`; phase 2 is non-executable and describes future claim/stake.
- `flattenExecutableTxPlan` returns combined `TxPlan` only if no blocked risks and all phases executable now.

Use this exact combined action by widening protocol type in the same task:

```ts
export type TxPlanAction = "stake" | "unstake" | "claim-withdrawal" | "claim-rewards" | "agent-plan"
```

Update `translateTxTitle` to return `plan.title` for `agent-plan`.

- [ ] **Step 3: Run tests**

```bash
pnpm test:agent
pnpm check
```

- [ ] **Step 4: Review checkpoint**

Changed files for review: `src/agent/compiler.ts`, `src/agent/index.ts`, `scripts/agent-core-test.mjs`, `src/protocol/txPlan.ts`, `src/app/formatters.ts`.
Suggested commit message if the user explicitly asks for a commit: `feat: compile staking agent plans`.
Without explicit commit approval, run `git diff --stat` and report the changed scope.

### Task 5: Floating Chatbot Launcher and Draft Dialog

**Files:**
- Create: `src/app/AgentLauncher.tsx`
- Create: `src/app/AgentChatDialog.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/i18n.ts`
- Modify: `src/styles.css`
- Modify: `scripts/system-test.mjs`

**Interfaces:**
- Consumes: parser/compiler from Tasks 2-4.
- Produces: global draggable chatbot launcher and chat dialog that drafts plans without execution.

- [ ] **Step 1: Add i18n copy**

English keys:

```ts
agent: "Agent",
agentTitle: "Staking Agent",
agentLauncherLabel: "Open Staking Agent",
agentGreeting: "Tell me what you want to do with your SAFE staking position. I will draft a plan for you to review before any wallet confirmation.",
agentPrompt: "Message the staking agent",
agentPlaceholder: "Ask: claim rewards and restake them",
agentSend: "Send",
agentMinimize: "Minimize agent",
agentClose: "Close agent",
agentPromptClaimRewards: "Claim rewards",
agentPromptStake: "Stake 100 SAFE",
agentPromptRestake: "Restake rewards",
agentPromptRebalance: "Move stake",
agentParsedIntent: "Parsed intent",
agentRisks: "Checks and risks",
agentPlanPhases: "Plan phases",
agentNoPlan: "No agent plan drafted yet.",
applyAgentPlan: "Review executable plan",
agentUnsupported: "Unsupported instruction.",
agentClarification: "Clarification needed",
agentWalletRequired: "Connect wallet and load live data before drafting an executable agent plan.",
agentReviewReminder: "Nothing will be submitted until you confirm in your wallet.",
agentDragHint: "Drag to move",
```

Chinese keys:

```ts
agent: "Agent",
agentTitle: "质押 Agent",
agentLauncherLabel: "打开质押 Agent",
agentGreeting: "告诉我你想如何处理 SAFE 质押仓位。我会先生成可检查的计划，任何链上操作都需要你用钱包确认。",
agentPrompt: "给质押 Agent 发消息",
agentPlaceholder: "例如：领取奖励并复投",
agentSend: "发送",
agentMinimize: "最小化 Agent",
agentClose: "关闭 Agent",
agentPromptClaimRewards: "领取奖励",
agentPromptStake: "质押 100 SAFE",
agentPromptRestake: "复投奖励",
agentPromptRebalance: "移动质押",
agentParsedIntent: "解析结果",
agentRisks: "检查与风险",
agentPlanPhases: "计划阶段",
agentNoPlan: "尚未生成 Agent 计划。",
applyAgentPlan: "检查可执行计划",
agentUnsupported: "不支持的指令。",
agentClarification: "需要补充信息",
agentWalletRequired: "请先连接钱包并加载实时数据，再生成可执行 Agent 计划。",
agentReviewReminder: "在你通过钱包确认前，不会提交任何链上交易。",
agentDragHint: "拖拽移动",
```

- [ ] **Step 2: Create `AgentChatDialog.tsx`**

The component should accept:

```ts
export type AgentChatDialogProps = {
  t: MessageBundle
  isOpen: boolean
  context: AgentContext
  onClose: () => void
  onConnectWallet: () => Promise<void>
  onApplyPlan: (plan: TxPlan) => void
}
```

Required behavior:

- Render greeting assistant bubble.
- Render prompt chips: claim rewards, stake 100 SAFE, restake rewards, move stake.
- Render composer with Enter-to-send and Shift+Enter newline.
- On send, append user bubble.
- Call `parseAgentInstruction(input, context.validators)`.
- If clarification/block, append assistant bubble with question or blocked risk.
- If ok and wallet/live data missing, append assistant bubble with `agentWalletRequired` and connect button.
- If ok and context is ready, call `compileAgentPlan`.
- Render plan card with parsed intent, risks, phases, and review reminder.
- If `flattenExecutableTxPlan(plan)` returns a plan and no blocked risk exists, show `applyAgentPlan` button.
- Do not submit transactions from this task.

Skeleton implementation outline:

```tsx
export function AgentChatDialog(props: AgentChatDialogProps) {
  const [input, setInput] = useState("")
  const [messages, setMessages] = useState<AgentChatMessage[]>([])

  function send(text = input) {
    const trimmed = text.trim()
    if (!trimmed) return
    setInput("")
    const userMessage: AgentChatMessage = { role: "user", content: trimmed }
    const parse = parseAgentInstruction(trimmed, props.context.validators)
    const assistantMessage =
      parse.status === "needs-clarification"
        ? { role: "assistant" as const, content: parse.question }
        : parse.status === "blocked"
          ? { role: "assistant" as const, content: parse.risks.map((risk) => risk.message).join("\n") }
          : buildDraftMessage(trimmed, parse.intent, props.context)
    setMessages((current) => [...current, userMessage, assistantMessage])
  }

  return props.isOpen ? (
    <section className="agent-dialog" role="dialog" aria-modal="false" aria-label={props.t.agentTitle}>
      {/* header, messages, prompt chips, composer */}
    </section>
  ) : null
}
```

- [ ] **Step 3: Create `AgentLauncher.tsx`**

The component should accept:

```ts
export type AgentLauncherProps = {
  t: MessageBundle
  context: AgentContext
  onConnectWallet: () => Promise<void>
  onApplyPlan: (plan: TxPlan) => void
}
```

Required behavior:

- Fixed-position launcher button, default lower-right.
- Pointer drag support with 6px movement threshold.
- Clamp position to viewport.
- Persist position in `localStorage` key `safecafe:agent-launcher-position`.
- Click opens dialog when pointer movement stays below threshold.
- Enter/Space opens dialog for keyboard users.
- Escape closes dialog.
- On mobile width `< 720px`, ignore persisted x/y and use bottom-right launcher plus full-width bottom-sheet dialog.

- [ ] **Step 4: Integrate in `App.tsx`**

- Build `agentContext` from current state:

```ts
const agentContext = useMemo(
  () => ({
    account,
    chainId,
    liveBlock,
    liveSnapshot,
    summary,
    validators,
    rewardProof,
    liveMerkleRoot,
  }),
  [account, chainId, liveBlock, liveSnapshot, summary, validators, rewardProof, liveMerkleRoot],
)
```

- Render near the end of the app shell, outside route-specific panels:

```tsx
<AgentLauncher
  t={t}
  context={agentContext}
  onConnectWallet={connectWallet}
  onApplyPlan={(plan) => {
    setTxPlan(plan)
    toast(t.planReady, "success")
  }}
/>
```

- Do not add an `agent` nav item.
- Do not add `/agent` route.

- [ ] **Step 5: Add CSS**

Add classes in `src/styles.css`:

```css
.agent-launcher {
  position: fixed;
  z-index: 60;
  width: 56px;
  height: 56px;
  border-radius: 999px;
  touch-action: none;
}

.agent-dialog {
  position: fixed;
  right: 24px;
  bottom: 92px;
  z-index: 70;
  width: min(420px, calc(100vw - 32px));
  max-height: min(680px, calc(100vh - 120px));
  display: grid;
  grid-template-rows: auto 1fr auto;
}

.agent-message-list {
  overflow: auto;
}

.agent-message {
  max-width: 88%;
}

.agent-message.user {
  margin-left: auto;
}

.agent-prompt-chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

@media (max-width: 720px) {
  .agent-dialog {
    left: 0;
    right: 0;
    bottom: 0;
    width: 100%;
    max-height: 82vh;
    border-radius: 16px 16px 0 0;
  }
}
```

Tune colors/spacing to match existing Safecafe panels and buttons. Do not use decorative gradient orbs.

- [ ] **Step 6: Add system smoke checks**

In `scripts/system-test.mjs`, keep existing route checks and do not add a new route:

```js
await expectRoute("/", "Safecafe")
await expectRoute("/stake", "Safecafe")
```

The current script checks rendered HTML without browser execution, so it cannot reliably assert React-only launcher DOM. Use `pnpm check` for compile-time integration and this system test for SPA route safety. Do not add `/agent` route.

- [ ] **Step 7: Run tests**

```bash
pnpm test:agent
pnpm check
pnpm test:system
```

- [ ] **Step 8: Review checkpoint**

Changed files for review: `src/app/AgentLauncher.tsx`, `src/app/AgentChatDialog.tsx`, `src/app/App.tsx`, `src/app/i18n.ts`, `src/styles.css`, `scripts/system-test.mjs`.
Suggested commit message if the user explicitly asks for a commit: `feat: add staking agent chat launcher`.
Without explicit commit approval, run `git diff --stat` and report the changed scope.

### Task 6: Agent Execution and Safe Export Integration

**Files:**
- Modify: `src/app/AgentChatDialog.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/i18n.ts`
- Modify: `scripts/system-test.mjs`

**Interfaces:**
- Consumes: `flattenExecutableTxPlan`.
- Produces: review/submit path for executable agent plans through existing wallet or Safe owner confirmation.

- [ ] **Step 1: Add warning acknowledgement state**

Agent chat review card must require explicit checkbox when `plan.risks` has warning or any child tx warnings exist. The checkbox lives inside the plan card, not in a modal.

- [ ] **Step 2: Add Safe owner execution path**

Use the existing Safe owner execution path through an App-level callback, not duplicate transaction construction logic. The dialog passes the executable flattened plan to the callback.

- [ ] **Step 3: Add submit button**

Only enabled when:

- wallet connected,
- live data loaded,
- no blocked risks,
- all phases executable now,
- simulation passed/partial,
- warnings acknowledged.

Before opening wallet confirmation, minimize the chat dialog if it overlaps the likely wallet extension area on desktop. This is a UI courtesy only; it is not a security boundary.

- [ ] **Step 4: Invalidate plan on account/chain/live block changes**

If `account`, `chainId`, or `liveBlock` changes after draft, show “Refresh and rebuild required” and disable submit. The chat history can remain visible, but the old plan card must be visibly stale.

- [ ] **Step 5: Run tests**

```bash
pnpm test:agent
pnpm check
pnpm test:integration
pnpm test:system
```

- [ ] **Step 6: Review checkpoint**

Changed files for review: `src/app/AgentChatDialog.tsx`, `src/app/App.tsx`, `src/app/i18n.ts`, `scripts/system-test.mjs`.
Suggested commit message if the user explicitly asks for a commit: `feat: execute reviewed staking agent chat plans`.
Without explicit commit approval, run `git diff --stat` and report the changed scope.

## Self-Review

Spec coverage:

- Functional design covered: capability boundary, operation types, user flow, permissions, security model, boundary cases.
- Technical design covered: module map, interfaces, integration with existing wallet/live reads/TxPlan/Safe execution flow.
- Implementation covered: six tasks with tests and commits.
- User's latest interaction request covered: global customer-support-style launcher, draggable entry point, chat dialog, guided prompt chips, and wallet-confirmation handoff.
- Safety requirement covered: no auto execution, wallet confirmation required, no calldata generation by Agent/parser/model.

Placeholder scan:

- No red-flag placeholder terms remain in executable task steps.
- Complex compiler implementation is described by explicit rules; implementation details are bounded by existing plan builders.

Type consistency:

- `AgentIntent`, `AgentContext`, `AgentPlan`, parser/compiler signatures are defined before UI tasks consume them.
- `agent-plan` widening is called out where required.

## Execution Recommendation

Start with Task 1-4 as a non-UI core slice. Do not start UI until parser/compiler tests pass. Keep v1 deterministic and local. Only consider external LLM integration after the deterministic Agent is usable and fully covered by tests.
