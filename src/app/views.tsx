import {
  ArrowDownToLine,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Copy,
  Database,
  Gift,
  Info,
  ShieldCheck,
  TerminalSquare,
  Upload,
} from "lucide-react"
import type { CSSProperties, ReactNode } from "react"
import type { Address } from "viem"
import { compactAddress, formatSafe, formatUsdFromSafe, type TxPlan, type ValidatorInfo } from "../protocol"
import {
  formatDelayLabel,
  merkleLabel,
  safeParsedAmount,
  translateTxLabel,
  translateTxTitle,
  translateTxWarning,
} from "./formatters"
import type { MessageBundle } from "./i18n"
import type { AccountSummary, Action, DataStatus, Modal, NavItem } from "./types"
import { ActionButton, CustomSelect, FullPanel, InfoCard, KeyValue, Progress, StatusBadge, Tooltip } from "./ui"

type ValidatorSort = "stake" | "participation" | "commission" | "name" | "yourStake"
const validatorSkeletonKeys = [
  "validator-skeleton-1",
  "validator-skeleton-2",
  "validator-skeleton-3",
  "validator-skeleton-4",
]

export function DashboardView(props: {
  t: MessageBundle
  action: Action
  amount: string
  accountReady: boolean
  buildPlan: () => void
  connectedAccount: Address | null
  copyText: (value: string) => Promise<void>
  exportSafePayload: () => void
  isLoadingValidators: boolean
  isSubmitting: boolean
  modal: Modal
  onConnect: () => Promise<void>
  openExplorer: (address: Address) => void
  selectAction: (action: Action) => void
  selectedValidator: ValidatorInfo
  setActiveNav: (nav: NavItem) => void
  setAmount: (amount: string) => void
  setModal: (modal: Modal) => void
  setShowOnlyActive: (value: boolean) => void
  setValidator: (address: Address) => void
  showOnlyActive: boolean
  submitPlan: () => void
  summary: AccountSummary
  safePriceUsd: number | null
  txPlan: TxPlan | null
  txProgress: string
  validator: Address
  visibleValidators: ValidatorInfo[]
  validators: ValidatorInfo[]
  dataStatus: DataStatus
  stakingAllowance: bigint
  validatorPoolTotal: bigint
}) {
  const { t } = props
  const hasValidators = props.validators.length > 0
  const accountActionLabel = props.connectedAccount ? t.refreshLive : t.connectWallet
  return (
    <div className="content-grid enter">
      <div className="main-stack">
        <section className="panel primary-actions-panel">
          <div className="action-grid">
            <ActionButton
              active={props.action === "stake"}
              icon={<Upload />}
              title={t.txStakeTitle}
              subtitle={t.stakeSub}
              onClick={() => props.selectAction("stake")}
            />
            <ActionButton
              active={props.action === "unstake"}
              icon={<ArrowDownToLine />}
              title={t.txUnstakeTitle}
              subtitle={t.unstakeSub}
              onClick={() => props.selectAction("unstake")}
            />
            <ActionButton
              active={props.action === "claim-rewards"}
              icon={<Gift />}
              title={t.claimRewards}
              subtitle={t.claimRewardsSub}
              onClick={() => props.selectAction("claim-rewards")}
            />
          </div>
          {(props.action === "stake" || props.action === "unstake") && (
            <div className="form-row slide-down">
              <label>
                {props.action === "stake" ? t.stakeAction : t.unstakeAction} {t.amount}
                <div className="amount-input-wrap">
                  <input
                    disabled={!props.accountReady}
                    inputMode="decimal"
                    value={props.amount}
                    placeholder="0.00"
                    onChange={(event) => props.setAmount(event.target.value)}
                  />
                  <span>SAFE</span>
                  <button
                    type="button"
                    disabled={!props.accountReady}
                    onClick={() =>
                      props.setAmount(
                        formatSafe(
                          props.action === "stake" ? props.summary.safeBalance : props.selectedValidator.userStake,
                        ),
                      )
                    }
                  >
                    MAX
                  </button>
                </div>
              </label>
              <div className="field-group">
                <span className="field-label">{t.validator}</span>
                <CustomSelect
                  disabled={!hasValidators}
                  label={t.validator}
                  value={props.validator}
                  onChange={(value) => props.setValidator(value as Address)}
                  options={props.validators.map((item) => ({
                    value: item.address,
                    label: item.label,
                    detail: compactAddress(item.address, 8, 6),
                  }))}
                />
              </div>
              <button
                type="button"
                className="primary-button"
                onClick={() => void (props.accountReady ? props.buildPlan() : props.onConnect())}
              >
                {!props.accountReady ? accountActionLabel : props.action === "stake" ? t.stakeAction : t.unstakeAction}
              </button>
            </div>
          )}
          {props.action === "claim-rewards" && (
            <div className="form-row slide-down">
              <button
                type="button"
                className="primary-button"
                onClick={() => void (props.accountReady ? props.selectAction("claim-rewards") : props.onConnect())}
              >
                {!props.accountReady ? accountActionLabel : t.claimRewards}
              </button>
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
      </aside>

      <section className="panel distribution-panel validators-panel">
        <div className="panel-title">
          <h2>{t.stakingDistribution}</h2>
          <button type="button" className="soft-button" onClick={() => props.setActiveNav("validators")}>
            {t.viewAllValidators} <ArrowUpRight size={15} />
          </button>
        </div>
        <ValidatorTable
          t={t}
          validators={props.visibleValidators.slice(0, 3)}
          totalStaked={props.validatorPoolTotal}
          accountReady={props.dataStatus.isLive}
          emptyMessage={t.validatorInfoFailed}
          isLoading={props.isLoadingValidators}
          setModal={props.setModal}
          openExplorer={props.openExplorer}
          safePriceUsd={props.safePriceUsd}
          onStake={(nextValidator) => {
            props.setValidator(nextValidator)
            props.selectAction("stake")
          }}
          onUnstake={(nextValidator) => {
            props.setValidator(nextValidator)
            props.selectAction("unstake")
          }}
        />
      </section>
    </div>
  )
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
              <button type="button" onClick={() => props.openExplorer(item.address)}>
                {compactAddress(item.address, 6, 4)}
              </button>
            </div>
            <ValidatorStat label={t.commission} tooltip={t.commissionTooltip} value={`${item.commission}%`} />
            <ValidatorStat
              label={t.participation14d}
              tooltip={t.participationTooltip}
              value={`${item.participationRate.toFixed(2)}%`}
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
                {t.stakeAction}
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
                  {t.unstakeAction}
                </button>
              </Tooltip>
              <button
                className="row-arrow"
                type="button"
                title={t.more}
                onClick={() => props.setModal({ type: "validator", validator: item })}
              >
                ›
              </button>
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
          <small>{t.safeBalance}</small>
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
            <small>{t.safeBalance}</small>
            <strong>{formattedTotal}</strong>
            <span>SAFE</span>
            <em>{accountReady ? formatUsdFromSafe(totalBalance, safePriceUsd) : t.notConnected}</em>
          </div>
        </div>
      </div>
      <div className="overview-footer">
        <span>{t.participation}</span>
        <strong>95%+</strong>
      </div>
    </section>
  )
}

function TxPlanPanel(props: {
  action: Action
  amount: string
  t: MessageBundle
  account: Address | null
  copyText: (value: string) => Promise<void>
  exportSafePayload: () => void
  isSubmitting: boolean
  selectedValidator: ValidatorInfo
  submitPlan: () => void
  txPlan: TxPlan | null
  txProgress: string
  summary: AccountSummary
}) {
  const { t, txPlan } = props
  const canSubmit = txPlan?.simulation?.status === "passed" || txPlan?.simulation?.status === "partial"
  return (
    <section className="panel tx-plan-panel">
      <div className="panel-title">
        <h2>{t.reviewBeforeSigning}</h2>
      </div>
      {txPlan ? (
        <div className="tx-plan">
          <strong>{translateTxTitle(txPlan, t)}</strong>
          <small>
            {props.selectedValidator.label} / {props.account ? compactAddress(props.account) : props.t.noAccount}
          </small>
          <TxOutcomePreview
            action={props.action}
            amount={props.amount}
            selectedValidator={props.selectedValidator}
            summary={props.summary}
            t={t}
            txPlan={txPlan}
          />
          {txPlan.warnings.map((warning) => (
            <p className="warning" key={warning}>
              {translateTxWarning(warning, t)}
            </p>
          ))}
          {props.txProgress && (
            <p className="progress-note">
              <span className="spinner" />
              {props.t.confirmingTx}: {props.txProgress}
            </p>
          )}
          <details className="advanced-details">
            <summary>{t.advancedDetails}</summary>
            {txPlan.txs.map((tx, index) => (
              <div className="tx-step" key={`${tx.to}-${tx.data}`}>
                <span>{index + 1}</span>
                <div>
                  <strong>{translateTxLabel(tx.label, t)}</strong>
                  <small>{compactAddress(tx.to, 10, 6)}</small>
                </div>
                <button type="button" title={t.copy} onClick={() => props.copyText(tx.data)}>
                  <Copy size={14} />
                </button>
              </div>
            ))}
            <button type="button" className="soft-button full-width" onClick={props.exportSafePayload}>
              <Database size={15} />
              {t.exportSafePayload}
            </button>
          </details>
          <button
            type="button"
            className="primary-button full-width"
            disabled={props.isSubmitting || !canSubmit}
            onClick={props.submitPlan}
          >
            {props.isSubmitting ? t.submitting : t.submitTransactions}
          </button>
        </div>
      ) : (
        <div className="empty-state">
          <TerminalSquare size={28} />
          <p>{t.emptyPlan}</p>
        </div>
      )}
    </section>
  )
}

function TxOutcomePreview(props: {
  action: Action
  amount: string
  selectedValidator: ValidatorInfo
  summary: AccountSummary
  t: MessageBundle
  txPlan: TxPlan
}) {
  const { t } = props
  const amount = safeParsedAmount(props.amount)
  const simulationValue =
    props.txPlan.simulation?.status === "failed"
      ? t.simulationFailed
      : props.txPlan.simulation?.status === "partial"
        ? t.simulationPartial
        : props.txPlan.simulation?.status === "passed"
          ? t.simulationPassed
          : t.notChecked
  const rows: Array<{ label: string; value: string }> = [
    { label: t.simulationStatus, value: simulationValue },
    { label: t.transactionSteps, value: `${props.txPlan.txs.length}` },
  ]

  if (props.action === "stake" && amount !== null) {
    rows.push({ label: t.balanceChange, value: `-${formatSafe(amount)} SAFE ${t.safeBalance}` })
    rows.push({ label: t.validatorResult, value: `+${formatSafe(amount)} SAFE ${props.selectedValidator.label}` })
  }
  if (props.action === "unstake" && amount !== null) {
    rows.push({ label: t.balanceChange, value: `${formatSafe(amount)} SAFE ${t.pendingWithdrawals}` })
    rows.push({ label: t.validatorResult, value: `-${formatSafe(amount)} SAFE ${props.selectedValidator.label}` })
  }
  if (props.action === "claim-withdrawal") {
    rows.push({
      label: t.balanceChange,
      value: `+${formatSafe(props.summary.claimableWithdrawals)} SAFE ${t.safeBalance}`,
    })
  }
  if (props.action === "claim-rewards") {
    rows.push({ label: t.balanceChange, value: `+${formatSafe(props.summary.claimableRewards)} SAFE ${t.safeBalance}` })
  }
  if (props.txPlan.txs.length > 1) {
    rows.push({ label: t.approvalStep, value: t.approveNeeded })
  }

  return (
    <div className="outcome-preview">
      <div className="outcome-head">
        <CheckCircle2 size={18} />
        <span>
          <strong>{t.expectedResult}</strong>
          <small>{props.txPlan.simulation?.message ?? t.simulationExplainer}</small>
        </span>
      </div>
      {rows.map((row) => (
        <KeyValue key={row.label} label={row.label} value={row.value} />
      ))}
    </div>
  )
}

export function WithdrawalsView(props: {
  account: Address | null
  copyText: (value: string) => Promise<void>
  exportSafePayload: () => void
  isSubmitting: boolean
  t: MessageBundle
  selectAction: (action: Action) => void
  selectedValidator: ValidatorInfo
  summary: AccountSummary
  submitPlan: () => void
  txPlan: TxPlan | null
  txProgress: string
}) {
  const { t } = props
  return (
    <FullPanel title={t.withdrawals}>
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
      <div className="workflow-panel">
        <button type="button" className="primary-button" onClick={() => props.selectAction("claim-withdrawal")}>
          {t.claimWithdrawals}
        </button>
        <TxPlanPanel
          action="claim-withdrawal"
          amount="0"
          account={props.account}
          copyText={props.copyText}
          exportSafePayload={props.exportSafePayload}
          isSubmitting={props.isSubmitting}
          selectedValidator={props.selectedValidator}
          submitPlan={props.submitPlan}
          t={t}
          txPlan={props.txPlan}
          txProgress={props.txProgress}
          summary={props.summary}
        />
      </div>
    </FullPanel>
  )
}

export function RewardsView(props: {
  account: Address | null
  copyText: (value: string) => Promise<void>
  dataStatus: DataStatus
  exportSafePayload: () => void
  isSubmitting: boolean
  t: MessageBundle
  selectAction: (action: Action) => void
  selectedValidator: ValidatorInfo
  summary: AccountSummary
  submitPlan: () => void
  txPlan: TxPlan | null
  txProgress: string
}) {
  const { t } = props
  return (
    <FullPanel title={t.rewards}>
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
      <div className="workflow-panel">
        <button type="button" className="primary-button" onClick={() => props.selectAction("claim-rewards")}>
          {t.claimRewards}
        </button>
        <TxPlanPanel
          action="claim-rewards"
          amount="0"
          account={props.account}
          copyText={props.copyText}
          exportSafePayload={props.exportSafePayload}
          isSubmitting={props.isSubmitting}
          selectedValidator={props.selectedValidator}
          submitPlan={props.submitPlan}
          t={t}
          txPlan={props.txPlan}
          txProgress={props.txProgress}
          summary={props.summary}
        />
      </div>
    </FullPanel>
  )
}

export function DocsView({ t }: { t: MessageBundle }) {
  return (
    <FullPanel title={t.docsTitle}>
      <div className="docs-grid">
        <InfoCard icon={<ShieldCheck />} title={t.docsNonCustodial} value={t.docsNonCustodialValue} />
        <InfoCard icon={<TerminalSquare />} title={t.docsCliParity} value={t.docsCliParityValue} />
        <InfoCard icon={<Database />} title={t.docsReleaseManifest} value={t.docsReleaseManifestValue} />
      </div>
    </FullPanel>
  )
}
