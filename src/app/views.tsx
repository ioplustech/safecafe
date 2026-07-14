import {
  ArrowDownToLine,
  Bot,
  CheckCircle2,
  Clock3,
  Database,
  Gift,
  Info,
  ShieldCheck,
  TerminalSquare,
  TrendingUp,
  Upload,
  Users,
} from "lucide-react"
import type { CSSProperties, ReactNode } from "react"
import type { Address } from "viem"
import {
  type AccountSnapshot,
  CONTRACTS,
  compactAddress,
  EXPLORER_BASE_URL,
  formatSafe,
  formatSafeInput,
  formatUsdFromSafe,
  type TxPlan,
  type ValidatorInfo,
} from "../protocol"
import { type ChainTxStepStatus, chainActionBusyLabel, chainTxStepStatuses } from "./actionStatus"
import { formatDelayLabel, merkleLabel, translateTxLabel } from "./formatters"
import type { MessageBundle } from "./i18n"
import { sourceRepositoryUrl } from "./releaseTrust"
import {
  type AccountSummary,
  type Action,
  type ActionExecutionSummary,
  type DataStatus,
  type LayoutDensity,
  layoutDensityOptions,
  type Modal,
  type NavItem,
} from "./types"
import {
  ActionButton,
  ButtonBusyLabel,
  CopyActionButton,
  CustomSelect,
  ExecutionSummaryCard,
  ExternalActionButton,
  FullPanel,
  InfoCard,
  Progress,
  StatusBadge,
  Tooltip,
} from "./ui"
import type { UserSafeApiStatus } from "./userSafeApiKey"

type ValidatorSort = "stake" | "participation" | "commission" | "name" | "yourStake"
type SubmittingAction = Action | "claim-rewards-and-stake" | null
type CustomRpcStatus = "checking" | "idle" | "invalid" | "valid"
type UserLlmStatus = "checking" | "idle" | "invalid" | "valid"
type UserLlmDraft = {
  apiBase: string
  apiKey: string
  maxTokens: string
  model: string
}
type ExecuteActionOptions = { amount?: string; validator?: Address }
type DecisionMetrics = {
  activeValidatorCount: number
  protocolTvlUsd: string
  validatorPoolTotal: bigint
  withdrawDelay: bigint
}
type ActionPreview = {
  amount: bigint
  authorization: string
  expectedOutcome: string
  gas: string
  risk: string
  steps: string[]
  validatorCommission: string
}
const validatorSkeletonKeys = [
  "validator-skeleton-1",
  "validator-skeleton-2",
  "validator-skeleton-3",
  "validator-skeleton-4",
]
export function DashboardView(props: {
  t: MessageBundle
  action: Action
  actionPreview: ActionPreview
  amount: string
  accountReady: boolean
  connectedAccount: Address | null
  executeClaimRewardsAndStake: (validator: Address) => Promise<void>
  executeAction: (action?: Action, options?: ExecuteActionOptions) => Promise<void>
  executionState: ActionExecutionSummary | null
  isLoadingValidators: boolean
  isSubmitting: boolean
  restakePreview: ActionPreview
  submittingAction: SubmittingAction
  modal: Modal
  onConnect: () => Promise<void>
  openExplorer: (address: Address) => void
  onContinueSafeProposal: () => void
  onCopySafeTxHash: (safeTxHash: string) => void
  onExportSafePayload: () => void
  selectAction: (action: Action) => void
  selectedValidator: ValidatorInfo
  setActiveNav: (nav: NavItem) => void
  setAmount: (amount: string) => void
  setModal: (modal: Modal) => void
  setShowOnlyActive: (value: boolean) => void
  setValidator: (address: Address) => void
  showOnlyActive: boolean
  summary: AccountSummary
  safePriceUsd: number | null
  txPlan: TxPlan | null
  txProgress: string
  validator: Address
  visibleValidators: ValidatorInfo[]
  validators: ValidatorInfo[]
  dataStatus: DataStatus
  decisionMetrics: DecisionMetrics
  stakingAllowance: bigint
  validatorPoolTotal: bigint
}) {
  const { t } = props
  const hasValidators = props.validators.length > 0
  const accountActionLabel = props.connectedAccount ? t.refreshLive : t.connectWallet
  const stakeOrUnstakeLoading = props.submittingAction === props.action
  const claimRewardsLoading = props.submittingAction === "claim-rewards"
  const claimAndStakeLoading = props.submittingAction === "claim-rewards-and-stake"
  const busyActionLabel = chainActionBusyLabel(t, props.txProgress)
  const actionExecution = props.executionState?.action === props.action ? props.executionState : null
  const formControlsDisabled = props.isSubmitting
  const validatorOptions = props.validators.map((item) => ({
    value: item.address,
    label: item.label,
    detail: `${compactAddress(item.address, 8, 6)} · ${t.yourStake} ${
      props.accountReady ? `${formatSafe(item.userStake)} SAFE` : "--"
    }`,
  }))
  return (
    <div className="content-grid enter">
      <DecisionMetricsStrip t={t} metrics={props.decisionMetrics} />
      <div className="main-stack">
        <section className="panel primary-actions-panel">
          <div className="action-grid">
            <ActionButton
              active={props.action === "stake"}
              icon={<Upload />}
              title={t.txStakeTitle}
              subtitle={t.stakeSub}
              disabled={formControlsDisabled}
              onClick={() => props.selectAction("stake")}
            />
            <ActionButton
              active={props.action === "unstake"}
              icon={<ArrowDownToLine />}
              title={t.txUnstakeTitle}
              subtitle={t.unstakeSub}
              disabled={formControlsDisabled}
              onClick={() => props.selectAction("unstake")}
            />
            <ActionButton
              active={props.action === "claim-rewards"}
              icon={<Gift />}
              title={t.claimRewards}
              subtitle={t.claimRewardsSub}
              disabled={formControlsDisabled}
              onClick={() => props.selectAction("claim-rewards")}
            />
          </div>
          {(props.action === "stake" || props.action === "unstake") && (
            <div className="form-row slide-down">
              <label>
                {props.action === "stake" ? t.stakeAction : t.unstakeAction} {t.amount}
                <div className="amount-input-wrap">
                  <input
                    inputMode="decimal"
                    value={props.amount}
                    placeholder="0.00"
                    disabled={formControlsDisabled}
                    onChange={(event) => props.setAmount(event.target.value)}
                  />
                  <span>SAFE</span>
                  <button
                    type="button"
                    disabled={!props.accountReady || formControlsDisabled}
                    onClick={() =>
                      props.setAmount(
                        formatSafeInput(
                          props.action === "stake" ? props.summary.safeBalance : props.selectedValidator.userStake,
                        ),
                      )
                    }
                  >
                    MAX
                  </button>
                </div>
                {!props.accountReady && <small className="planning-mode-hint">{t.planningModeHint}</small>}
              </label>
              <div className="field-group">
                <span className="field-label">{t.validator}</span>
                <CustomSelect
                  disabled={!hasValidators || formControlsDisabled}
                  label={t.validator}
                  value={props.validator}
                  onChange={(value) => props.setValidator(value as Address)}
                  options={validatorOptions}
                />
              </div>
              <button
                type="button"
                className="primary-button"
                disabled={formControlsDisabled}
                onClick={() =>
                  void (props.accountReady
                    ? props.executeAction(props.action, { amount: props.amount, validator: props.validator })
                    : props.onConnect())
                }
              >
                {stakeOrUnstakeLoading ? (
                  <ButtonBusyLabel>{busyActionLabel}</ButtonBusyLabel>
                ) : !props.accountReady ? (
                  accountActionLabel
                ) : props.action === "stake" ? (
                  t.stakeAction
                ) : (
                  t.unstakeAction
                )}
              </button>
              <TransactionPreview t={t} preview={props.actionPreview} />
              <ChainProgressPanel t={t} txPlan={props.txPlan} txProgress={props.txProgress} />
              {!props.txProgress && actionExecution && (
                <ExecutionSummaryCard
                  summary={actionExecution}
                  t={t}
                  onContinueSafeProposal={props.onContinueSafeProposal}
                  onCopySafeTxHash={props.onCopySafeTxHash}
                  onExportSafePayload={props.onExportSafePayload}
                />
              )}
            </div>
          )}
          {props.action === "claim-rewards" && (
            <div className="form-row slide-down">
              <div className="field-group restake-target-field">
                <span className="field-label">{t.restakeTargetValidator}</span>
                <CustomSelect
                  disabled={!hasValidators || formControlsDisabled}
                  label={t.restakeTargetValidator}
                  value={props.validator}
                  onChange={(value) => props.setValidator(value as Address)}
                  options={validatorOptions}
                />
              </div>
              <div className="claim-action-row">
                <button
                  type="button"
                  className="primary-button"
                  disabled={formControlsDisabled}
                  onClick={() =>
                    void (props.accountReady
                      ? props.executeAction("claim-rewards", { amount: props.amount, validator: props.validator })
                      : props.onConnect())
                  }
                >
                  {claimRewardsLoading ? (
                    <ButtonBusyLabel>{busyActionLabel}</ButtonBusyLabel>
                  ) : !props.accountReady ? (
                    accountActionLabel
                  ) : (
                    t.claimToWallet
                  )}
                </button>
                <button
                  type="button"
                  className="feature-button"
                  disabled={formControlsDisabled}
                  onClick={() =>
                    void (props.accountReady ? props.executeClaimRewardsAndStake(props.validator) : props.onConnect())
                  }
                >
                  <Upload size={15} aria-hidden="true" />
                  {claimAndStakeLoading ? (
                    <ButtonBusyLabel>{busyActionLabel}</ButtonBusyLabel>
                  ) : !props.accountReady ? (
                    accountActionLabel
                  ) : (
                    t.claimAndRestake
                  )}
                </button>
              </div>
              <TransactionPreview t={t} title={t.claimToWallet} preview={props.actionPreview} />
              <TransactionPreview t={t} title={t.claimAndRestake} preview={props.restakePreview} />
              <p className="restake-preview-note">{t.restakePreview}</p>
              <ChainProgressPanel t={t} txPlan={props.txPlan} txProgress={props.txProgress} />
              {!props.txProgress && actionExecution && (
                <ExecutionSummaryCard
                  summary={actionExecution}
                  t={t}
                  onContinueSafeProposal={props.onContinueSafeProposal}
                  onCopySafeTxHash={props.onCopySafeTxHash}
                  onExportSafePayload={props.onExportSafePayload}
                />
              )}
            </div>
          )}
        </section>
      </div>

      <aside className="side-stack">
        <StakingOverview
          t={t}
          accountReady={props.accountReady}
          summary={props.summary}
          safePriceUsd={props.safePriceUsd}
        />
        <ValidatorParticipationPanel
          t={t}
          accountReady={props.accountReady}
          summary={props.summary}
          validators={props.validators}
        />
      </aside>
    </div>
  )
}

function DecisionMetricsStrip({ metrics, t }: { metrics: DecisionMetrics; t: MessageBundle }) {
  return (
    <section className="decision-strip" aria-label={t.publicProtocolData}>
      <div className="decision-tvl">
        <span className="decision-icon">
          <TrendingUp size={28} />
        </span>
        <span>{t.protocolTvl}</span>
        <strong>{metrics.protocolTvlUsd}</strong>
        <small>{formatSafe(metrics.validatorPoolTotal, 0)} SAFE</small>
      </div>
      <div className="decision-delay">
        <span className="decision-icon">
          <Clock3 size={28} />
        </span>
        <span>{t.unstakeDelay}</span>
        <strong>{formatDelayLabel(metrics.withdrawDelay, t)}</strong>
        <small>{formatApproxEpochPeriods(metrics.withdrawDelay, t)}</small>
      </div>
      <div className="decision-count">
        <span className="decision-icon">
          <Users size={28} />
        </span>
        <span>{t.activeValidatorsMetric}</span>
        <strong>{metrics.activeValidatorCount}</strong>
        <small>{t.validators}</small>
      </div>
    </section>
  )
}

function formatApproxEpochPeriods(seconds: bigint, t: MessageBundle) {
  const periods = Math.max(1, Math.round(Number(seconds) / 86400))
  return `~${periods} ${periods === 1 ? t.epochPeriod : t.epochPeriods}`
}

function TransactionPreview({ preview, t, title }: { preview: ActionPreview; t: MessageBundle; title?: string }) {
  return (
    <section
      className="transaction-preview"
      aria-label={title ? `${t.transactionPreview}: ${title}` : t.transactionPreview}
    >
      <div className="transaction-preview-header">
        <strong>{title ?? t.transactionPreview}</strong>
        <span>{title ? t.transactionPreview : t.walletConfirmationHint}</span>
      </div>
      {title && <p className="transaction-preview-note">{t.walletConfirmationHint}</p>}
      <div className="transaction-preview-grid">
        <PreviewItem label={t.estimatedGas} value={preview.gas} />
        <PreviewItem label={t.validatorCommission} value={preview.validatorCommission} />
        <PreviewItem label={t.authorizationAmount} value={preview.authorization} />
        <PreviewItem label={t.expectedOutcome} value={preview.expectedOutcome} />
        <PreviewItem label={t.slashingRisk} value={preview.risk} />
        <PreviewItem label={t.protocol} value={t.noProtocolFee} />
      </div>
      <ol className="transaction-steps" aria-label={t.transactionSteps}>
        {preview.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </section>
  )
}

function PreviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function ChainProgressPanel({
  t,
  txPlan,
  txProgress,
}: {
  t: MessageBundle
  txPlan: TxPlan | null
  txProgress: string
}) {
  if (!txProgress) return null
  const stageLabel = chainActionBusyLabel(t, txProgress)
  const txLabels = txPlan?.txs.map((tx) => translateTxLabel(tx.label, t)) ?? []
  const labels = txLabels.length > 0 ? txLabels : [stageLabel]
  const labelCounts = new Map<string, number>()
  const steps = labels.map((label) => {
    const count = (labelCounts.get(label) ?? 0) + 1
    labelCounts.set(label, count)
    return { key: `${label}-${count}`, label }
  })
  const statuses = chainTxStepStatuses(labels, txProgress, true)
  const progressPercent = progressPercentFromStatuses(statuses)
  return (
    <section className="chain-progress-panel" aria-label={t.transactionProgress} aria-live="polite">
      <div className="chain-progress-heading">
        <span>
          <strong>{t.transactionProgress}</strong>
          <small>{stageLabel}</small>
        </span>
        <em>{`${Math.round(progressPercent)}%`}</em>
      </div>
      <div className="chain-progress-meter" aria-hidden="true">
        <span style={{ width: `${progressPercent}%` }} />
      </div>
      <div className="chain-progress-steps">
        {steps.map((step, index) => (
          <ChainProgressStep key={step.key} label={step.label} status={statuses[index] ?? "pending"} />
        ))}
      </div>
      <p>{txProgress}</p>
    </section>
  )
}

function ChainProgressStep({ label, status }: { label: string; status: ChainTxStepStatus }) {
  return (
    <span className={`chain-progress-step ${status}`}>
      <span className="chain-progress-step-icon" aria-hidden="true">
        {status === "done" ? (
          <CheckCircle2 size={13} />
        ) : status === "current" ? (
          <span className="chain-progress-spinner" />
        ) : null}
      </span>
      <span>{label}</span>
    </span>
  )
}

function progressPercentFromStatuses(statuses: ChainTxStepStatus[]) {
  if (statuses.length === 0) return 0
  const score = statuses.reduce((total, status) => total + (status === "done" ? 1 : status === "current" ? 0.5 : 0), 0)
  return Math.min(96, Math.max(10, (score / statuses.length) * 100))
}

export function ValidatorTable(props: {
  t: MessageBundle
  validators: ValidatorInfo[]
  totalStaked: bigint
  accountReady: boolean
  emptyMessage?: string
  isLoading?: boolean
  safePriceUsd: number | null
  setModal: (modal: Modal) => void
  openExplorer: (address: Address) => void
  onStake: (address: Address) => void
  onUnstake: (address: Address) => void
}) {
  const { t } = props
  return (
    <div className="validator-list">
      <div className="validator-header">
        <span>{t.validator}</span>
        <span>{t.commission}</span>
        <span>{t.participation14d}</span>
        <span>{t.totalSafeStaked}</span>
        <span>{t.yourStake}</span>
        <span>{t.status}</span>
        <span>{t.actions}</span>
      </div>
      {props.isLoading &&
        validatorSkeletonKeys.map((key) => (
          <div className="validator-row validator-row-skeleton" key={key}>
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        ))}
      {props.validators.map((item) => {
        return (
          <article className="validator-row" key={item.address}>
            <div className="validator-identity">
              <strong>{item.label}</strong>
              <span className="validator-address-inline">
                <span>{compactAddress(item.address, 6, 4)}</span>
                <ExternalActionButton
                  className="validator-inline-action"
                  label={`${t.openExplorer} ${item.label}`}
                  onOpen={() => props.openExplorer(item.address)}
                  size={13}
                />
              </span>
            </div>
            <ValidatorStat label={t.commission} tooltip={t.commissionTooltip} value={`${item.commission}%`} />
            <ValidatorStat
              label={t.participation14d}
              tooltip={t.participationTooltip}
              value={`${item.participationRate.toFixed(2)}%`}
              detail={`${formatSafe(item.totalStake)} SAFE`}
              progress={<Progress value={item.participationRate} variant="green" />}
            />
            <ValidatorStat
              label={t.totalSafeStaked}
              tooltip={t.totalSafeStakedTooltip}
              value={formatSafe(item.totalStake)}
            />
            <ValidatorStat
              label={t.yourStake}
              tooltip={t.yourStakeTooltip}
              value={props.accountReady ? formatSafe(item.userStake) : "--"}
            />
            <StatusBadge status={item.status} t={t} />
            <div className="validator-row-actions">
              <button
                className="primary-button"
                type="button"
                disabled={item.status !== "active"}
                onClick={() => props.onStake(item.address)}
              >
                {t.prepareStakeAction}
              </button>
              <Tooltip
                className="validator-action-tooltip"
                label={props.accountReady ? t.yourStakeTooltip : t.connectWalletHint}
              >
                <button
                  className="secondary-action-button"
                  type="button"
                  disabled={!props.accountReady || item.userStake <= 0n}
                  onClick={() => props.onUnstake(item.address)}
                >
                  {t.prepareUnstakeAction}
                </button>
              </Tooltip>
              <Tooltip label={t.more}>
                <button
                  className="row-arrow"
                  type="button"
                  aria-label={t.more}
                  onClick={() => props.setModal({ type: "validator", validator: item })}
                >
                  ›
                </button>
              </Tooltip>
            </div>
          </article>
        )
      })}
      {!props.isLoading && props.validators.length === 0 && (
        <div className="empty-state validator-empty">
          <Database size={24} />
          <p>{props.emptyMessage ?? t.validatorInfoFailed}</p>
        </div>
      )}
    </div>
  )
}

export function ValidatorToolbar(props: {
  activeOnly: boolean
  isLoading: boolean
  query: string
  setActiveOnly: (value: boolean) => void
  setQuery: (value: string) => void
  setSort: (value: ValidatorSort) => void
  shownCount: number
  sort: ValidatorSort
  t: MessageBundle
  totalCount: number
  updatedBlock: bigint | null
  validatorLoadError: string
}) {
  const sortOptions: Array<{ value: ValidatorSort; label: string }> = [
    { value: "stake", label: props.t.sortStake },
    { value: "participation", label: props.t.sortParticipation },
    { value: "commission", label: props.t.sortCommission },
    { value: "name", label: props.t.sortName },
    { value: "yourStake", label: props.t.sortYourStake },
  ]
  return (
    <div className="validator-toolbar">
      <div className="validator-search">
        <input
          aria-label={props.t.searchValidators}
          placeholder={props.t.searchValidators}
          value={props.query}
          onChange={(event) => props.setQuery(event.target.value)}
        />
      </div>
      <CustomSelect
        label={props.t.sortBy}
        value={props.sort}
        onChange={(value) => props.setSort(value as ValidatorSort)}
        options={sortOptions}
      />
      <button
        className={`segmented-toggle ${props.activeOnly ? "active" : ""}`}
        type="button"
        onClick={() => props.setActiveOnly(!props.activeOnly)}
      >
        {props.activeOnly ? props.t.activeOnly : props.t.allValidators}
      </button>
      <div className={`validator-data-note ${props.validatorLoadError ? "warning" : ""}`}>
        <strong>
          {props.isLoading
            ? props.t.loadingValidators
            : `${props.shownCount}/${props.totalCount} ${props.t.validatorsShown}`}
        </strong>
        <small>
          {props.validatorLoadError
            ? props.validatorLoadError
            : props.updatedBlock
              ? `${props.t.dataUpdated}: ${props.t.block} ${props.updatedBlock}`
              : props.t.liveData}
        </small>
      </div>
    </div>
  )
}

function ValidatorStat(props: {
  label: string
  value: string
  detail?: string
  progress?: ReactNode
  tooltip?: string
}) {
  return (
    <div className="validator-stat">
      <small>
        {props.label}
        {props.tooltip && (
          <Tooltip label={props.tooltip}>
            <Info size={15} />
          </Tooltip>
        )}
      </small>
      <strong>{props.value}</strong>
      {props.detail && <em>{props.detail}</em>}
      {props.progress}
    </div>
  )
}

function StakingOverview({
  t,
  accountReady,
  summary,
  safePriceUsd,
}: {
  t: MessageBundle
  accountReady: boolean
  summary: AccountSummary
  safePriceUsd: number | null
}) {
  const totalBalance = summary.safeBalance + summary.totalStaked
  const stakedShare = totalBalance > 0n ? Number((summary.totalStaked * 10000n) / totalBalance) / 100 : 0
  const safeBalanceShare = Math.max(0, 100 - stakedShare)
  const formattedTotal = accountReady ? formatSafe(totalBalance) : "--"

  return (
    <section className="panel overview-panel">
      <h2>{t.stakingOverview}</h2>
      <div className="overview-layout">
        <div className="overview-copy">
          <small>
            {t.safeBalance} + {t.totalStaked}
          </small>
          <strong>{formattedTotal} SAFE</strong>
          <em>{accountReady ? formatUsdFromSafe(totalBalance, safePriceUsd) : t.connectWallet}</em>
          <div className="overview-legend">
            <span>
              <i className="staked-dot" />
              {t.totalStaked}{" "}
              <b>{accountReady ? `${formatSafe(summary.totalStaked)} SAFE (${stakedShare.toFixed(1)}%)` : "--"}</b>
            </span>
            <span>
              <i />
              {t.safeBalance}{" "}
              <b>{accountReady ? `${formatSafe(summary.safeBalance)} SAFE (${safeBalanceShare.toFixed(1)}%)` : "--"}</b>
            </span>
          </div>
        </div>
        <div
          className={`donut ${accountReady ? "" : "empty"}`}
          style={{ "--staked": `${accountReady ? stakedShare : 0}%` } as CSSProperties}
        >
          <div>
            <small>{t.totalStaked}</small>
            <strong>{accountReady ? `${stakedShare.toFixed(2)}%` : "--"}</strong>
            <em>{accountReady ? `${formatSafe(summary.totalStaked)} SAFE` : t.notConnected}</em>
          </div>
        </div>
      </div>
    </section>
  )
}

function compareBigintDesc(a: bigint, b: bigint) {
  if (a === b) return 0
  return a > b ? -1 : 1
}

function ValidatorParticipationPanel({
  accountReady,
  summary,
  t,
  validators,
}: {
  accountReady: boolean
  summary: AccountSummary
  t: MessageBundle
  validators: ValidatorInfo[]
}) {
  const positions = validators
    .filter((item) => item.userStake > 0n)
    .sort((a, b) => compareBigintDesc(a.userStake, b.userStake))
    .slice(0, 4)

  return (
    <section className="panel positions-panel">
      <div className="panel-title">
        <div>
          <h2>
            {t.validatorParticipation}
            <Tooltip label={t.validatorParticipationSummaryTooltip}>
              <Info size={15} />
            </Tooltip>
          </h2>
        </div>
        <strong>{accountReady ? `${positions.length} ${t.validators}` : "--"}</strong>
      </div>
      <div className="positions-list">
        {accountReady && positions.length > 0 ? (
          positions.map((validator) => {
            const validatorShare =
              summary.totalStaked > 0n ? Number((validator.userStake * 10000n) / summary.totalStaked) / 100 : 0
            return (
              <div className="position-row" key={validator.address}>
                <span className="validator-avatar">
                  <ShieldCheck size={18} />
                </span>
                <span className="position-main">
                  <strong>{validator.label}</strong>
                  <small>{compactAddress(validator.address, 8, 6)}</small>
                </span>
                <span className="position-amount">
                  <b>{formatSafe(validator.userStake)} SAFE</b>
                  <small>{validatorShare.toFixed(2)}%</small>
                </span>
                <Progress value={validatorShare} variant="green" />
              </div>
            )
          })
        ) : (
          <p className="positions-empty">{accountReady ? t.positionsHistoryEmpty : t.connectWalletHint}</p>
        )}
      </div>
    </section>
  )
}

function formatWithdrawalEta(claimableAt: bigint, t: MessageBundle) {
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (claimableAt <= now) return t.claimable
  return formatDelayLabel(claimableAt - now, t)
}

export function WithdrawalsView(props: {
  executeAction: (action?: Action, options?: ExecuteActionOptions) => Promise<void>
  isSubmitting: boolean
  liveSnapshot: AccountSnapshot | null
  submittingAction: SubmittingAction
  t: MessageBundle
  summary: AccountSummary
  txPlan: TxPlan | null
  txProgress: string
}) {
  const { t } = props
  const isClaimingWithdrawal = props.submittingAction === "claim-withdrawal"
  const busyActionLabel = chainActionBusyLabel(t, props.txProgress)
  const pendingRows = props.liveSnapshot?.pendingWithdrawals ?? []
  return (
    <FullPanel className="withdrawals-panel">
      <div className="split-cards">
        <InfoCard
          icon={<Clock3 />}
          title={t.pendingWithdrawals}
          value={`${formatSafe(props.summary.pendingWithdrawals)} SAFE`}
        />
        <InfoCard
          icon={<ArrowDownToLine />}
          title={t.claimableWithdrawals}
          value={`${formatSafe(props.summary.claimableWithdrawals)} SAFE`}
        />
        <InfoCard
          icon={<ShieldCheck />}
          title={t.withdrawalDelay}
          value={formatDelayLabel(props.summary.withdrawDelay, t)}
        />
      </div>
      <section className="withdrawal-timeline" aria-label={t.withdrawalTimeline}>
        <h3>{t.withdrawalTimeline}</h3>
        <div className="timeline-steps">
          <span>{t.submitted}</span>
          <span>{t.unlocking}</span>
          <span>{t.claimable}</span>
          <span>{t.claimed}</span>
        </div>
        <div className="withdrawal-queue">
          {pendingRows.length ? (
            pendingRows.map((item) => (
              <div className="withdrawal-row" key={`${item.amount}-${item.claimableAt}`}>
                <span>
                  <strong>{formatSafe(item.amount)} SAFE</strong>
                  <small>{t.withdrawalEta}</small>
                </span>
                <time>{formatWithdrawalEta(item.claimableAt, t)}</time>
              </div>
            ))
          ) : (
            <p>{t.noPendingWithdrawalRows}</p>
          )}
        </div>
      </section>
      <div className={`withdrawal-action-row ${props.txProgress ? "has-progress" : ""}`}>
        <div className="withdrawal-progress-slot">
          <ChainProgressPanel t={t} txPlan={props.txPlan} txProgress={props.txProgress} />
        </div>
        <div className="withdrawal-action-slot">
          <button
            type="button"
            className="primary-button"
            disabled={props.isSubmitting}
            onClick={() => {
              void props.executeAction("claim-withdrawal")
            }}
          >
            {isClaimingWithdrawal ? <ButtonBusyLabel>{busyActionLabel}</ButtonBusyLabel> : t.claimWithdrawals}
          </button>
        </div>
      </div>
    </FullPanel>
  )
}

export function RewardsView(props: {
  actionPreview: ActionPreview
  dataStatus: DataStatus
  executionState: ActionExecutionSummary | null
  executeClaimRewardsAndStake: (validator: Address) => Promise<void>
  executeAction: (action?: Action, options?: ExecuteActionOptions) => Promise<void>
  isSubmitting: boolean
  onContinueSafeProposal: () => void
  onCopySafeTxHash: (safeTxHash: string) => void
  onExportSafePayload: () => void
  restakePreview: ActionPreview
  selectedValidator: ValidatorInfo
  setValidator: (address: Address) => void
  submittingAction: SubmittingAction
  t: MessageBundle
  summary: AccountSummary
  txPlan: TxPlan | null
  txProgress: string
  validators: ValidatorInfo[]
}) {
  const { t } = props
  const hasValidators = props.validators.length > 0
  const isClaimingRewards = props.submittingAction === "claim-rewards"
  const isClaimingAndRestaking = props.submittingAction === "claim-rewards-and-stake"
  const showClaimRewardsProgress = isClaimingRewards && Boolean(props.txProgress)
  const showClaimAndRestakeProgress = isClaimingAndRestaking && Boolean(props.txProgress)
  const busyActionLabel = chainActionBusyLabel(t, props.txProgress)
  const rewardExecution = props.executionState?.action === "claim-rewards" ? props.executionState : null
  const restakeExecution = props.executionState?.action === "claim-rewards-and-stake" ? props.executionState : null
  const validatorOptions = props.validators.map((item) => ({
    value: item.address,
    label: item.label,
    detail: `${compactAddress(item.address, 8, 6)} · ${t.yourStake} ${formatSafe(item.userStake)} SAFE`,
  }))
  return (
    <FullPanel className="rewards-panel">
      <div className="split-cards">
        <InfoCard
          icon={<Gift />}
          title={t.claimableRewards}
          value={`${formatSafe(props.summary.claimableRewards)} SAFE`}
        />
        <InfoCard icon={<Database />} title={t.rewardsProofSource} value={props.dataStatus.rewardsSource} />
        <InfoCard
          icon={<CheckCircle2 />}
          title={t.merkleRoot}
          value={merkleLabel(t, props.dataStatus.merkleRootMatched)}
        />
      </div>
      <div className="reward-action-grid">
        <section className={`reward-action-card ${showClaimRewardsProgress ? "active" : ""}`}>
          <div className="reward-action-heading">
            <span className="reward-action-icon">
              <Gift size={17} />
            </span>
            <div>
              <h3>{t.claimToWallet}</h3>
              <p>{t.walletConfirmationHint}</p>
            </div>
          </div>
          <div className="field-group compact">
            <span className="field-label">{t.wallet}</span>
            <div className="reward-action-target">
              <strong>{t.claimToWallet}</strong>
              <small>{t.walletConfirmationHint}</small>
            </div>
          </div>
          <TransactionPreview t={t} preview={props.actionPreview} />
          <button
            type="button"
            className="primary-button"
            disabled={props.isSubmitting}
            onClick={() => {
              void props.executeAction("claim-rewards", { validator: props.selectedValidator.address })
            }}
          >
            {isClaimingRewards ? <ButtonBusyLabel>{busyActionLabel}</ButtonBusyLabel> : t.claimToWallet}
          </button>
          {!showClaimRewardsProgress && rewardExecution && (
            <ExecutionSummaryCard
              summary={rewardExecution}
              t={t}
              onContinueSafeProposal={props.onContinueSafeProposal}
              onCopySafeTxHash={props.onCopySafeTxHash}
              onExportSafePayload={props.onExportSafePayload}
            />
          )}
          {showClaimRewardsProgress && <ChainProgressPanel t={t} txPlan={props.txPlan} txProgress={props.txProgress} />}
        </section>

        <section className={`reward-action-card restake ${showClaimAndRestakeProgress ? "active" : ""}`}>
          <div className="reward-action-heading">
            <span className="reward-action-icon">
              <Upload size={17} />
            </span>
            <div>
              <h3>{t.claimAndRestake}</h3>
              <p>{t.restakePreview}</p>
            </div>
          </div>
          <div className="field-group compact">
            <span className="field-label">{t.restakeTargetValidator}</span>
            <CustomSelect
              disabled={!hasValidators || props.isSubmitting}
              label={t.restakeTargetValidator}
              value={props.selectedValidator.address}
              onChange={(value) => props.setValidator(value as Address)}
              options={validatorOptions}
            />
          </div>
          <TransactionPreview t={t} preview={props.restakePreview} />
          <button
            type="button"
            className="feature-button"
            disabled={props.isSubmitting}
            onClick={() => {
              void props.executeClaimRewardsAndStake(props.selectedValidator.address)
            }}
          >
            <span aria-hidden="true">✨</span>
            {isClaimingAndRestaking ? <ButtonBusyLabel>{busyActionLabel}</ButtonBusyLabel> : t.claimAndRestake}
          </button>
          {!showClaimAndRestakeProgress && restakeExecution && (
            <ExecutionSummaryCard
              summary={restakeExecution}
              t={t}
              onContinueSafeProposal={props.onContinueSafeProposal}
              onCopySafeTxHash={props.onCopySafeTxHash}
              onExportSafePayload={props.onExportSafePayload}
            />
          )}
          {showClaimAndRestakeProgress && (
            <ChainProgressPanel t={t} txPlan={props.txPlan} txProgress={props.txProgress} />
          )}
        </section>
      </div>
    </FullPanel>
  )
}

export function DocsView({
  copyText,
  customRpcMessage,
  customRpcSavedUrl,
  customRpcStatus,
  customRpcUrl,
  layoutDensity,
  onClearCustomRpc,
  onClearUserSafeApiKey,
  onClearUserLlm,
  onCustomRpcChange,
  onLayoutDensityChange,
  onSaveCustomRpc,
  onSaveUserSafeApiKey,
  onSaveUserLlm,
  onUserSafeApiKeyChange,
  onUserLlmChange,
  openExplorer,
  t,
  userSafeApiKeyDraft,
  userSafeApiMessage,
  userSafeApiSaved,
  userSafeApiStatus,
  userLlmDraft,
  userLlmMessage,
  userLlmSaved,
  userLlmStatus,
}: {
  copyText: (value: string) => Promise<boolean>
  customRpcMessage: string
  customRpcSavedUrl: string
  customRpcStatus: CustomRpcStatus
  customRpcUrl: string
  layoutDensity: LayoutDensity
  onClearCustomRpc: () => void
  onClearUserSafeApiKey: () => void
  onClearUserLlm: () => void
  onCustomRpcChange: (value: string) => void
  onLayoutDensityChange: (value: LayoutDensity) => void
  onSaveCustomRpc: () => void
  onSaveUserSafeApiKey: () => Promise<void> | void
  onSaveUserLlm: () => Promise<void> | void
  onUserSafeApiKeyChange: (value: string) => void
  onUserLlmChange: (field: keyof UserLlmDraft, value: string) => void
  openExplorer: (address: Address) => void
  t: MessageBundle
  userSafeApiKeyDraft: string
  userSafeApiMessage: string
  userSafeApiSaved: boolean
  userSafeApiStatus: UserSafeApiStatus
  userLlmDraft: UserLlmDraft
  userLlmMessage: string
  userLlmSaved: boolean
  userLlmStatus: UserLlmStatus
}) {
  const contracts = [
    { label: t.safeTokenContract, address: CONTRACTS.safeToken },
    { label: t.stakingContractShort, address: CONTRACTS.staking },
    { label: t.rewardsContractShort, address: CONTRACTS.merkleDrop },
  ]
  const customRpcStatusText =
    customRpcMessage ||
    (customRpcStatus === "valid"
      ? t.customRpcActive
      : customRpcStatus === "checking"
        ? t.customRpcChecking
        : customRpcStatus === "invalid"
          ? t.customRpcFailed
          : "")
  const userLlmStatusText =
    userLlmMessage ||
    (userLlmStatus === "valid"
      ? t.userLlmActive
      : userLlmStatus === "checking"
        ? t.userLlmChecking
        : userLlmStatus === "invalid"
          ? t.userLlmFailed
          : "")
  const userSafeApiStatusText =
    userSafeApiMessage ||
    (userSafeApiStatus === "configured"
      ? t.userSafeApiActive
      : userSafeApiStatus === "invalid"
        ? t.userSafeApiFailed
        : "")
  const layoutDensityLabels: Record<LayoutDensity, string> = {
    comfortable: t.layoutDensityComfortable,
    compact: t.layoutDensityCompact,
    medium: t.layoutDensityMedium,
  }
  return (
    <FullPanel>
      <div className="docs-grid">
        <InfoCard icon={<ShieldCheck />} title={t.docsNonCustodial} value={t.docsNonCustodialValue} />
        <InfoCard icon={<TerminalSquare />} title={t.docsCliParity} value={t.docsCliParityValue} />
        <InfoCard icon={<Database />} title={t.docsReleaseManifest} value={t.docsReleaseManifestValue} />
      </div>
      <section className="trust-panel">
        <div className="trust-panel-heading">
          <div>
            <h3>{t.trustVerification}</h3>
            <p>{t.trustVerificationSubtitle}</p>
          </div>
          <span>{t.chainIdentity}</span>
        </div>
        <div className="trust-grid">
          {contracts.map((item) => (
            <div className="trust-row" key={item.label}>
              <span>
                <small>{item.label}</small>
                <strong>{compactAddress(item.address, 10, 8)}</strong>
              </span>
              <div>
                <CopyActionButton
                  className="code-icon-button"
                  copiedLabel={t.copied}
                  label={`${t.copy} ${item.label}`}
                  onCopy={copyText}
                  value={item.address}
                />
                <ExternalActionButton
                  className="code-icon-button"
                  label={`${t.openExplorer} ${item.label}`}
                  onOpen={() => openExplorer(item.address)}
                />
              </div>
            </div>
          ))}
          <div className="trust-row">
            <span>
              <small>{t.frontendIntegrity}</small>
              <strong>{t.frontendIntegrityValue}</strong>
            </span>
            <div>
              <ExternalActionButton
                className="code-button action-text-button"
                href={`${EXPLORER_BASE_URL}/address/${CONTRACTS.staking}`}
                label="Etherscan"
              >
                Etherscan
              </ExternalActionButton>
            </div>
          </div>
          <div className="trust-row">
            <span>
              <small>{t.auditStatus}</small>
              <strong>{t.auditStatusValue}</strong>
            </span>
          </div>
          <div className="trust-row">
            <span>
              <small>{t.sourceCode}</small>
              <strong>{t.githubRepository}</strong>
            </span>
            <div>
              <ExternalActionButton
                className="code-button action-text-button"
                href={sourceRepositoryUrl}
                label="GitHub"
              >
                GitHub
              </ExternalActionButton>
            </div>
          </div>
        </div>
      </section>
      <section className="appearance-settings-panel" aria-labelledby="appearance-settings-title">
        <div className="rpc-settings-heading appearance-settings-heading">
          <div>
            <h3 id="appearance-settings-title">{t.appearanceSettingsTitle}</h3>
            <p>{t.appearanceSettingsDescription}</p>
          </div>
        </div>
        <fieldset className="appearance-settings-row">
          {/* <legend>{t.layoutDensityLabel}</legend> */}
          <div className="density-segmented-control">
            {layoutDensityOptions.map((option) => (
              <button
                type="button"
                className={`density-option${layoutDensity === option ? " active" : ""}`}
                key={option}
                aria-pressed={layoutDensity === option}
                onClick={() => onLayoutDensityChange(option)}
              >
                {layoutDensityLabels[option]}
              </button>
            ))}
          </div>
        </fieldset>
      </section>
      <section className="rpc-settings-panel" aria-labelledby="custom-rpc-title">
        <div className="rpc-settings-heading">
          <div>
            <h3 id="custom-rpc-title">{t.customRpcTitle}</h3>
            <p>{t.customRpcDescription}</p>
          </div>
          {customRpcSavedUrl ? (
            <span className="rpc-settings-current" title={customRpcSavedUrl}>
              {t.customRpcCurrent}
            </span>
          ) : null}
        </div>
        <form
          className="rpc-settings-form"
          onSubmit={(event) => {
            event.preventDefault()
            onSaveCustomRpc()
          }}
        >
          <label>
            <span>{t.customRpcPlaceholder}</span>
            <input
              type="text"
              inputMode="url"
              value={customRpcUrl}
              placeholder="https://..."
              disabled={customRpcStatus === "checking"}
              onChange={(event) => onCustomRpcChange(event.target.value)}
            />
          </label>
          <div className="rpc-settings-actions">
            <button type="submit" className="primary-button" disabled={customRpcStatus === "checking"}>
              {customRpcStatus === "checking" ? t.customRpcChecking : t.customRpcSave}
            </button>
            <button
              type="button"
              className="code-button"
              disabled={customRpcStatus === "checking"}
              onClick={onClearCustomRpc}
            >
              {t.customRpcClear}
            </button>
          </div>
        </form>
        <div className={`rpc-settings-status ${customRpcStatus}`} aria-live="polite">
          {customRpcStatusText ? <span>{customRpcStatusText}</span> : <span>{t.customRpcNotConfigured}</span>}
          {customRpcSavedUrl ? <strong title={customRpcSavedUrl}>{customRpcSavedUrl}</strong> : null}
        </div>
      </section>
      <section className="llm-settings-panel" aria-labelledby="user-safe-api-title">
        <div className="rpc-settings-heading">
          <div>
            <h3 id="user-safe-api-title">{t.userSafeApiTitle}</h3>
            <p>{t.userSafeApiDescription}</p>
          </div>
          {userSafeApiSaved ? <span className="rpc-settings-current">{t.userSafeApiCurrent}</span> : null}
        </div>
        <form
          className="rpc-settings-form llm-settings-form"
          onSubmit={(event) => {
            event.preventDefault()
            onSaveUserSafeApiKey()
          }}
        >
          <div className="llm-settings-fields">
            <label className="llm-field-secret llm-field-wide">
              <span>{t.userSafeApiKey}</span>
              <input
                type="password"
                value={userSafeApiKeyDraft}
                placeholder={userSafeApiSaved ? t.userSafeApiKeySaved : "Safe API Key"}
                autoComplete="off"
                onChange={(event) => onUserSafeApiKeyChange(event.target.value)}
              />
              <small>{t.userSafeApiSecurityNote}</small>
            </label>
          </div>
          <div className="llm-settings-footer">
            <div className={`rpc-settings-status llm-settings-status ${userSafeApiStatus}`} aria-live="polite">
              {userSafeApiStatusText ? <span>{userSafeApiStatusText}</span> : <span>{t.userSafeApiNotConfigured}</span>}
            </div>
            <div className="rpc-settings-actions llm-settings-actions">
              <button type="submit" className="primary-button">
                <ShieldCheck size={15} />
                {t.userSafeApiSave}
              </button>
              <button type="button" className="code-button" onClick={onClearUserSafeApiKey}>
                {t.userSafeApiClear}
              </button>
            </div>
          </div>
        </form>
      </section>
      <section className="llm-settings-panel" aria-labelledby="user-llm-title">
        <div className="rpc-settings-heading">
          <div>
            <h3 id="user-llm-title">{t.userLlmTitle}</h3>
            <p>{t.userLlmDescription}</p>
          </div>
          {userLlmSaved ? (
            <span className="rpc-settings-current" title={userLlmDraft.apiBase}>
              {t.userLlmCurrent}
            </span>
          ) : null}
        </div>
        <form
          className="rpc-settings-form llm-settings-form"
          onSubmit={(event) => {
            event.preventDefault()
            onSaveUserLlm()
          }}
        >
          <div className="llm-settings-fields">
            <label className="llm-field-wide">
              <span>{t.userLlmApiBase}</span>
              <input
                type="text"
                inputMode="url"
                value={userLlmDraft.apiBase}
                placeholder="https://api.openai.com/v1"
                disabled={userLlmStatus === "checking"}
                onChange={(event) => onUserLlmChange("apiBase", event.target.value)}
              />
            </label>
            <label className="llm-field-compact">
              <span>{t.userLlmMaxTokens}</span>
              <input
                type="number"
                inputMode="numeric"
                min={64}
                max={4000}
                step={1}
                value={userLlmDraft.maxTokens}
                disabled={userLlmStatus === "checking"}
                onChange={(event) => onUserLlmChange("maxTokens", event.target.value)}
              />
            </label>
            <label>
              <span>{t.userLlmModel}</span>
              <input
                type="text"
                value={userLlmDraft.model}
                placeholder="gpt-4.1-mini"
                disabled={userLlmStatus === "checking"}
                onChange={(event) => onUserLlmChange("model", event.target.value)}
              />
            </label>
            <label className="llm-field-secret">
              <span>{t.userLlmApiKey}</span>
              <input
                type="password"
                value={userLlmDraft.apiKey}
                placeholder={userLlmSaved ? t.userLlmKeySaved : "sk-..."}
                autoComplete="off"
                disabled={userLlmStatus === "checking"}
                onChange={(event) => onUserLlmChange("apiKey", event.target.value)}
              />
              <small>{t.userLlmSecurityNote}</small>
            </label>
          </div>
          <div className="llm-settings-footer">
            <div className={`rpc-settings-status llm-settings-status ${userLlmStatus}`} aria-live="polite">
              {userLlmStatusText ? <span>{userLlmStatusText}</span> : <span>{t.userLlmNotConfigured}</span>}
              {userLlmSaved ? <strong title={userLlmDraft.apiBase}>{userLlmDraft.model}</strong> : null}
            </div>
            <div className="rpc-settings-actions llm-settings-actions">
              <button type="submit" className="primary-button" disabled={userLlmStatus === "checking"}>
                <Bot size={15} />
                {userLlmStatus === "checking" ? t.userLlmChecking : t.userLlmSave}
              </button>
              <button
                type="button"
                className="code-button"
                disabled={userLlmStatus === "checking"}
                onClick={onClearUserLlm}
              >
                {t.userLlmClear}
              </button>
            </div>
          </div>
        </form>
      </section>
    </FullPanel>
  )
}
