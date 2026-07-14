import {
  ArrowDownToLine,
  ChevronDown,
  Gift,
  Home,
  Languages,
  Menu,
  RefreshCw,
  Settings,
  ShieldCheck,
  TrendingUp,
  Users,
  Wallet,
  WalletCards,
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast as sonnerToast, Toaster } from "sonner"
import { type Address, createWalletClient, custom, type Hex, isHex } from "viem"
import type { UserLlmConfig } from "../agent"
import {
  type AccountSnapshot,
  buildSafeExecTransaction,
  CHAIN_ID,
  CONTRACTS,
  combineTxPlans,
  compactAddress,
  createSafenetPublicClient,
  EXPLORER_BASE_URL,
  fetchRewardProof,
  fetchValidators,
  findValidator,
  formatSafe,
  formatSafeInput,
  formatUsdFromSafe,
  isTxPlanForAccount,
  planClaimRewards,
  planClaimWithdrawal,
  planStake,
  planUnstake,
  readAccountSnapshot,
  readHealth,
  readValidatorPositions,
  resolveSafeExecutionMode,
  SAFE_PRICE_CACHE_MS,
  type TxPlan,
  type TxPlanAction,
  toSafeTransactionPayload,
  type ValidatorInfo,
} from "../protocol"
import { ethereumMainnet } from "../protocol/chains"
import { createPathMap, navFromPath as resolveNavFromPath } from "../shared"
import { apiUrl, resolveApiBaseUrl } from "../shared/apiUrl"
import { SAFECAFE_VERSION } from "../shared/version"
import { AgentLauncher } from "./AgentLauncher"
import { DetailModal } from "./DetailModal"
import {
  formatRateLimitMessage,
  readableRpcAuthError,
  readableSimulationError,
  safeParsedAmount,
  stringifyBigInts,
  translateTxLabel,
} from "./formatters"
import { detectLocale, getMessages, isLocale, type Locale, localeOptions, type MessageBundle } from "./i18n"
import {
  accountLiveCacheFreshMs,
  type LiveReadResult,
  parseLiveReadResult,
  type RewardProof,
  type RewardProofStatus,
  readCachedLiveData,
  toBigInt,
  writeCachedLiveData,
} from "./liveDataCache"
import {
  appStorageKeys,
  readStorageAddress,
  readStorageEnum,
  readStorageFlag,
  readStorageJson,
  readStorageText,
  readStoredWalletSubject,
  removeStorageValue,
  writeStorageAddress,
  writeStorageFlag,
  writeStorageJson,
  writeStorageText,
  writeStoredWalletSubject,
} from "./persistence"
import { isUserRejectedRequest, reconcileTxPlanForExecution } from "./planExecution"
import { readCachedSafePrice, writeCachedSafePrice } from "./priceCache"
import {
  compactCid,
  createReleaseTrustLoadingState,
  type ReleaseTrustState,
  readCurrentReleaseTrust,
} from "./releaseTrust"
import { clearRpcSession, ensureRpcSession, readRpcSession } from "./rpcAuth"
import { submitSafeMultisigPlan } from "./safeMultisig"
import { fetchSafeUsdPrice } from "./safePriceApi"
import {
  type AccountSummary,
  type Action,
  type ActionExecutionSummary,
  type DataStatus,
  type DiscoveredSafe,
  defaultValidator,
  emptySummary,
  type LayoutDensity,
  layoutDensityOptions,
  type Modal,
  type NavItem,
  navItems,
  type SafePriceState,
} from "./types"
import { ConfirmDialog, ExternalActionButton, FullPanel } from "./ui"
import { isUserSafeApiKeyRejected, resolveUserSafeApiSave, type UserSafeApiStatus } from "./userSafeApiKey"
import { compareBigintDesc, findPreferredRestakeValidator } from "./validatorSelection"
import { DashboardView, DocsView, RewardsView, ValidatorTable, ValidatorToolbar, WithdrawalsView } from "./views"
import { createWalletIdentity, isSelfSubject, normalizeAddress } from "./walletIdentity"

const navPaths = createPathMap(navItems)
type ValidatorSort = "stake" | "participation" | "commission" | "name" | "yourStake"
type WalletStatus = "idle" | "restoring" | "connecting" | "connected"
type CustomRpcStatus = "checking" | "idle" | "invalid" | "valid"
type UserLlmStatus = "checking" | "idle" | "invalid" | "valid"
type UserLlmDraft = {
  apiBase: string
  apiKey: string
  maxTokens: string
  model: string
}
type DashboardAction = Extract<Action, "stake" | "unstake" | "claim-rewards">
type SubmittingAction = Action | "claim-rewards-and-stake" | null
type SimulateTxPlanOptions = { requireAuth?: boolean }
type ExecuteActionOptions = { amount?: string; validator?: Address }
type SubmitPlanOptions = {
  actionKey?: TxPlanAction | "claim-rewards-and-stake"
  alreadySubmitting?: boolean
  requireAuth?: boolean
  safeMultisigNoticeAccepted?: boolean
  skipValidation?: boolean
}
type PendingSafeMultisigNotice = {
  actionKey: TxPlanAction | "claim-rewards-and-stake"
  plan: TxPlan
  requireAuth: boolean
  txCount: number
}
type RefreshedLiveAccountData = LiveReadResult
type LiveDataMeta = { fetchedAt: number; source: "cache" | "live" }

function navFromPath(pathname: string): NavItem {
  const normalized = pathname.replace(/\/+$/, "") || "/"
  if (normalized === "/stake" || normalized === "/unstake") return "dashboard"
  return resolveNavFromPath(pathname, navItems, navPaths, "dashboard")
}

function actionFromPath(pathname: string): Action {
  const normalized = pathname.replace(/\/+$/, "") || "/"
  if (normalized === "/unstake") return "unstake"
  return "stake"
}

function buildActionPreview({
  action,
  amount,
  mode,
  selectedValidator,
  stakingAllowance,
  summary,
  t,
}: {
  action: Action
  amount: string
  mode?: "claim-and-restake"
  selectedValidator: ValidatorInfo
  stakingAllowance: bigint
  summary: AccountSummary
  t: ReturnType<typeof getMessages>
}) {
  const parsedAmount = safeParsedAmount(amount)
  const actionAmount =
    action === "claim-rewards"
      ? summary.claimableRewards
      : parsedAmount === null
        ? action === "stake"
          ? summary.safeBalance
          : selectedValidator.userStake
        : parsedAmount
  const isRestake = mode === "claim-and-restake"
  const needsApproval = (action === "stake" || isRestake) && actionAmount > 0n && stakingAllowance < actionAmount
  const expectedOutcome = isRestake
    ? `${t.claimAndRestake}: ${formatSafe(actionAmount)} SAFE -> ${selectedValidator.label}`
    : action === "stake"
      ? `${t.stakeAction} ${formatSafe(actionAmount)} SAFE`
      : action === "unstake"
        ? `${t.unstakeAction} ${formatSafe(actionAmount)} SAFE`
        : `${t.claimToWallet}: ${formatSafe(summary.claimableRewards)} SAFE`
  return {
    amount: actionAmount,
    authorization: needsApproval ? `${t.approveNeeded}: ${formatSafe(actionAmount)} SAFE` : t.sufficient,
    expectedOutcome,
    gas: t.connectToEstimateGas,
    risk:
      action === "unstake"
        ? t.warningWithdrawalQueue
        : isRestake
          ? t.restakePreview
          : action === "claim-rewards"
            ? t.rewardsProofRequired
            : t.slashingRiskValue,
    steps: isRestake
      ? [t.rewardsProofSource, t.claimToWallet, t.allowance, t.stakeAction]
      : action === "stake"
        ? [t.correctNetwork, t.allowance, t.walletConfirmation]
        : action === "unstake"
          ? [t.correctNetwork, t.walletConfirmation, t.unlocking]
          : [t.rewardsProofSource, t.walletConfirmation, t.claimed],
    validatorCommission: `${selectedValidator.commission.toFixed(2)}%`,
  }
}

function createExecutionState(
  actionKey: TxPlanAction | "claim-rewards-and-stake",
  title: string,
  steps: ActionExecutionSummary["steps"],
  options: {
    currentLabel?: string | null
    errorMessage?: string
    status?: "completed" | "failed" | "partial"
    userRejected?: boolean
  } = {},
): ActionExecutionSummary {
  const completedCount = steps.filter((step) => step.status === "done").length
  const skippedCount = steps.filter((step) => step.status === "skipped").length
  const pendingCount = steps.filter((step) => step.status === "pending").length
  const derivedStatus =
    options.status ??
    (pendingCount === 0 && !options.errorMessage
      ? "completed"
      : completedCount > 0 || skippedCount > 0
        ? "partial"
        : "failed")
  return {
    action: actionKey,
    actionKey,
    completedCount,
    currentLabel: options.currentLabel ?? null,
    errorMessage: options.errorMessage ?? "",
    pendingCount,
    skippedCount,
    status: derivedStatus,
    steps,
    title,
    userRejected: options.userRejected === true,
  }
}

function markSteps(
  steps: ActionExecutionSummary["steps"],
  status: ActionExecutionSummary["steps"][number]["status"],
): ActionExecutionSummary["steps"] {
  return steps.map((step) => ({ ...step, status }))
}

function markCompletedSafeProposalSteps(
  steps: ActionExecutionSummary["steps"],
  completedTxs: number,
): ActionExecutionSummary["steps"] {
  if (completedTxs <= 0) return steps
  return steps.map((step, index) => (index < completedTxs ? { ...step, status: "done" } : step))
}

function dashboardActionFromPath(pathname: string): DashboardAction {
  const normalized = pathname.replace(/\/+$/, "") || "/"
  if (normalized === "/unstake") return "unstake"
  return "stake"
}

function isLegacyActionPath(pathname: string) {
  const normalized = pathname.replace(/\/+$/, "") || "/"
  return normalized === "/stake" || normalized === "/unstake"
}
const defaultToastDurationMs = 3600
const dashboardActionOptions = ["stake", "unstake", "claim-rewards"] as const satisfies readonly DashboardAction[]
const validatorSortOptions = [
  "stake",
  "participation",
  "commission",
  "name",
  "yourStake",
] as const satisfies readonly ValidatorSort[]
const toastDurationMs = readToastDurationMs(import.meta.env.VITE_TOAST_DURATION_MS)
const safeMetadataFailureRetryMs = 60_000
const safeMetadataSuccessRetryMs = 10 * 60 * 1000
const transactionReceiptPollingIntervalMs = 3_000
const defaultUserLlmMaxTokens = 512
const safeTokenUnit = 10n ** 18n
const safenetBetaRewardTotal = 4_500_000n * safeTokenUnit
const safenetBetaRewardStartMs = Date.parse("2026-04-07T00:00:00.000Z")
const safenetBetaRewardEndMs = Date.parse("2026-10-07T00:00:00.000Z")
const msPerYear = 365 * 24 * 60 * 60 * 1000
type ToastTone = "success" | "warning" | "info"
const navMeta: Record<NavItem, { icon: typeof Home }> = {
  dashboard: { icon: Home },
  withdrawals: { icon: ArrowDownToLine },
  rewards: { icon: Gift },
  validators: { icon: Users },
  settings: { icon: Settings },
}

function initialDashboardAction(pathname: string): DashboardAction {
  if (isLegacyActionPath(pathname)) return dashboardActionFromPath(pathname)
  return readStorageEnum(appStorageKeys.dashboardAction, dashboardActionOptions, "stake")
}

function initialLayoutDensity(): LayoutDensity {
  return readStorageEnum(appStorageKeys.layoutDensity, layoutDensityOptions, "compact")
}

export function App() {
  const [locale, setLocale] = useState<Locale>(() => {
    const saved = readStorageText(appStorageKeys.locale)
    if (isLocale(saved)) return saved
    return detectLocale(navigator.language)
  })
  const [activeNav, setActiveNav] = useState<NavItem>(() => navFromPath(window.location.pathname))
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isLanguageMenuOpen, setIsLanguageMenuOpen] = useState(false)
  const [layoutDensity, setLayoutDensity] = useState<LayoutDensity>(() => initialLayoutDensity())
  const [account, setAccount] = useState<Address | null>(null)
  const [stakingAccount, setStakingAccount] = useState<Address | null>(null)
  const [action, setAction] = useState<Action>(() => initialDashboardAction(window.location.pathname))
  const [dashboardAction, setDashboardAction] = useState<DashboardAction>(() =>
    initialDashboardAction(window.location.pathname),
  )
  const [dashboardActionFocusRequest, setDashboardActionFocusRequest] = useState(0)
  const [validator, setValidator] = useState<Address>(
    () => readStorageAddress(appStorageKeys.selectedValidator) ?? defaultValidator.address,
  )
  const [amount, setAmount] = useState("")
  const [txPlan, setTxPlan] = useState<TxPlan | null>(null)
  const [txExecution, setTxExecution] = useState<ActionExecutionSummary | null>(null)
  const [safeMultisigPlan, setSafeMultisigPlan] = useState<TxPlan | null>(null)
  const [pendingSafeMultisigNotice, setPendingSafeMultisigNotice] = useState<PendingSafeMultisigNotice | null>(null)
  const [modal, setModal] = useState<Modal>(null)
  const [showOnlyActive, setShowOnlyActive] = useState(() => readStorageFlag(appStorageKeys.validatorsActiveOnly))
  const [validatorQuery, setValidatorQuery] = useState(() => readStorageText(appStorageKeys.validatorQuery) ?? "")
  const [validatorSort, setValidatorSort] = useState<ValidatorSort>(() =>
    readStorageEnum(appStorageKeys.validatorSort, validatorSortOptions, "stake"),
  )
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submittingAction, setSubmittingAction] = useState<SubmittingAction>(null)
  const [liveSnapshot, setLiveSnapshot] = useState<AccountSnapshot | null>(null)
  const [liveRewards, setLiveRewards] = useState<bigint | null>(null)
  const [liveBlock, setLiveBlock] = useState<bigint | null>(null)
  const [liveError, setLiveError] = useState("")
  const [isReadingLive, setIsReadingLive] = useState(false)
  const [liveDataMeta, setLiveDataMeta] = useState<LiveDataMeta | null>(null)
  const [walletStatus, setWalletStatus] = useState<WalletStatus>("idle")
  const [isLoadingValidators, setIsLoadingValidators] = useState(true)
  const [validators, setValidators] = useState<ValidatorInfo[]>([])
  const [protocolWithdrawDelay, setProtocolWithdrawDelay] = useState(0n)
  const [validatorLoadError, setValidatorLoadError] = useState("")
  const [rewardProof, setRewardProof] = useState<RewardProof | null>(null)
  const [rewardProofStatus, setRewardProofStatus] = useState<RewardProofStatus>("missing")
  const [liveMerkleRoot, setLiveMerkleRoot] = useState<string | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [rpcAuthToken, setRpcAuthToken] = useState<string | null>(null)
  const [customRpcUrl, setCustomRpcUrl] = useState("")
  const [customRpcDraft, setCustomRpcDraft] = useState(() => readStorageText(appStorageKeys.customRpcUrl)?.trim() ?? "")
  const [customRpcStatus, setCustomRpcStatus] = useState<CustomRpcStatus>(() =>
    readStorageText(appStorageKeys.customRpcUrl)?.trim() ? "checking" : "idle",
  )
  const [customRpcMessage, setCustomRpcMessage] = useState("")
  const [userSafeApiKey, setUserSafeApiKey] = useState(
    () => readStorageText(appStorageKeys.userSafeApiKey)?.trim() ?? "",
  )
  const [userSafeApiKeyDraft, setUserSafeApiKeyDraft] = useState("")
  const [userSafeApiStatus, setUserSafeApiStatus] = useState<UserSafeApiStatus>(() =>
    readStorageText(appStorageKeys.userSafeApiKey)?.trim() ? "configured" : "idle",
  )
  const [userSafeApiMessage, setUserSafeApiMessage] = useState("")
  const [userLlmConfig, setUserLlmConfig] = useState<UserLlmConfig | null>(() => readStoredUserLlmConfig())
  const [userLlmDraft, setUserLlmDraft] = useState<UserLlmDraft>(() => createUserLlmDraft(readStoredUserLlmConfig()))
  const [userLlmStatus, setUserLlmStatus] = useState<UserLlmStatus>(() => (userLlmConfig ? "valid" : "idle"))
  const [userLlmMessage, setUserLlmMessage] = useState("")
  const [txProgress, setTxProgress] = useState("")
  const [validatorStakeError, setValidatorStakeError] = useState("")
  const [safePrice, setSafePrice] = useState<SafePriceState>(() => readCachedSafePrice())
  const [releaseTrust, setReleaseTrust] = useState<ReleaseTrustState>(() => createReleaseTrustLoadingState())
  const [discoveredSafes, setDiscoveredSafes] = useState<DiscoveredSafe[]>([])
  const [safeDiscoveryStatus, setSafeDiscoveryStatus] = useState<"failed" | "idle" | "loading" | "ready">("idle")
  const [safeDiscoveryError, setSafeDiscoveryError] = useState("")

  const t = getMessages(locale)
  const activeLocale = localeOptions.find((option) => option.code === locale) ?? localeOptions[0]
  const connectedAccount = account
  const walletIdentity = useMemo(() => createWalletIdentity(account, stakingAccount), [account, stakingAccount])
  const subjectAccount = walletIdentity.subject
  const selectedStakingSafe = useMemo(
    () =>
      stakingAccount && walletIdentity.subjectKind === "safe"
        ? (discoveredSafes.find((safe) => isSameAddress(safe.address, stakingAccount)) ?? null)
        : null,
    [discoveredSafes, stakingAccount, walletIdentity.subjectKind],
  )
  const customRpcEnabled = customRpcStatus === "valid" && Boolean(customRpcUrl.trim())
  const effectiveRpcUrl = customRpcEnabled ? customRpcUrl.trim() : import.meta.env.VITE_RPC_URL
  const releaseRecord = releaseTrust.record
  const releaseCid = releaseRecord?.ipfs?.cid ?? releaseTrust.ens.cid
  const trustBadgeTone =
    releaseTrust.kind === "record" && !releaseRecord?.dirty && releaseTrust.ens.status === "matched"
      ? "verified"
      : "review"
  const trustBadgeValue =
    releaseTrust.kind === "loading" || releaseTrust.ens.status === "loading"
      ? t.reading
      : releaseTrust.kind !== "record"
        ? releaseTrust.ens.status === "resolved"
          ? t.trustBadgePartial
          : t.notChecked
        : releaseTrust.ens.status === "matched"
          ? releaseRecord?.dirty
            ? t.trustDirtyBuild
            : t.trustBadgeVerified
          : releaseTrust.ens.status === "mismatch"
            ? t.trustBadgeMismatch
            : releaseTrust.ens.status === "missing"
              ? t.trustBadgeNoEns
              : releaseTrust.ens.status === "unsupported"
                ? t.trustBadgeUnsupported
                : releaseTrust.ens.status === "error"
                  ? t.trustBadgeCheckFailed
                  : releaseCid
                    ? compactCid(releaseCid)
                    : t.notChecked
  const trustBadgeMobileValue =
    releaseTrust.kind === "loading" || releaseTrust.ens.status === "loading"
      ? "..."
      : releaseTrust.kind !== "record"
        ? releaseTrust.ens.status === "resolved"
          ? "Partial"
          : "—"
        : releaseTrust.ens.status === "matched"
          ? releaseRecord?.dirty
            ? "Dirty"
            : "OK"
          : releaseTrust.ens.status === "mismatch"
            ? "Mismatch"
            : releaseTrust.ens.status === "missing"
              ? "No ENS"
              : releaseTrust.ens.status === "unsupported"
                ? "N/A"
                : releaseTrust.ens.status === "error"
                  ? "Error"
                  : releaseCid
                    ? compactCid(releaseCid)
                    : "—"
  const walletBusy = walletStatus === "restoring" || walletStatus === "connecting"
  const walletPrimaryAccount = walletIdentity.subjectKind === "safe" ? subjectAccount : account
  const walletButtonLabel = walletPrimaryAccount
    ? compactAddress(walletPrimaryAccount, 6, 4)
    : walletStatus === "restoring"
      ? t.walletRestoring
      : walletStatus === "connecting"
        ? t.walletConnecting
        : t.connectWallet
  const walletButtonStatus = account
    ? selectedStakingSafe && selectedStakingSafe.threshold !== null && selectedStakingSafe.ownersCount !== null
      ? `${selectedStakingSafe.threshold}/${selectedStakingSafe.ownersCount} ${t.safeMultisigBadge}`
      : walletIdentity.subjectKind === "safe"
        ? t.safeWallet
        : t.connected
    : walletBusy
      ? t.reading
      : t.notConnected
  const walletButtonAriaLabel = account
    ? walletIdentity.subjectKind === "safe" && subjectAccount
      ? `${t.stakingSubject}: ${subjectAccount}, ${walletButtonStatus}; ${t.signerWallet}: ${account}`
      : `${t.wallet}: ${walletButtonLabel}, ${walletButtonStatus}`
    : t.connectWallet
  const desktopLanguageButtonRef = useRef<HTMLButtonElement | null>(null)
  const desktopLanguageMenuRef = useRef<HTMLDivElement | null>(null)
  const mobileLanguageButtonRef = useRef<HTMLButtonElement | null>(null)
  const mobileLanguageMenuRef = useRef<HTMLDivElement | null>(null)
  const liveReadRequestId = useRef(0)
  const safeMetadataLookupRef = useRef(new Map<string, number>())
  const refreshLiveReadsRef = useRef<
    ((target?: Address | null, options?: { forceRefresh?: boolean }) => Promise<RefreshedLiveAccountData | null>) | null
  >(null)
  const selectedValidator = useMemo(
    () => findValidator(validators, validator) ?? validators[0] ?? defaultValidator,
    [validator, validators],
  )
  const hasLiveAccountData = Boolean(subjectAccount && liveSnapshot)
  const liveDataStatusText = useMemo(() => {
    if (isReadingLive && !liveSnapshot) return t.liveDataReading
    if (isReadingLive && liveDataMeta?.source === "cache") return t.liveDataRefreshingCached
    if (isReadingLive && liveSnapshot) return t.liveDataRefreshing
    if (liveDataMeta?.source === "cache") return t.liveDataShowingCached
    if (liveSnapshot) return t.liveLoaded
    return ""
  }, [isReadingLive, liveDataMeta?.source, liveSnapshot, t])
  const liveDataUpdatedText = useMemo(() => {
    if (!liveDataMeta) return ""
    return `${t.liveDataUpdatedAt}: ${formatLiveDataTimestamp(liveDataMeta.fetchedAt, locale)}`
  }, [liveDataMeta, locale, t.liveDataUpdatedAt])
  const liveDataUpdatedTimeText = useMemo(() => {
    if (!liveDataMeta) return ""
    return formatLiveDataCompactTimestamp(liveDataMeta.fetchedAt, locale)
  }, [liveDataMeta, locale])
  const summaryDescription = useMemo(() => {
    if (walletStatus === "restoring") return t.walletRestoring
    if (isReadingLive && !liveSnapshot && subjectAccount) return t.liveDataReading
    if (liveSnapshot && subjectAccount) return `${t.liveDataFor} ${compactAddress(subjectAccount)}.`
    return t.connectToBegin
  }, [
    isReadingLive,
    liveSnapshot,
    subjectAccount,
    t.connectToBegin,
    t.liveDataFor,
    t.liveDataReading,
    t.walletRestoring,
    walletStatus,
  ])
  const pageHeader = useMemo(() => {
    if (activeNav === "withdrawals") return { description: t.withdrawalsPageDescription, title: t.withdrawals }
    if (activeNav === "rewards") return { description: t.rewardsPageDescription, title: t.rewards }
    if (activeNav === "validators") return { description: t.validatorsPageDescription, title: t.stakingDistribution }
    if (activeNav === "settings") return { description: t.settingsPageDescription, title: t.docsTitle }
    return { description: summaryDescription, title: t.accountSummary }
  }, [
    activeNav,
    summaryDescription,
    t.accountSummary,
    t.docsTitle,
    t.rewards,
    t.rewardsPageDescription,
    t.settingsPageDescription,
    t.stakingDistribution,
    t.validatorsPageDescription,
    t.withdrawals,
    t.withdrawalsPageDescription,
  ])
  const visibleValidators = useMemo(() => {
    const query = validatorQuery.trim().toLowerCase()
    const filtered = validators.filter((item) => {
      const activeMatch = !showOnlyActive || item.status === "active"
      const queryMatch =
        !query || item.label.toLowerCase().includes(query) || item.address.toLowerCase().includes(query)
      return activeMatch && queryMatch
    })
    return [...filtered].sort((a, b) => {
      if (validatorSort === "name") return a.label.localeCompare(b.label)
      if (validatorSort === "commission") return a.commission - b.commission
      if (validatorSort === "participation") return b.participationRate - a.participationRate
      if (validatorSort === "yourStake") return compareBigintDesc(a.userStake, b.userStake)
      return compareBigintDesc(a.totalStake, b.totalStake)
    })
  }, [showOnlyActive, validatorQuery, validatorSort, validators])
  const validatorPoolTotal = useMemo(() => validators.reduce((sum, item) => sum + item.totalStake, 0n), [validators])
  const dashboardValidators = useMemo(
    () => [...validators].sort((a, b) => compareBigintDesc(a.totalStake, b.totalStake)),
    [validators],
  )
  const summary = useMemo(() => {
    if (!liveSnapshot) return emptySummary
    const pendingWithdrawals = liveSnapshot.pendingWithdrawals.reduce((sum, item) => sum + item.amount, 0n)
    const now = BigInt(Math.floor(Date.now() / 1000))
    const { amount: nextAmount, claimableAt: nextClaimableAt } = liveSnapshot.nextClaimableWithdrawal
    return {
      safeBalance: liveSnapshot.safeBalance,
      totalStaked: liveSnapshot.totalStaked,
      pendingWithdrawals,
      claimableWithdrawals: nextClaimableAt <= now ? nextAmount : 0n,
      claimableRewards: liveRewards ?? 0n,
      withdrawDelay: liveSnapshot.withdrawDelay,
    }
  }, [liveRewards, liveSnapshot])
  const dataStatus: DataStatus = useMemo(() => {
    const merkleRootMatched =
      rewardProof && liveMerkleRoot ? rewardProof.merkleRoot.toLowerCase() === liveMerkleRoot.toLowerCase() : null
    return {
      chainId,
      isLive: Boolean(liveSnapshot),
      liveBlock,
      liveError,
      merkleRootMatched,
      proofFound: Boolean(rewardProof),
      rewardProofStatus,
      rewardsSource: liveSnapshot
        ? rewardProofStatus === "unavailable"
          ? t.proofUnavailable
          : rewardProof
            ? t.proofLoaded
            : t.proofMissing
        : t.notChecked,
      validatorCount: validators.length,
      validatorStakeOk: validators.length > 0 && validatorPoolTotal > 0n && !validatorStakeError,
      validatorStakeStatus:
        validatorStakeError ||
        (validators.length === 0 ? t.notChecked : validatorPoolTotal > 0n ? t.ready : t.validatorStakeUnavailable),
    }
  }, [
    chainId,
    liveBlock,
    liveError,
    liveMerkleRoot,
    liveSnapshot,
    rewardProof,
    rewardProofStatus,
    t,
    validatorPoolTotal,
    validatorStakeError,
    validators.length,
  ])
  const displaySummary = hasLiveAccountData ? summary : { ...emptySummary, withdrawDelay: protocolWithdrawDelay }
  const displayValidators = visibleValidators
  const displaySafePriceUsd = safePrice.usd
  const activeValidatorCount = useMemo(() => validators.filter((item) => item.status === "active").length, [validators])
  const estimatedApyPercent = calculateSafenetBetaApyPercent(validatorPoolTotal)
  const estimatedAnnualRewards = hasLiveAccountData
    ? calculateEstimatedAnnualRewards(summary.totalStaked, estimatedApyPercent)
    : null
  const totalPosition = displaySummary.safeBalance + displaySummary.totalStaked
  const formattedTotalPosition = hasLiveAccountData ? formatSafe(totalPosition) : "--"
  const formattedTotalPositionUsd = hasLiveAccountData
    ? formatUsdFromSafe(totalPosition, displaySafePriceUsd)
    : t.notConnected
  const formattedStakedPosition = hasLiveAccountData ? `${formatSafe(displaySummary.totalStaked)} SAFE` : "-- SAFE"
  const formattedAvailablePosition = hasLiveAccountData ? `${formatSafe(displaySummary.safeBalance)} SAFE` : "-- SAFE"
  const formattedClaimableRewards = hasLiveAccountData
    ? `${formatSafe(displaySummary.claimableRewards)} SAFE`
    : "-- SAFE"
  const formattedClaimableRewardsUsd = hasLiveAccountData
    ? formatUsdFromSafe(displaySummary.claimableRewards, displaySafePriceUsd)
    : t.notConnected
  const formattedAnnualRewards =
    estimatedAnnualRewards === null ? "-- SAFE" : `${formatSafe(estimatedAnnualRewards)} SAFE`
  const decisionMetrics = {
    activeValidatorCount,
    protocolTvlUsd: formatUsdFromSafe(validatorPoolTotal, displaySafePriceUsd),
    validatorPoolTotal,
    withdrawDelay: summary.withdrawDelay || liveSnapshot?.withdrawDelay || protocolWithdrawDelay,
  }
  const dashboardActionPreview = buildActionPreview({
    action: dashboardAction,
    amount,
    selectedValidator,
    summary,
    stakingAllowance: liveSnapshot?.stakingAllowance ?? 0n,
    t,
  })
  const rewardsActionPreview = buildActionPreview({
    action: "claim-rewards",
    amount,
    selectedValidator,
    summary,
    stakingAllowance: liveSnapshot?.stakingAllowance ?? 0n,
    t,
  })
  const rewardsRestakePreview = buildActionPreview({
    action: "claim-rewards",
    amount,
    mode: "claim-and-restake",
    selectedValidator,
    summary,
    stakingAllowance: liveSnapshot?.stakingAllowance ?? 0n,
    t,
  })
  const selectedSafeHasMetadata = useMemo(() => {
    return Boolean(selectedStakingSafe && hasSafeMultisigMetadata(selectedStakingSafe))
  }, [selectedStakingSafe])
  const agentContext = useMemo(
    () => ({
      account,
      subjectAccount,
      subjectKind: walletIdentity.subjectKind,
      chainId,
      liveBlock,
      liveSnapshot,
      summary,
      validators,
      rewardProof,
      liveMerkleRoot,
    }),
    [
      account,
      chainId,
      liveBlock,
      liveMerkleRoot,
      liveSnapshot,
      rewardProof,
      subjectAccount,
      summary,
      validators,
      walletIdentity.subjectKind,
    ],
  )

  const toast = useCallback((message: string, tone: ToastTone = "info", title?: string) => {
    const options = {
      description: title ? message : undefined,
      duration: toastDurationMs,
    }
    const content = title ?? message
    if (tone === "success") {
      sonnerToast.success(content, options)
      return
    }
    if (tone === "warning") {
      sonnerToast.warning(content, options)
      return
    }
    sonnerToast.info(content, options)
  }, [])

  const updateDashboardAction = useCallback((nextAction: DashboardAction) => {
    setDashboardAction(nextAction)
    writeStorageText(appStorageKeys.dashboardAction, nextAction)
  }, [])

  useEffect(() => {
    const savedRpcUrl = readStorageText(appStorageKeys.customRpcUrl)?.trim()
    if (!savedRpcUrl) return
    let cancelled = false
    setCustomRpcUrl("")
    setCustomRpcDraft(savedRpcUrl)
    setCustomRpcStatus("checking")
    setCustomRpcMessage(t.customRpcChecking)
    verifyCustomRpcUrl(savedRpcUrl, t)
      .then(() => {
        if (cancelled) return
        setCustomRpcUrl(savedRpcUrl)
        setCustomRpcStatus("valid")
        setCustomRpcMessage(t.customRpcActive)
      })
      .catch((error) => {
        if (cancelled) return
        setCustomRpcUrl("")
        setCustomRpcStatus("invalid")
        setCustomRpcMessage(error instanceof Error ? error.message : t.customRpcFailed)
      })
    return () => {
      cancelled = true
    }
  }, [t])

  useEffect(() => {
    const handlePopState = () => {
      setActiveNav(navFromPath(window.location.pathname))
      if (isLegacyActionPath(window.location.pathname)) {
        const nextAction = actionFromPath(window.location.pathname)
        setAction(nextAction)
        updateDashboardAction(dashboardActionFromPath(window.location.pathname))
      }
    }
    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [updateDashboardAction])

  useEffect(() => {
    if (!isLegacyActionPath(window.location.pathname)) return
    const dashboardPath = navPaths.dashboard
    if (window.location.pathname !== dashboardPath) window.history.replaceState(null, "", dashboardPath)
  }, [])

  useEffect(() => {
    let cancelled = false
    const cached = readCachedSafePrice()
    if (cached.usd !== null && cached.fetchedAt && Date.now() - cached.fetchedAt < SAFE_PRICE_CACHE_MS) {
      setSafePrice(cached)
      return
    }

    fetchSafeUsdPrice()
      .then((price) => {
        if (cancelled) return
        const nextPrice: SafePriceState = {
          usd: price.usd,
          source: price.source,
          fetchedAt: price.fetchedAt,
          stale: false,
          error: "",
        }
        writeCachedSafePrice(nextPrice)
        setSafePrice(nextPrice)
      })
      .catch((error) => {
        if (cancelled) return
        setSafePrice({
          ...cached,
          stale: cached.usd !== null,
          error: error instanceof Error ? error.message : t.priceUnavailable,
        })
      })

    return () => {
      cancelled = true
    }
  }, [t.priceUnavailable])

  useEffect(() => {
    if (!account || !subjectAccount || safeMultisigPlan || txExecution?.safeProposal) return
    const restored = readStoredSafeProposal(account, subjectAccount)
    if (!restored) return
    setTxPlan(restored.plan)
    setSafeMultisigPlan(restored.plan)
    setTxExecution(restored.execution)
  }, [account, safeMultisigPlan, subjectAccount, txExecution?.safeProposal])

  const updateAmount = useCallback((nextAmount: string) => {
    setAmount(nextAmount)
    removeStoredSafeProposal()
    setSafeMultisigPlan(null)
    setTxPlan(null)
    setTxExecution(null)
  }, [])

  const updateValidator = useCallback((nextValidator: Address) => {
    setValidator(nextValidator)
    writeStorageAddress(appStorageKeys.selectedValidator, nextValidator)
    removeStoredSafeProposal()
    setSafeMultisigPlan(null)
    setTxPlan(null)
    setTxExecution(null)
  }, [])

  const updateShowOnlyActive = useCallback((nextValue: boolean) => {
    setShowOnlyActive(nextValue)
    writeStorageFlag(appStorageKeys.validatorsActiveOnly, nextValue)
  }, [])

  const updateValidatorQuery = useCallback((nextQuery: string) => {
    setValidatorQuery(nextQuery)
    if (nextQuery.trim()) {
      writeStorageText(appStorageKeys.validatorQuery, nextQuery)
    } else {
      removeStorageValue(appStorageKeys.validatorQuery)
    }
  }, [])

  const updateValidatorSort = useCallback((nextSort: ValidatorSort) => {
    setValidatorSort(nextSort)
    writeStorageText(appStorageKeys.validatorSort, nextSort)
  }, [])

  const resetLiveAccountState = useCallback(() => {
    liveReadRequestId.current += 1
    setLiveSnapshot(null)
    setLiveRewards(null)
    setRewardProof(null)
    setRewardProofStatus("missing")
    setLiveMerkleRoot(null)
    setLiveBlock(null)
    setLiveDataMeta(null)
    setLiveError("")
    setPendingSafeMultisigNotice(null)
    setSafeMultisigPlan(null)
    setTxPlan(null)
    setTxExecution(null)
    setTxProgress("")
    setValidators((current) => current.map(clearValidatorPosition))
  }, [])

  const setWalletIdentityState = useCallback((identity: ReturnType<typeof createWalletIdentity>) => {
    setAccount(identity.signer)
    setStakingAccount(identity.subject)
  }, [])

  const selectStakingSubject = useCallback(
    (identity: ReturnType<typeof createWalletIdentity>, options: { persist?: boolean; refresh?: boolean } = {}) => {
      setWalletIdentityState(identity)
      if (options.persist !== false) writeStoredWalletSubject(identity.signer, identity.subject)
      resetLiveAccountState()
      const session = identity.signer ? readRpcSession(identity) : null
      setRpcAuthToken(session?.token ?? null)
      if (options.refresh && identity.subject)
        void refreshLiveReadsRef.current?.(identity.subject, { forceRefresh: true })
    },
    [resetLiveAccountState, setWalletIdentityState],
  )

  useEffect(() => {
    setIsLoadingValidators(true)
    setValidatorLoadError("")
    fetchValidatorProtocolData()
      .then((data) => {
        setValidatorStakeError("")
        setProtocolWithdrawDelay(data.withdrawDelay)
        setValidators((current) => {
          const merged = mergeValidatorMetadata(data.validators, current)
          setValidator((selected) => {
            const nextSelected = findValidator(merged, selected)?.address ?? merged[0]?.address ?? selected
            if (nextSelected !== selected) writeStorageAddress(appStorageKeys.selectedValidator, nextSelected)
            return nextSelected
          })
          return merged
        })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : t.validatorInfoFailed
        setValidatorLoadError(message)
        toast(message, "warning")
      })
      .finally(() => {
        setIsLoadingValidators(false)
      })
  }, [t.validatorInfoFailed, toast])

  const applyLiveReadResult = useCallback((data: LiveReadResult, meta: LiveDataMeta) => {
    setLiveSnapshot(data.snapshot)
    setLiveBlock(data.health.blockNumber)
    setLiveMerkleRoot(data.health.merkleRoot)
    setValidatorLoadError("")
    setValidators(data.validatorsWithPositions)
    setRewardProof(data.rewardProof)
    setRewardProofStatus(data.rewardProofStatus)
    setLiveRewards(data.rewards)
    setLiveDataMeta(meta)
  }, [])

  const refreshLiveReads = useCallback(
    async (target = subjectAccount, options: { forceRefresh?: boolean } = {}) => {
      if (!target) {
        toast(t.connectToLoad, "warning")
        return null
      }
      const requestId = liveReadRequestId.current + 1
      liveReadRequestId.current = requestId
      setLiveError("")
      const cached = options.forceRefresh || customRpcEnabled ? null : readCachedLiveData(target)
      if (cached) {
        applyLiveReadResult(cached.data, { fetchedAt: cached.fetchedAt, source: "cache" })
        if (Date.now() - cached.fetchedAt <= accountLiveCacheFreshMs) {
          setIsReadingLive(false)
          return cached.data
        }
      }
      setIsReadingLive(true)
      try {
        const nextLiveData = await readLiveData(target, options, customRpcEnabled ? effectiveRpcUrl : undefined)
        if (liveReadRequestId.current !== requestId) return null
        const fetchedAt = customRpcEnabled ? Date.now() : writeCachedLiveData(target, nextLiveData)
        applyLiveReadResult(nextLiveData, { fetchedAt, source: "live" })
        return nextLiveData
      } catch (error) {
        if (liveReadRequestId.current !== requestId) return null
        const message =
          error instanceof ApiResponseError && error.code === "ip_rate_limited"
            ? formatRateLimitMessage(t, locale, error.resetAt)
            : error instanceof Error
              ? error.message
              : t.liveDataFailed
        const fallbackMessage = cached ? `${t.liveDataRefreshFailedCached} ${message}` : message
        setLiveError(fallbackMessage)
        toast(fallbackMessage, "warning")
        return cached?.data ?? null
      } finally {
        if (liveReadRequestId.current === requestId) setIsReadingLive(false)
      }
    },
    [applyLiveReadResult, customRpcEnabled, effectiveRpcUrl, subjectAccount, locale, t, toast],
  )

  useEffect(() => {
    refreshLiveReadsRef.current = refreshLiveReads
  }, [refreshLiveReads])

  useEffect(() => {
    if (!stakingAccount || walletIdentity.subjectKind !== "safe") return
    const normalizedStakingAccount = stakingAccount.toLowerCase()
    if (selectedSafeHasMetadata) return
    const retryAfter = safeMetadataLookupRef.current.get(normalizedStakingAccount)
    if (retryAfter && retryAfter > Date.now()) return
    const controller = new AbortController()
    fetchSafeMetadata(stakingAccount, controller.signal)
      .then((safe) => {
        if (controller.signal.aborted) return
        safeMetadataLookupRef.current.set(
          normalizedStakingAccount,
          Date.now() + (hasSafeMultisigMetadata(safe) ? safeMetadataSuccessRetryMs : safeMetadataFailureRetryMs),
        )
        setDiscoveredSafes((current) => mergeDiscoveredSafes(current, [safe]))
      })
      .catch(() => {
        if (controller.signal.aborted) return
        safeMetadataLookupRef.current.set(normalizedStakingAccount, Date.now() + safeMetadataFailureRetryMs)
        setDiscoveredSafes((current) => mergeDiscoveredSafes(current, [emptyDiscoveredSafe(stakingAccount)]))
      })
    return () => controller.abort()
  }, [selectedSafeHasMetadata, stakingAccount, walletIdentity.subjectKind])

  useEffect(() => {
    if (!account) {
      setDiscoveredSafes([])
      setSafeDiscoveryStatus("idle")
      setSafeDiscoveryError("")
      return
    }
    const controller = new AbortController()
    setSafeDiscoveryStatus("loading")
    setSafeDiscoveryError("")
    fetchOwnedSafesWithMetadata(account, controller.signal)
      .then((safes) => {
        if (controller.signal.aborted) return
        setDiscoveredSafes((current) => mergeDiscoveredSafes(current, safes, stakingAccount))
        setSafeDiscoveryStatus("ready")
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        setDiscoveredSafes((current) =>
          stakingAccount && !current.some((safe) => isSameAddress(safe.address, stakingAccount))
            ? mergeDiscoveredSafes(current, [emptyDiscoveredSafe(stakingAccount)])
            : current,
        )
        setSafeDiscoveryStatus("failed")
        setSafeDiscoveryError(error instanceof Error ? error.message : t.safeDiscoveryFailed)
      })
    return () => controller.abort()
  }, [account, stakingAccount, t.safeDiscoveryFailed])

  useEffect(() => {
    if (!window.ethereum) return
    let cancelled = false
    window.ethereum
      .request({ method: "eth_chainId" })
      .then((value) => {
        if (!cancelled) setChainId(Number.parseInt(value as string, 16))
      })
      .catch(() => undefined)

    if (!readStorageFlag(appStorageKeys.walletDisconnected)) {
      setWalletStatus("restoring")
      window.ethereum
        .request({ method: "eth_accounts" })
        .then(async (accounts) => {
          if (cancelled) return
          const [first] = accounts as Address[]
          if (!first) {
            setWalletStatus("idle")
            return
          }
          const identity = createWalletIdentity(first, readStoredWalletSubject(first) ?? undefined)
          selectStakingSubject(identity)
          setWalletStatus("connected")
          if (customRpcStatus !== "checking") await refreshLiveReadsRef.current?.(identity.subject)
        })
        .catch(() => {
          if (!cancelled) setWalletStatus("idle")
        })
    }

    const handleAccountsChanged = (accounts: unknown) => {
      const [first] = accounts as Address[]
      const identity = createWalletIdentity(
        first ?? null,
        first ? (readStoredWalletSubject(first) ?? undefined) : undefined,
      )
      resetLiveAccountState()
      selectStakingSubject(identity)
      setWalletStatus(first ? "connected" : "idle")
      if (first) {
        removeStorageValue(appStorageKeys.walletDisconnected)
        if (customRpcStatus !== "checking") void refreshLiveReadsRef.current?.(identity.subject)
      } else {
        writeStorageFlag(appStorageKeys.walletDisconnected, true)
      }
    }
    const handleChainChanged = (value: unknown) => {
      setChainId(Number.parseInt(value as string, 16))
      resetLiveAccountState()
      window.ethereum
        ?.request({ method: "eth_accounts" })
        .then((accounts) => {
          if (cancelled) return
          const [first] = accounts as Address[]
          const identity = createWalletIdentity(
            first ?? null,
            first ? (readStoredWalletSubject(first) ?? undefined) : undefined,
          )
          selectStakingSubject(identity)
          setWalletStatus(first ? "connected" : "idle")
          if (first && customRpcStatus !== "checking") void refreshLiveReadsRef.current?.(identity.subject)
        })
        .catch(() => undefined)
    }
    window.ethereum.on?.("accountsChanged", handleAccountsChanged)
    window.ethereum.on?.("chainChanged", handleChainChanged)
    return () => {
      cancelled = true
      window.ethereum?.removeListener?.("accountsChanged", handleAccountsChanged)
      window.ethereum?.removeListener?.("chainChanged", handleChainChanged)
    }
  }, [customRpcStatus, resetLiveAccountState, selectStakingSubject])

  useEffect(() => {
    if (!isLanguageMenuOpen) return
    const visibleLanguageMenu = () =>
      [desktopLanguageMenuRef.current, mobileLanguageMenuRef.current].find(
        (node) => node && node.offsetParent !== null,
      ) ??
      desktopLanguageMenuRef.current ??
      mobileLanguageMenuRef.current
    const visibleLanguageButton = () =>
      [desktopLanguageButtonRef.current, mobileLanguageButtonRef.current].find(
        (node) => node && node.offsetParent !== null,
      ) ??
      desktopLanguageButtonRef.current ??
      mobileLanguageButtonRef.current
    window.requestAnimationFrame(() => {
      visibleLanguageMenu()?.querySelector<HTMLButtonElement>("[aria-checked='true']")?.focus()
    })
    const closeLanguageMenu = (event: PointerEvent) => {
      const target = event.target as Node
      if (desktopLanguageMenuRef.current?.contains(target) || mobileLanguageMenuRef.current?.contains(target)) return
      setIsLanguageMenuOpen(false)
    }
    const closeLanguageMenuWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsLanguageMenuOpen(false)
        visibleLanguageButton()?.focus()
      }
    }
    document.addEventListener("pointerdown", closeLanguageMenu)
    document.addEventListener("keydown", closeLanguageMenuWithEscape)
    return () => {
      document.removeEventListener("pointerdown", closeLanguageMenu)
      document.removeEventListener("keydown", closeLanguageMenuWithEscape)
    }
  }, [isLanguageMenuOpen])

  useEffect(() => {
    if (!dashboardActionFocusRequest || activeNav !== "dashboard") return
    let focusTimeout: number | null = null
    const animationFrame = window.requestAnimationFrame(() => {
      const panel = document.querySelector<HTMLElement>(".primary-actions-panel")
      if (!panel) return
      panel.scrollIntoView({ behavior: "smooth", block: "center" })
      focusTimeout = window.setTimeout(() => {
        const amountInput = panel.querySelector<HTMLInputElement>(".amount-input-wrap input:not(:disabled)")
        const actionButton = panel.querySelector<HTMLButtonElement>(".form-row .primary-button:not(:disabled)")
        const focusTarget = amountInput ?? actionButton
        focusTarget?.focus({ preventScroll: true })
      }, 160)
    })
    return () => {
      window.cancelAnimationFrame(animationFrame)
      if (focusTimeout) window.clearTimeout(focusTimeout)
    }
  }, [activeNav, dashboardActionFocusRequest])

  useEffect(() => {
    let cancelled = false
    setReleaseTrust(createReleaseTrustLoadingState())
    readCurrentReleaseTrust(customRpcEnabled ? effectiveRpcUrl : undefined).then((nextTrust) => {
      if (!cancelled) setReleaseTrust(nextTrust)
    })
    return () => {
      cancelled = true
    }
  }, [customRpcEnabled, effectiveRpcUrl])

  function selectLocale(nextLocale: Locale) {
    setLocale(nextLocale)
    writeStorageText(appStorageKeys.locale, nextLocale)
    setIsLanguageMenuOpen(false)
  }

  function selectLayoutDensity(nextDensity: LayoutDensity) {
    setLayoutDensity(nextDensity)
    writeStorageText(appStorageKeys.layoutDensity, nextDensity)
  }

  function navigate(nextNav: NavItem) {
    setActiveNav(nextNav)
    setIsMenuOpen(false)
    const nextPath = navPaths[nextNav]
    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, "", nextPath)
    }
  }

  function openValidatorDashboardAction(nextValidator: Address, nextAction: Extract<Action, "stake" | "unstake">) {
    if (!selectValidatorAction(nextValidator, nextAction)) return
    navigate("dashboard")
    setDashboardActionFocusRequest((current) => current + 1)
  }

  async function connectWallet() {
    if (!window.ethereum) {
      toast(t.noWallet, "warning")
      return
    }
    setWalletStatus("connecting")
    try {
      removeStorageValue(appStorageKeys.walletDisconnected)
      const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[]
      const signer = accounts[0] ?? null
      const identity = createWalletIdentity(signer, signer ? (readStoredWalletSubject(signer) ?? undefined) : undefined)
      await ensureMainnet()
      if (!identity.signer || !identity.subject) throw new Error(t.noAccount)
      selectStakingSubject(identity)
      setWalletStatus("connected")
      await refreshLiveReads(identity.subject)
    } catch (error) {
      setWalletStatus(account ? "connected" : "idle")
      toast(error instanceof Error ? error.message : t.wrongNetwork, "warning")
    }
  }

  function disconnectWallet() {
    setAccount(null)
    setStakingAccount(null)
    resetLiveAccountState()
    setIsReadingLive(false)
    setWalletStatus("idle")
    writeStorageFlag(appStorageKeys.walletDisconnected, true)
    clearRpcSession()
    setRpcAuthToken(null)
  }

  async function ensureMainnet() {
    if (!window.ethereum) throw new Error(t.noWallet)
    const rawChainId = (await window.ethereum.request({ method: "eth_chainId" })) as string
    const currentChainId = Number.parseInt(rawChainId, 16)
    setChainId(currentChainId)
    if (currentChainId === CHAIN_ID) return

    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${CHAIN_ID.toString(16)}` }],
    })
    setChainId(CHAIN_ID)
    toast(t.mainnetReady, "success")
  }

  async function refreshOrConnect() {
    if (!account) {
      await connectWallet()
      return
    }
    await refreshLiveReads(subjectAccount)
  }

  async function forceRefreshLiveReads() {
    await refreshLiveReads(subjectAccount, { forceRefresh: true })
  }

  async function refreshLiveDataForAgent() {
    if (!subjectAccount) return null
    const refreshed = await refreshLiveReads(subjectAccount, { forceRefresh: true })
    if (!refreshed) return null
    return {
      account,
      subjectAccount,
      subjectKind: walletIdentity.subjectKind,
      chainId,
      liveBlock: refreshed.health.blockNumber,
      liveSnapshot: refreshed.snapshot,
      summary: summaryFromSnapshot(refreshed.snapshot, refreshed.rewards),
      validators: refreshed.validatorsWithPositions,
      rewardProof: refreshed.rewardProof,
      liveMerkleRoot: refreshed.health.merkleRoot,
    }
  }

  async function authenticateAgent() {
    if (!window.ethereum) {
      toast(t.noWallet, "warning")
      return null
    }
    if (!account || !subjectAccount) {
      toast(t.agentAuthRequired, "warning")
      return null
    }
    const identity = createWalletIdentity(account, subjectAccount)
    const cached = readRpcSession(identity)
    if (cached) {
      setRpcAuthToken(cached.token)
      return cached.token
    }
    try {
      const session = await ensureRpcSession(identity, window.ethereum)
      setRpcAuthToken(session?.token ?? null)
      return session?.token ?? null
    } catch (error) {
      const message = readableRpcAuthError(error, t.agentAuthFailed, t, locale)
      toast(message, "warning")
      return null
    }
  }

  async function ensureRpcAuthTokenForCurrentWallet() {
    if (rpcAuthToken) return rpcAuthToken
    if (!window.ethereum) throw new Error(t.noWallet)
    if (!account || !subjectAccount) throw new Error(t.agentAuthRequired)
    const identity = createWalletIdentity(account, subjectAccount)
    const cached = readRpcSession(identity)
    if (cached) {
      setRpcAuthToken(cached.token)
      return cached.token
    }
    const session = await ensureRpcSession(identity, window.ethereum)
    if (!session?.token) throw new Error(t.agentAuthFailed)
    setRpcAuthToken(session.token)
    return session.token
  }

  function updateCustomRpcDraft(value: string) {
    setCustomRpcDraft(value)
    const normalized = value.trim()
    if (normalized && normalized === customRpcUrl.trim() && customRpcStatus === "valid") {
      setCustomRpcMessage(t.customRpcActive)
      return
    }
    setCustomRpcStatus("idle")
    setCustomRpcMessage("")
  }

  async function saveCustomRpcUrl() {
    const candidate = customRpcDraft.trim()
    if (!candidate) {
      clearCustomRpcUrl()
      return
    }
    setCustomRpcStatus("checking")
    setCustomRpcMessage(t.customRpcChecking)
    try {
      await verifyCustomRpcUrl(candidate, t)
      setCustomRpcUrl(candidate)
      setCustomRpcDraft(candidate)
      setCustomRpcStatus("valid")
      setCustomRpcMessage(t.customRpcActive)
      writeStorageText(appStorageKeys.customRpcUrl, candidate)
      setRpcAuthToken(null)
      clearRpcSession()
      toast(t.customRpcSaved, "success")
    } catch (error) {
      setCustomRpcStatus("invalid")
      setCustomRpcMessage(error instanceof Error ? error.message : t.customRpcFailed)
      toast(error instanceof Error ? error.message : t.customRpcFailed, "warning")
    }
  }

  function clearCustomRpcUrl() {
    setCustomRpcUrl("")
    setCustomRpcDraft("")
    setCustomRpcStatus("idle")
    setCustomRpcMessage("")
    removeStorageValue(appStorageKeys.customRpcUrl)
    toast(t.customRpcCleared, "info")
  }

  function updateUserSafeApiKeyDraft(value: string) {
    setUserSafeApiKeyDraft(value)
    setUserSafeApiStatus("idle")
    setUserSafeApiMessage("")
  }

  function saveUserSafeApiKey() {
    const saved = resolveUserSafeApiSave(userSafeApiKeyDraft, userSafeApiKey)
    if (!saved) {
      setUserSafeApiStatus("invalid")
      setUserSafeApiMessage(t.userSafeApiKeyRequired)
      toast(t.userSafeApiKeyRequired, "warning")
      return
    }
    setUserSafeApiKey(saved.key)
    setUserSafeApiKeyDraft("")
    setUserSafeApiStatus(saved.status)
    setUserSafeApiMessage(t.userSafeApiActive)
    writeStorageText(appStorageKeys.userSafeApiKey, saved.key)
    toast(t.userSafeApiSaved, "success")
  }

  function clearUserSafeApiKey() {
    setUserSafeApiKey("")
    setUserSafeApiKeyDraft("")
    setUserSafeApiStatus("idle")
    setUserSafeApiMessage("")
    removeStorageValue(appStorageKeys.userSafeApiKey)
    toast(t.userSafeApiCleared, "info")
  }

  function updateUserLlmDraft(field: keyof UserLlmDraft, value: string) {
    setUserLlmDraft((current) => ({ ...current, [field]: value }))
    setUserLlmStatus("idle")
    setUserLlmMessage("")
  }

  async function saveUserLlmConfig() {
    const apiBase = userLlmDraft.apiBase.trim()
    const model = userLlmDraft.model.trim()
    const apiKey = userLlmDraft.apiKey.trim() || userLlmConfig?.apiKey || ""
    const maxTokens = readUserLlmMaxTokens(userLlmDraft.maxTokens)
    try {
      let parsed: URL
      try {
        parsed = new URL(apiBase)
      } catch {
        throw new Error(t.userLlmInvalidUrl)
      }
      if (!isAllowedUserLlmApiBase(parsed)) throw new Error(t.userLlmHttpsRequired)
      if (!model) throw new Error(t.userLlmModelRequired)
      if (!apiKey) throw new Error(t.userLlmKeyRequired)
      const nextConfig: UserLlmConfig = { apiBase, apiKey, maxTokens, model }
      setUserLlmStatus("checking")
      setUserLlmMessage(t.userLlmChecking)
      await verifyUserLlmConfig(nextConfig, t)
      setUserLlmConfig(nextConfig)
      setUserLlmDraft(createUserLlmDraft(nextConfig))
      setUserLlmStatus("valid")
      setUserLlmMessage(t.userLlmActive)
      writeStorageJson(appStorageKeys.userLlmConfig, nextConfig)
      toast(t.userLlmSaved, "success")
    } catch (error) {
      setUserLlmStatus("invalid")
      setUserLlmMessage(error instanceof Error ? error.message : t.userLlmFailed)
      toast(error instanceof Error ? error.message : t.userLlmFailed, "warning")
    }
  }

  function clearUserLlmConfig() {
    setUserLlmConfig(null)
    setUserLlmDraft(createUserLlmDraft(null))
    setUserLlmStatus("idle")
    setUserLlmMessage("")
    removeStorageValue(appStorageKeys.userLlmConfig)
    toast(t.userLlmCleared, "info")
  }

  function createTxPlan(
    nextAction = action,
    options: ExecuteActionOptions & { liveData?: RefreshedLiveAccountData | null } = {},
  ): TxPlan | null {
    const snapshot = options.liveData?.snapshot ?? liveSnapshot
    const proof = options.liveData?.rewardProof ?? rewardProof
    const rewards = options.liveData?.rewards ?? liveRewards ?? 0n
    const merkleRoot = options.liveData?.health.merkleRoot ?? liveMerkleRoot
    if (!subjectAccount || !snapshot) return null
    const targetValidator = options.validator ?? validator
    const targetAmount = options.amount ?? amount
    if (nextAction === "stake") {
      return planStake({
        validator: targetValidator,
        amount: targetAmount,
        account: subjectAccount,
        allowance: snapshot.stakingAllowance,
      })
    }
    if (nextAction === "unstake") {
      return planUnstake({ validator: targetValidator, amount: targetAmount, account: subjectAccount })
    }
    if (nextAction === "claim-withdrawal") {
      return planClaimWithdrawal(subjectAccount)
    }
    if (nextAction === "claim-rewards") {
      if (!proof?.proof) throw new Error(t.noProof)
      if (merkleRoot && proof.merkleRoot.toLowerCase() !== merkleRoot.toLowerCase()) {
        throw new Error(t.merkleMismatch)
      }
      if (rewards <= 0n) throw new Error(t.noProof)
      return planClaimRewards({
        account: subjectAccount,
        cumulativeAmount: BigInt(proof.cumulativeAmount),
        merkleRoot: proof.merkleRoot,
        proof: proof.proof,
      })
    }
    return null
  }

  function createClaimRewardsAndStakePlan(
    targetValidatorAddress: Address,
    data?: RefreshedLiveAccountData | null,
  ): TxPlan {
    const snapshot = data?.snapshot ?? liveSnapshot
    const proof = data?.rewardProof ?? rewardProof
    const rewards = data?.rewards ?? liveRewards ?? 0n
    const merkleRoot = data?.health.merkleRoot ?? liveMerkleRoot
    if (!subjectAccount || !snapshot) throw new Error(t.connectToPlan)
    if (!proof?.proof) throw new Error(t.noProof)
    if (merkleRoot && proof.merkleRoot.toLowerCase() !== merkleRoot.toLowerCase()) {
      throw new Error(t.merkleMismatch)
    }
    const rewardAmount = rewards
    if (rewardAmount <= 0n) throw new Error(t.noProof)
    const targetValidator = data?.validatorsWithPositions
      ? findValidator(data.validatorsWithPositions, targetValidatorAddress)
      : findValidator(validators, targetValidatorAddress)
    if (!targetValidator) throw new Error(t.inactiveValidator)
    if (targetValidator.status !== "active") throw new Error(t.inactiveValidator)
    return combineTxPlans({
      title: "Claim and stake rewards",
      account: subjectAccount,
      plans: [
        planClaimRewards({
          account: subjectAccount,
          cumulativeAmount: BigInt(proof.cumulativeAmount),
          merkleRoot: proof.merkleRoot,
          proof: proof.proof,
        }),
        planStake({
          validator: targetValidatorAddress,
          amount: formatSafeInput(rewardAmount),
          account: subjectAccount,
          allowance: snapshot.stakingAllowance,
        }),
      ],
    })
  }

  async function executeAction(nextAction = action, options: ExecuteActionOptions = {}) {
    if (!account) {
      await connectWallet()
      return
    }
    if (!window.ethereum) {
      toast(t.noWallet, "warning")
      return
    }
    if (isSubmitting) return
    const localValidation = validateAction(nextAction, {
      ...options,
      skipChainCheck: true,
      skipRewardCheck: nextAction === "claim-rewards",
    })
    if (localValidation) {
      toast(localValidation, "warning")
      return
    }
    setAction(nextAction)
    removeStoredSafeProposal()
    setPendingSafeMultisigNotice(null)
    setSafeMultisigPlan(null)
    setTxPlan(null)
    setTxExecution(null)
    setIsSubmitting(true)
    setSubmittingAction(nextAction)
    try {
      await ensureMainnet()
      if (!subjectAccount || !liveSnapshot) throw new Error(t.connectToPlan)
      const refreshed =
        nextAction === "claim-rewards" ? await refreshLiveReads(subjectAccount, { forceRefresh: true }) : null
      if (nextAction === "claim-rewards" && !refreshed) throw new Error(t.liveDataFailed)
      const validation = validateAction(nextAction, { ...options, liveData: refreshed })
      if (validation) throw new Error(validation)
      const nextPlan = createTxPlan(nextAction, { ...options, liveData: refreshed })
      if (!nextPlan) throw new Error(t.transactionFailed)
      const simulatedPlan = await simulateTxPlan(nextPlan, { requireAuth: true })
      if (simulatedPlan.simulation?.status === "failed") throw new Error(simulatedPlan.simulation.message)
      setTxPlan(simulatedPlan)
      await submitPlan(simulatedPlan, {
        actionKey: nextAction,
        alreadySubmitting: true,
        requireAuth: true,
        skipValidation: true,
      })
    } catch (error) {
      toast(readableSimulationError(error, t.transactionFailed, t.requestRateLimited), "warning")
    } finally {
      setIsSubmitting(false)
      setSubmittingAction(null)
      setTxProgress("")
    }
  }

  async function executeClaimRewardsAndStake(targetValidatorAddress: Address) {
    if (!account) {
      await connectWallet()
      return
    }
    if (!window.ethereum) {
      toast(t.noWallet, "warning")
      return
    }
    if (isSubmitting) return
    const targetValidator = findValidator(validators, targetValidatorAddress)
    if (!subjectAccount || !liveSnapshot) {
      toast(t.connectToPlan, "warning")
      return
    }
    if (targetValidator?.status !== "active") {
      toast(t.inactiveValidator, "warning")
      return
    }
    setAction("claim-rewards")
    removeStoredSafeProposal()
    setPendingSafeMultisigNotice(null)
    setSafeMultisigPlan(null)
    setTxPlan(null)
    setTxExecution(null)
    setIsSubmitting(true)
    setSubmittingAction("claim-rewards-and-stake")
    try {
      await ensureMainnet()
      const refreshed = await refreshLiveReads(subjectAccount, { forceRefresh: true })
      if (!refreshed) throw new Error(t.liveDataFailed)
      const nextPlan = createClaimRewardsAndStakePlan(targetValidatorAddress, refreshed)
      const simulatedPlan = await simulateTxPlan(nextPlan, { requireAuth: true })
      if (simulatedPlan.simulation?.status === "failed") throw new Error(simulatedPlan.simulation.message)
      setTxPlan(simulatedPlan)
      await submitPlan(simulatedPlan, {
        actionKey: "claim-rewards-and-stake",
        alreadySubmitting: true,
        requireAuth: true,
        skipValidation: true,
      })
    } catch (error) {
      toast(readableSimulationError(error, t.transactionFailed, t.requestRateLimited), "warning")
    } finally {
      setIsSubmitting(false)
      setSubmittingAction(null)
      setTxProgress("")
    }
  }

  async function simulateTxPlan(plan: TxPlan, options: SimulateTxPlanOptions = {}): Promise<TxPlan> {
    if (!subjectAccount) return plan
    const requireAuth = Boolean(options.requireAuth && !customRpcEnabled)
    let authToken: string | null = requireAuth ? rpcAuthToken : null
    try {
      if (requireAuth && !authToken) authToken = await ensureRpcAuthTokenForCurrentWallet()
    } catch (error) {
      return {
        ...plan,
        simulation: {
          status: "failed",
          simulatedTxs: 0,
          message: readableRpcAuthError(error, t.agentAuthFailed, t, locale),
        },
      }
    }
    const client = createSafenetPublicClient({
      apiBaseUrl: resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL),
      authToken,
      rpcUrl: effectiveRpcUrl,
    })
    const txsToSimulate = txsSafeToSimulate(plan)
    try {
      for (const tx of txsToSimulate) {
        try {
          await client.call({
            account: subjectAccount,
            to: tx.to,
            data: tx.data,
            value: tx.value,
          })
        } catch (error) {
          throw new Error(
            `${translateTxLabel(tx.label, t)}: ${readableSimulationError(error, t.simulationFailed, t.requestRateLimited)}`,
          )
        }
      }
      return {
        ...plan,
        simulation: {
          status: txsToSimulate.length === plan.txs.length ? "passed" : "partial",
          simulatedTxs: txsToSimulate.length,
          message: txsToSimulate.length === plan.txs.length ? t.simulationPassed : t.simulationPartial,
        },
      }
    } catch (error) {
      return {
        ...plan,
        simulation: {
          status: "failed",
          simulatedTxs: 0,
          message: readableSimulationError(error, t.simulationFailed, t.requestRateLimited),
        },
      }
    }
  }

  function txsSafeToSimulate(plan: TxPlan) {
    const stakeIndex = plan.txs.findIndex((tx) => tx.label === "Stake SAFE to validator")
    if (stakeIndex <= 0) return plan.txs
    return plan.txs.slice(0, stakeIndex)
  }

  async function submitPlan(planOverride?: TxPlan, options: SubmitPlanOptions = {}) {
    const planToSubmit = planOverride ?? txPlan
    if (!planToSubmit) return
    if (!window.ethereum) {
      toast(t.noWallet, "warning")
      return
    }
    if (!account) {
      await connectWallet()
      return
    }
    if (!options.alreadySubmitting) {
      setIsSubmitting(true)
      setSubmittingAction(planToSubmit.action)
    }
    setTxProgress("")
    try {
      await ensureMainnet()
      if (!subjectAccount || !isTxPlanForAccount(planToSubmit, subjectAccount)) throw new Error(t.agentAccountChanged)
      const validation =
        options.skipValidation || planToSubmit.action === "agent-plan" ? null : validateAction(planToSubmit.action)
      if (validation) throw new Error(validation)
      if (!planToSubmit.simulation) throw new Error(t.connectToPlan)
      if (planToSubmit.simulation.status === "failed") throw new Error(planToSubmit.simulation.message)
      const client = createWalletClient({
        account,
        chain: ethereumMainnet,
        transport: custom(window.ethereum),
      })
      const requireAuth = Boolean(options.requireAuth && !customRpcEnabled)
      const authToken = requireAuth ? (rpcAuthToken ?? (await ensureRpcAuthTokenForCurrentWallet())) : null
      const publicClient = createSafenetPublicClient({
        apiBaseUrl: resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL),
        authToken,
        rpcUrl: effectiveRpcUrl,
      })
      const refreshedForExecution = await refreshLiveReads(subjectAccount, { forceRefresh: true })
      const liveSnapshotForExecution = refreshedForExecution?.snapshot ?? liveSnapshot
      if (!liveSnapshotForExecution) throw new Error(t.connectToPlan)
      const reconciled = reconcileTxPlanForExecution(planToSubmit, {
        cumulativeClaimed: liveSnapshotForExecution.cumulativeClaimed,
        stakingAllowance: liveSnapshotForExecution.stakingAllowance,
      })
      const executionAction = options.actionKey ?? planToSubmit.action
      if (!reconciled.plan) {
        const execution = createExecutionState(executionAction, planToSubmit.title, reconciled.steps, {
          status: "completed",
        })
        setTxExecution(execution)
        setTxPlan(planToSubmit)
        toast(t.executionCompletedTitle, "success")
        return
      }
      const executablePlan = {
        ...reconciled.plan,
        simulation: planToSubmit.simulation,
      }
      setTxPlan(executablePlan)
      setSafeMultisigPlan(null)
      setTxExecution(createExecutionState(executionAction, planToSubmit.title, reconciled.steps))
      let confirmedTxCount = 0
      if (!isSelfSubject(walletIdentity)) {
        const safeMode = await resolveSafeExecutionMode({ client: publicClient, safe: subjectAccount, signer: account })
        if (safeMode.kind === "not-owner") throw new Error(t.safeOwnerRequired)
        if (safeMode.kind === "multi-owner") {
          setSafeMultisigPlan(executablePlan)
          if (executablePlan.txs.length > 1 && !options.safeMultisigNoticeAccepted) {
            setPendingSafeMultisigNotice({
              actionKey: executionAction,
              plan: executablePlan,
              requireAuth: options.requireAuth === true,
              txCount: executablePlan.txs.length,
            })
            return
          }
          await submitSafeMultisigProposal({
            authToken: userSafeApiKey ? null : (rpcAuthToken ?? (await ensureRpcAuthTokenForCurrentWallet())),
            executionAction,
            executionSteps: reconciled.steps,
            plan: executablePlan,
            threshold: Number(safeMode.threshold),
          })
          return
        }
        try {
          confirmedTxCount = await submitSafeOwnerPlan({
            client,
            executionAction,
            executionSteps: reconciled.steps,
            publicClient,
            plan: executablePlan,
          })
        } finally {
          if (confirmedTxCount > 0) await refreshLiveReads(subjectAccount, { forceRefresh: true })
        }
        return
      }
      try {
        for (const tx of executablePlan.txs) {
          const label = translateTxLabel(tx.label, t)
          setTxExecution((current) =>
            current
              ? {
                  ...current,
                  currentLabel: label,
                }
              : current,
          )
          setTxProgress(`${t.simulationStatus}: ${label}`)
          try {
            await publicClient.call({
              account: subjectAccount,
              to: tx.to,
              data: tx.data,
              value: tx.value,
            })
          } catch (error) {
            throw new Error(`${label}: ${readableSimulationError(error, t.simulationFailed, t.requestRateLimited)}`)
          }
          setTxProgress(`${t.walletConfirmation}: ${label}`)
          const hash = await client.sendTransaction({
            account,
            to: tx.to,
            data: tx.data,
            value: tx.value,
          })
          toast(`${t.submittedTx} ${label}: ${compactAddress(hash, 10, 8)}`, "success")
          setTxProgress(`${t.confirmingTx}: ${label}`)
          const receipt = await publicClient.waitForTransactionReceipt({
            hash,
            pollingInterval: transactionReceiptPollingIntervalMs,
          })
          if (receipt.status !== "success") throw new Error(`${t.transactionFailed} ${label}`)
          confirmedTxCount += 1
          setTxExecution((current) =>
            current
              ? {
                  ...current,
                  completedCount: current.completedCount + 1,
                  currentLabel: label,
                  pendingCount: Math.max(0, current.pendingCount - 1),
                  steps: current.steps.map((step) =>
                    step.label === tx.label && step.status === "pending" ? { ...step, status: "done" } : step,
                  ),
                }
              : current,
          )
          toast(`${t.confirmedTx}: ${label}`, "success")
        }
        setTxExecution((current) =>
          current
            ? {
                ...current,
                currentLabel: null,
                pendingCount: 0,
                status: "completed",
              }
            : current,
        )
      } finally {
        if (confirmedTxCount > 0) await refreshLiveReads(subjectAccount, { forceRefresh: true })
      }
    } catch (error) {
      const rejected = isUserRejectedRequest(error)
      const message = readableRpcAuthError(
        error,
        readableSimulationError(error, t.transactionFailed, t.requestRateLimited),
        t,
        locale,
      )
      setTxExecution((current) => {
        if (!current) return current
        const nextSteps = [...current.steps]
        const pendingIndex = nextSteps.findIndex((step) => step.status === "pending")
        if (pendingIndex >= 0) {
          nextSteps[pendingIndex] = {
            ...nextSteps[pendingIndex],
            status: rejected ? "cancelled" : "failed",
          }
        }
        const pendingCount = nextSteps.filter((step) => step.status === "pending").length
        return {
          ...current,
          currentLabel: null,
          errorMessage: message,
          pendingCount,
          status: current.completedCount > 0 || current.skippedCount > 0 ? "partial" : "failed",
          steps: nextSteps,
          userRejected: rejected,
        }
      })
      toast(message, "warning")
    } finally {
      if (!options.alreadySubmitting) setIsSubmitting(false)
      if (!options.alreadySubmitting) setSubmittingAction(null)
      setTxProgress("")
    }
  }

  async function submitSafeMultisigProposal(params: {
    authToken: string | null
    executionAction: TxPlanAction | "claim-rewards-and-stake"
    executionSteps: ActionExecutionSummary["steps"]
    plan: TxPlan
    threshold: number
  }) {
    if (!account || !subjectAccount || !window.ethereum) throw new Error(t.agentAccountChanged)
    setTxProgress(t.safeProposalSubmitting)
    let result: Awaited<ReturnType<typeof submitSafeMultisigPlan>>
    try {
      result = await submitSafeMultisigPlan({
        origin: "Safecafe",
        authToken: params.authToken,
        plan: params.plan,
        provider: window.ethereum,
        rpcUrl: effectiveRpcUrl,
        safeAddress: subjectAccount,
        safeTxErrorMessages: {
          safe_api_key_invalid: t.safeApiKeyInvalid,
          safe_api_key_missing: t.safeApiKeyMissing,
          safe_tx_service_failed: t.safeTxServiceFailed,
          safe_tx_service_rate_limited: t.safeTxServiceRateLimited,
        },
        signer: account,
        userSafeApiKey,
      })
    } catch (error) {
      if (userSafeApiKey && isUserSafeApiKeyRejected(error)) {
        setUserSafeApiKey("")
        setUserSafeApiKeyDraft(userSafeApiKey)
        setUserSafeApiStatus("invalid")
        setUserSafeApiMessage(t.safeApiKeyInvalid)
        removeStorageValue(appStorageKeys.userSafeApiKey)
      }
      throw error
    }
    if (result.mode === "executed") {
      removeStoredSafeProposal()
      setSafeMultisigPlan(null)
      setTxExecution(
        createExecutionState(params.executionAction, params.plan.title, markSteps(params.executionSteps, "done"), {
          status: "completed",
        }),
      )
      toast(`${t.safeProposalExecuted}: ${compactAddress(result.safeTxHash, 10, 8)}`, "success")
      await refreshLiveReads(subjectAccount, { forceRefresh: true })
      return
    }
    const executionSteps = markCompletedSafeProposalSteps(params.executionSteps, result.completedTxs)
    const execution = createExecutionState(params.executionAction, params.plan.title, executionSteps, {
      errorMessage: t.safeProposalWaiting,
      status: "partial",
    })
    const nextExecution: ActionExecutionSummary = {
      ...execution,
      safeProposal: {
        confirmations: result.confirmations,
        safeAddress: subjectAccount,
        safeTxHash: result.safeTxHash,
        status: "pending",
        threshold: result.threshold || params.threshold,
        txIndex: result.txIndex,
        txLabel: result.txLabel,
      },
    }
    setTxExecution(nextExecution)
    writeStoredSafeProposal({
      execution: nextExecution,
      plan: params.plan,
      safeAddress: subjectAccount,
      signer: account,
    })
    toast(`${t.safeProposalCreated} (${result.confirmations}/${result.threshold || params.threshold})`, "success")
  }

  function continueSafeMultisigProposal() {
    if (!safeMultisigPlan) {
      toast(t.connectToPlan, "warning")
      return
    }
    const executionAction = txExecution?.action ?? safeMultisigPlan.action
    void submitPlan(safeMultisigPlan, {
      actionKey: executionAction,
      requireAuth: true,
      safeMultisigNoticeAccepted: true,
      skipValidation: true,
    })
  }

  async function submitSafeOwnerPlan(params: {
    client: ReturnType<typeof createWalletClient>
    executionAction: TxPlanAction | "claim-rewards-and-stake"
    executionSteps: ActionExecutionSummary["steps"]
    publicClient: ReturnType<typeof createSafenetPublicClient>
    plan: TxPlan
  }) {
    if (!account || !subjectAccount) throw new Error(t.agentAccountChanged)
    let confirmedTxCount = 0
    for (const tx of params.plan.txs) {
      const label = translateTxLabel(tx.label, t)
      setTxExecution((current) =>
        current
          ? {
              ...current,
              currentLabel: label,
            }
          : createExecutionState(params.executionAction, params.plan.title, params.executionSteps, {
              currentLabel: label,
            }),
      )
      setTxProgress(`${t.simulationStatus}: ${label}`)
      const safeTx = await buildSafeExecTransaction({
        client: params.publicClient,
        safe: subjectAccount,
        signer: account,
        tx,
      })
      try {
        await params.publicClient.call({
          account,
          to: safeTx.to,
          data: safeTx.data,
          value: safeTx.value,
        })
      } catch (error) {
        throw new Error(`${label}: ${readableSimulationError(error, t.simulationFailed, t.requestRateLimited)}`)
      }
      setTxProgress(`${t.safeExecDirect}: ${label}`)
      const hash = await params.client.sendTransaction({
        account,
        chain: ethereumMainnet,
        to: safeTx.to,
        data: safeTx.data,
        value: safeTx.value,
      })
      toast(`${t.submittedTx} ${label}: ${compactAddress(hash, 10, 8)}`, "success")
      setTxProgress(`${t.confirmingTx}: ${label}`)
      const receipt = await params.publicClient.waitForTransactionReceipt({
        hash,
        pollingInterval: transactionReceiptPollingIntervalMs,
      })
      if (receipt.status !== "success") throw new Error(`${t.transactionFailed} ${label}`)
      confirmedTxCount += 1
      setTxExecution((current) =>
        current
          ? {
              ...current,
              completedCount: current.completedCount + 1,
              currentLabel: label,
              pendingCount: Math.max(0, current.pendingCount - 1),
              steps: current.steps.map((step) =>
                step.label === tx.label && step.status === "pending" ? { ...step, status: "done" } : step,
              ),
            }
          : current,
      )
      toast(`${t.confirmedTx}: ${label}`, "success")
    }
    setTxExecution((current) =>
      current
        ? {
            ...current,
            currentLabel: null,
            pendingCount: 0,
            status: "completed",
          }
        : current,
    )
    return confirmedTxCount
  }

  function validateAction(
    targetAction = action,
    options: ExecuteActionOptions & {
      liveData?: RefreshedLiveAccountData | null
      skipChainCheck?: boolean
      skipRewardCheck?: boolean
    } = {},
  ): string | null {
    const snapshot = options.liveData?.snapshot ?? liveSnapshot
    const proof = options.liveData?.rewardProof ?? rewardProof
    const rewards = options.liveData?.rewards ?? liveRewards ?? 0n
    const merkleRoot = options.liveData?.health.merkleRoot ?? liveMerkleRoot
    if (!subjectAccount || !snapshot) return t.connectToPlan
    if (!options.skipChainCheck && chainId !== null && chainId !== CHAIN_ID) return t.wrongNetwork
    if (targetAction === "stake" || targetAction === "unstake") {
      const targetValidator = options.validator
        ? (findValidator(validators, options.validator) ?? selectedValidator)
        : selectedValidator
      const parsedAmount = safeParsedAmount(options.amount ?? amount)
      if (parsedAmount === null) return t.invalidAmount
      if (targetAction === "stake" && targetValidator.status !== "active") return t.inactiveValidator
      if (targetAction === "stake" && snapshot.safeBalance < parsedAmount) return t.insufficientSafeBalance
      if (targetAction === "unstake" && targetValidator.userStake < parsedAmount) return t.insufficientValidatorStake
    }
    if (targetAction === "claim-withdrawal" && summary.claimableWithdrawals <= 0n) return t.noClaimableWithdrawal
    if (targetAction === "claim-rewards" && !options.skipRewardCheck) {
      if (!proof?.proof || rewards <= 0n) return t.noProof
      if (merkleRoot && proof.merkleRoot.toLowerCase() !== merkleRoot.toLowerCase()) return t.merkleMismatch
    }
    return null
  }

  function selectAction(nextAction: Action) {
    const preferredValidator =
      nextAction === "claim-rewards" ? findPreferredRestakeValidator(validators) : findPreferredValidator(nextAction)
    if (preferredValidator && preferredValidator.address !== validator) {
      updateValidator(preferredValidator.address)
    }
    setAction(nextAction)
    if (
      nextAction === "stake" ||
      nextAction === "unstake" ||
      (nextAction === "claim-rewards" && activeNav === "dashboard")
    ) {
      updateDashboardAction(nextAction)
    }
    removeStoredSafeProposal()
    setPendingSafeMultisigNotice(null)
    setSafeMultisigPlan(null)
    setTxPlan(null)
    setTxExecution(null)
    if ((nextAction === "stake" || nextAction === "unstake") && window.location.pathname !== navPaths.dashboard) {
      setActiveNav("dashboard")
      window.history.pushState(null, "", navPaths.dashboard)
    }
  }
  function selectValidatorAction(nextValidator: Address, nextAction: Action) {
    const nextValidatorInfo = findValidator(validators, nextValidator)
    if (nextAction === "stake") {
      if (nextValidatorInfo?.status !== "active") {
        toast(t.inactiveValidator, "warning")
        return false
      }
    }
    if (nextAction === "unstake" && liveSnapshot && (nextValidatorInfo?.userStake ?? 0n) <= 0n) {
      toast(t.insufficientValidatorStake, "warning")
      return false
    }
    updateValidator(nextValidator)
    setAction(nextAction)
    if (nextAction === "stake" || nextAction === "unstake" || nextAction === "claim-rewards") {
      updateDashboardAction(nextAction)
    }
    removeStoredSafeProposal()
    setPendingSafeMultisigNotice(null)
    setSafeMultisigPlan(null)
    setTxPlan(null)
    setTxExecution(null)
    return true
  }

  function findPreferredValidator(targetAction: Action) {
    if (targetAction === "stake") {
      return selectedValidator.status === "active"
        ? selectedValidator
        : (validators.find((item) => item.status === "active") ?? null)
    }
    if (targetAction === "unstake") {
      return selectedValidator.userStake > 0n
        ? selectedValidator
        : (validators.find((item) => item.userStake > 0n) ?? null)
    }
    return null
  }

  function exportSafePayload(planOverride?: TxPlan) {
    const planToExport = planOverride ?? txPlan
    if (!planToExport) {
      toast(t.connectToPlan, "warning")
      return
    }
    if (subjectAccount && !isTxPlanForAccount(planToExport, subjectAccount)) {
      toast(t.agentAccountChanged, "warning")
      return
    }
    const payload = toSafeTransactionPayload(planToExport, CHAIN_ID, {
      description: "Generated by Safecafe. Review all transactions before signing.",
    })
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(stringifyBigInts(payload), null, 2)], { type: "application/json" }),
    )
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `safecafe-safe-tx-${Date.now()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    toast(t.exported, "success")
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      toast(t.copied, "success")
      return true
    } catch {
      toast(t.copyFailed, "warning")
      return false
    }
  }

  function openExplorer(address: Address) {
    window.open(`${EXPLORER_BASE_URL}/address/${address}`, "_blank", "noopener,noreferrer")
  }

  function renderTopbarStatus(variant: "desktop" | "mobile") {
    const isDesktop = variant === "desktop"
    return (
      <div className={`topbar-status ${isDesktop ? "desktop-topbar-status" : "mobile-topbar-status"}`}>
        <div className="language-menu-wrap" ref={isDesktop ? desktopLanguageMenuRef : mobileLanguageMenuRef}>
          <button
            ref={isDesktop ? desktopLanguageButtonRef : mobileLanguageButtonRef}
            type="button"
            className="language-pill"
            onClick={() => setIsLanguageMenuOpen((value) => !value)}
            aria-label={t.switchLanguage}
            aria-haspopup="menu"
            aria-expanded={isLanguageMenuOpen}
          >
            <Languages size={17} />
            <span>{activeLocale.shortLabel}</span>
            <ChevronDown size={14} />
          </button>
          {isLanguageMenuOpen && (
            <div className="language-menu" role="menu">
              {localeOptions.map((option) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.code === locale}
                  className={option.code === locale ? "active" : ""}
                  key={option.code}
                  onClick={() => selectLocale(option.code)}
                >
                  <span>{option.nativeLabel}</span>
                  <small>{option.label}</small>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          className="wallet-pill"
          disabled={walletBusy}
          aria-label={walletButtonAriaLabel}
          aria-haspopup={account ? "dialog" : undefined}
          onClick={() => (account ? setModal({ type: "wallet" }) : connectWallet())}
        >
          <Wallet size={18} />
          <span>
            <strong>{walletButtonLabel}</strong>
            <small>{walletButtonStatus}</small>
          </span>
          <ChevronDown size={16} />
        </button>
      </div>
    )
  }

  return (
    <div className="app-shell" data-layout-density={layoutDensity}>
      <header className="topbar">
        <div className="topbar-inner">
          <button
            type="button"
            className="brand"
            onClick={() => navigate("dashboard")}
            aria-label={`${t.appTitle} ${t.dashboard}`}
          >
            <div className="brand-mark">
              <svg viewBox="0 0 64 64" role="img" aria-label="Safecafe">
                <title>Safecafe</title>
                <path
                  className="brand-mark-shield"
                  d="M32 5 52 13v21.8c0 11.8-7.4 19.1-20 24.2-12.6-5.1-20-12.4-20-24.2V13L32 5Z"
                />
                <path
                  className="brand-mark-steam"
                  d="M24.5 25.8c-1.7-2 .8-3.2-.2-5.1M32 25.8c-1.7-2 .8-3.2-.2-5.1M39.5 25.8c-1.7-2 .8-3.2-.2-5.1"
                />
                <path
                  className="brand-mark-cup"
                  d="M20.5 31.8h22.3v9.5c0 5.2-4.2 9.4-9.4 9.4h-3.5c-5.2 0-9.4-4.2-9.4-9.4v-9.5Z"
                />
                <path className="brand-mark-handle" d="M42.8 35h2.4c3.1 0 5.3 2 5.3 4.8s-2.2 4.8-5.3 4.8h-2.4" />
                <path className="brand-mark-saucer" d="M18.5 54h27" />
              </svg>
            </div>
            <div>
              <strong>SAFECAFE</strong>
              <span>STAKING</span>
            </div>
          </button>

          <div className="mobile-header-actions">
            <button
              type="button"
              className="mobile-wallet-button"
              onClick={() => (account ? setModal({ type: "wallet" }) : connectWallet())}
              disabled={walletBusy}
              aria-label={walletButtonAriaLabel}
              aria-haspopup={account ? "dialog" : undefined}
            >
              <Wallet size={17} />
              <span>{walletPrimaryAccount ? compactAddress(walletPrimaryAccount, 5, 4) : walletButtonLabel}</span>
            </button>
            <button
              type="button"
              className="menu-button"
              onClick={() => setIsMenuOpen((value) => !value)}
              aria-expanded={isMenuOpen}
              aria-label={t.menu}
            >
              {isMenuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>

          <button
            type="button"
            className={`topbar-menu-backdrop ${isMenuOpen ? "open" : ""}`}
            aria-label={t.menu}
            onClick={() => setIsMenuOpen(false)}
          />

          <div className={`topbar-menu ${isMenuOpen ? "open" : ""}`}>
            <nav className="nav-tabs" aria-label={t.primaryNavigation}>
              {navItems.map((item) => {
                const Icon = navMeta[item].icon
                return (
                  <button
                    type="button"
                    className={activeNav === item ? "active" : ""}
                    key={item}
                    onClick={() => navigate(item)}
                  >
                    <Icon size={20} />
                    {t[item]}
                  </button>
                )
              })}
            </nav>

            {renderTopbarStatus("mobile")}
          </div>
          <span className="sidebar-version">Version {SAFECAFE_VERSION}</span>
        </div>
      </header>

      <main className="page">
        <div className="page-topline">
          <div className="page-title-block">
            <h1>{pageHeader.title}</h1>
            <p>{pageHeader.description}</p>
          </div>
          {renderTopbarStatus("desktop")}
          <div className="page-meta-row">
            {account && subjectAccount && (isReadingLive || liveDataMeta) && (
              <div
                className={`live-data-state ${isReadingLive ? "loading" : ""} ${
                  liveDataMeta?.source === "cache" ? "cached" : "fresh"
                }`}
                aria-live="polite"
              >
                <span className="live-data-state-main">
                  <strong>
                    <span className="desktop-long">{liveDataStatusText}</span>
                    <span className="mobile-short">Live</span>
                  </strong>
                </span>
                {liveDataUpdatedText && (
                  <small>
                    <span className="desktop-long">{liveDataUpdatedText}</span>
                    <span className="mobile-short">{liveDataUpdatedTimeText}</span>
                  </small>
                )}
                <button
                  type="button"
                  className="live-data-refresh-button"
                  disabled={isReadingLive || walletBusy}
                  onClick={forceRefreshLiveReads}
                  aria-label={t.forceRefreshLive}
                >
                  <RefreshCw size={13} className={isReadingLive ? "spin-icon" : ""} />
                </button>
              </div>
            )}
            <section className="summary-trust-strip" aria-label={t.trustVerification}>
              <span className="summary-trust-network">
                <ShieldCheck size={15} />
                <strong>
                  <span className="desktop-long">{t.chainIdentity}</span>
                  <span className="mobile-short">Eth 1</span>
                </strong>
              </span>
              <ExternalActionButton
                className="summary-contract-chip action-text-button"
                label={`${t.openExplorer} ${t.stakingContractShort}`}
                onOpen={() => openExplorer(CONTRACTS.staking)}
                size={12}
              >
                {t.stakingContractShort}
              </ExternalActionButton>
            </section>
            <button
              type="button"
              className={`summary-trust-proof ${trustBadgeTone}`}
              onClick={() => setModal({ type: "trust" })}
              aria-label={t.openTrustCenter}
            >
              <ShieldCheck size={13} />
              <span>
                <span className="desktop-long">{t.frontendProof}</span>
                <span className="mobile-short">ENS</span>
              </span>
              <small>
                <span className="desktop-long">{trustBadgeValue}</span>
                <span className="mobile-short">{trustBadgeMobileValue}</span>
              </small>
            </button>
          </div>
        </div>
        {activeNav === "dashboard" && (
          <section className="summary-card enter">
            {!account && (
              <div className="connect-panel">
                <Wallet size={20} />
                <div>
                  <strong>{walletStatus === "restoring" ? t.walletRestoring : t.connectWallet}</strong>
                  <small>{walletBusy ? t.reading : t.connectWalletHint}</small>
                </div>
                <button type="button" className="primary-button" disabled={walletBusy} onClick={connectWallet}>
                  {walletStatus === "connecting" ? t.walletConnecting : t.connectWallet}
                </button>
              </div>
            )}
            <div className="summary-grid">
              <article className="summary-position-card">
                <WalletCards className="summary-position-watermark" size={118} aria-hidden="true" />
                <span>{t.yourPosition}</span>
                <strong>{formattedTotalPosition} SAFE</strong>
                <em>{formattedTotalPositionUsd}</em>
                <div className="summary-position-split">
                  <div>
                    <small>
                      <i className="summary-dot summary-dot-staked" />
                      {t.staked}
                    </small>
                    <b>{formattedStakedPosition}</b>
                  </div>
                  <div>
                    <small>
                      <i className="summary-dot" />
                      {t.available}
                    </small>
                    <b>{formattedAvailablePosition}</b>
                  </div>
                </div>
              </article>
              <article className="summary-balance-card summary-claim-card">
                <span className="summary-card-icon">
                  <Gift />
                </span>
                <div>
                  <small>{t.claimableRewards}</small>
                  <strong>{formattedClaimableRewards}</strong>
                  <em>{formattedClaimableRewardsUsd}</em>
                </div>
              </article>
              <article className="summary-balance-card summary-earnings-card">
                <span className="summary-card-icon">
                  <TrendingUp />
                </span>
                <div>
                  <small>{t.estimatedEarnings}</small>
                  <strong>
                    {formatPercentOrDash(estimatedApyPercent)} <b>APY</b>
                  </strong>
                  <em>
                    {formattedAnnualRewards} {t.perYear}
                  </em>
                  <span>{t.estimatedAnnualRewards}</span>
                </div>
              </article>
            </div>
          </section>
        )}

        {activeNav === "dashboard" && (
          <DashboardView
            t={t}
            action={dashboardAction}
            actionPreview={dashboardActionPreview}
            amount={amount}
            accountReady={hasLiveAccountData}
            connectedAccount={connectedAccount}
            executeClaimRewardsAndStake={executeClaimRewardsAndStake}
            executeAction={executeAction}
            executionState={txExecution}
            isLoadingValidators={isLoadingValidators}
            isSubmitting={isSubmitting}
            restakePreview={rewardsRestakePreview}
            submittingAction={submittingAction}
            modal={modal}
            onConnect={refreshOrConnect}
            onContinueSafeProposal={continueSafeMultisigProposal}
            onCopySafeTxHash={(safeTxHash) => void copyText(safeTxHash)}
            onExportSafePayload={() => exportSafePayload(safeMultisigPlan ?? txPlan ?? undefined)}
            openExplorer={openExplorer}
            selectAction={selectAction}
            selectedValidator={selectedValidator}
            setActiveNav={navigate}
            setAmount={updateAmount}
            setModal={setModal}
            setValidator={updateValidator}
            showOnlyActive={showOnlyActive}
            txProgress={txProgress}
            validator={validator}
            visibleValidators={dashboardValidators}
            validators={dashboardValidators}
            setShowOnlyActive={updateShowOnlyActive}
            dataStatus={dataStatus}
            stakingAllowance={liveSnapshot?.stakingAllowance ?? 0n}
            summary={displaySummary}
            safePriceUsd={displaySafePriceUsd}
            txPlan={txPlan}
            decisionMetrics={decisionMetrics}
            validatorPoolTotal={validatorPoolTotal}
          />
        )}
        {activeNav === "validators" && (
          <FullPanel className="validators-panel">
            <ValidatorToolbar
              activeOnly={showOnlyActive}
              isLoading={isLoadingValidators}
              query={validatorQuery}
              setActiveOnly={updateShowOnlyActive}
              setQuery={updateValidatorQuery}
              setSort={updateValidatorSort}
              shownCount={displayValidators.length}
              sort={validatorSort}
              t={t}
              totalCount={validators.length}
              updatedBlock={liveBlock}
              validatorLoadError={validatorLoadError}
            />
            <ValidatorTable
              t={t}
              validators={displayValidators}
              totalStaked={validatorPoolTotal}
              accountReady={hasLiveAccountData}
              emptyMessage={
                validatorQuery || showOnlyActive ? t.noValidatorsMatched : validatorLoadError || t.validatorInfoFailed
              }
              isLoading={isLoadingValidators}
              setModal={setModal}
              openExplorer={openExplorer}
              safePriceUsd={displaySafePriceUsd}
              onStake={(nextValidator) => {
                openValidatorDashboardAction(nextValidator, "stake")
              }}
              onUnstake={(nextValidator) => {
                openValidatorDashboardAction(nextValidator, "unstake")
              }}
            />
          </FullPanel>
        )}
        {activeNav === "rewards" && (
          <RewardsView
            t={t}
            actionPreview={rewardsActionPreview}
            executionState={txExecution}
            executeClaimRewardsAndStake={executeClaimRewardsAndStake}
            executeAction={executeAction}
            isSubmitting={isSubmitting}
            onContinueSafeProposal={continueSafeMultisigProposal}
            onCopySafeTxHash={(safeTxHash) => void copyText(safeTxHash)}
            onExportSafePayload={() => exportSafePayload(safeMultisigPlan ?? txPlan ?? undefined)}
            restakePreview={rewardsRestakePreview}
            selectedValidator={selectedValidator}
            setValidator={updateValidator}
            submittingAction={submittingAction}
            summary={displaySummary}
            dataStatus={dataStatus}
            txPlan={txPlan}
            txProgress={txProgress}
            validators={validators}
          />
        )}
        {activeNav === "withdrawals" && (
          <WithdrawalsView
            t={t}
            executeAction={executeAction}
            isSubmitting={isSubmitting}
            submittingAction={submittingAction}
            summary={displaySummary}
            txPlan={txPlan}
            txProgress={txProgress}
            liveSnapshot={liveSnapshot}
          />
        )}
        {activeNav === "settings" && (
          <DocsView
            t={t}
            copyText={copyText}
            openExplorer={openExplorer}
            customRpcUrl={customRpcDraft}
            customRpcSavedUrl={customRpcUrl}
            customRpcStatus={customRpcStatus}
            customRpcMessage={customRpcMessage}
            onCustomRpcChange={updateCustomRpcDraft}
            onSaveCustomRpc={() => void saveCustomRpcUrl()}
            onClearCustomRpc={clearCustomRpcUrl}
            userSafeApiKeyDraft={userSafeApiKeyDraft}
            userSafeApiSaved={Boolean(userSafeApiKey)}
            userSafeApiStatus={userSafeApiStatus}
            userSafeApiMessage={userSafeApiMessage}
            onUserSafeApiKeyChange={updateUserSafeApiKeyDraft}
            onSaveUserSafeApiKey={saveUserSafeApiKey}
            onClearUserSafeApiKey={clearUserSafeApiKey}
            layoutDensity={layoutDensity}
            onLayoutDensityChange={selectLayoutDensity}
            userLlmDraft={userLlmDraft}
            userLlmSaved={Boolean(userLlmConfig)}
            userLlmStatus={userLlmStatus}
            userLlmMessage={userLlmMessage}
            onUserLlmChange={updateUserLlmDraft}
            onSaveUserLlm={saveUserLlmConfig}
            onClearUserLlm={clearUserLlmConfig}
          />
        )}
      </main>

      <footer className="footer">
        <button type="button" onClick={() => toast(`Safecafe v${SAFECAFE_VERSION}`, "info")}>
          Safecafe v{SAFECAFE_VERSION}
        </button>
        <span>{t.footerTagline}</span>
        <button type="button" onClick={() => navigate("settings")}>
          {t.docsTitle}
        </button>
      </footer>

      {modal && (
        <DetailModal
          account={account}
          subjectAccount={subjectAccount}
          subjectKind={walletIdentity.subjectKind}
          discoveredSafes={discoveredSafes}
          safeDiscoveryError={safeDiscoveryError}
          safeDiscoveryStatus={safeDiscoveryStatus}
          copyText={copyText}
          dataStatus={dataStatus}
          disconnectWallet={disconnectWallet}
          modal={modal}
          onClose={() => setModal(null)}
          openExplorer={openExplorer}
          releaseTrust={releaseTrust}
          onRefreshSubject={(subject) => {
            const nextSubject = normalizeAddress(subject)
            if (!account || !nextSubject || nextSubject.toLowerCase() === account.toLowerCase()) {
              toast(t.invalidSafeAccount, "warning")
              return
            }
            const identity = createWalletIdentity(account, nextSubject)
            selectStakingSubject(identity, { refresh: true })
            setModal(null)
          }}
          onUseSignerAsSubject={() => {
            if (!account) return
            const identity = createWalletIdentity(account)
            selectStakingSubject(identity, { refresh: true })
            setModal(null)
          }}
          t={t}
        />
      )}
      {pendingSafeMultisigNotice && (
        <ConfirmDialog
          cancelLabel={t.closeDialog}
          confirmLabel={t.safeProposalContinue}
          message={t.safeMultisigFlowNoticeBody.replace("{count}", pendingSafeMultisigNotice.txCount.toString())}
          onCancel={() => setPendingSafeMultisigNotice(null)}
          onConfirm={() => {
            const pending = pendingSafeMultisigNotice
            setPendingSafeMultisigNotice(null)
            void submitPlan(pending.plan, {
              actionKey: pending.actionKey,
              requireAuth: pending.requireAuth,
              safeMultisigNoticeAccepted: true,
              skipValidation: true,
            })
          }}
          title={t.safeMultisigFlowNoticeTitle}
        />
      )}
      <Toaster
        closeButton
        richColors
        expand={false}
        visibleToasts={3}
        duration={toastDurationMs}
        gap={4}
        position="top-right"
        offset={{ top: 24, right: 24 }}
        mobileOffset={{ top: 24, left: 16, right: 16 }}
        containerAriaLabel={t.notification}
        toastOptions={{
          closeButtonAriaLabel: t.closeNotification,
        }}
      />
      <AgentLauncher
        t={t}
        context={agentContext}
        executionState={txExecution}
        isSubmitting={isSubmitting}
        txProgress={txProgress}
        userLlmConfig={userLlmConfig}
        rpcAuthToken={rpcAuthToken}
        onAuthenticateAgent={authenticateAgent}
        onConnectWallet={connectWallet}
        onSimulatePlan={(plan) => simulateTxPlan(plan, { requireAuth: true })}
        onOpen={() => setModal(null)}
        onRefreshLiveData={refreshLiveDataForAgent}
        onSubmitPlan={(plan) => submitPlan(plan, { requireAuth: true })}
        onContinueSafeProposal={continueSafeMultisigProposal}
        onCopySafeTxHash={(safeTxHash) => void copyText(safeTxHash)}
        onExportSafePayload={() => exportSafePayload(safeMultisigPlan ?? txPlan ?? undefined)}
      />
    </div>
  )
}

const liveReadCache = new Map<string, Promise<LiveReadResult>>()

class ApiResponseError extends Error {
  readonly code?: string
  readonly resetAt?: string
  readonly status: number

  constructor(status: number, message: string, options: { code?: string; resetAt?: string } = {}) {
    super(message)
    this.name = "ApiResponseError"
    this.status = status
    this.code = options.code
    this.resetAt = options.resetAt
  }
}

async function readLiveData(
  account: Address,
  options: { forceRefresh?: boolean } = {},
  customRpcUrl?: string,
): Promise<LiveReadResult> {
  if (customRpcUrl) return readLiveDataFromCustomRpc(account, customRpcUrl)
  const cacheKey = `${account.toLowerCase()}:account-live:${options.forceRefresh ? "refresh" : "cached"}`
  const cached = liveReadCache.get(cacheKey)
  if (cached) return cached

  const request = (async () => {
    const params = new URLSearchParams({ account })
    if (options.forceRefresh) params.set("refresh", "true")
    const response = await fetch(apiUrl(`/api/account/live?${params.toString()}`, import.meta.env.VITE_API_BASE_URL), {
      cache: "no-store",
    })
    if (!response.ok) {
      const error = await readLiveDataError(response)
      throw new ApiResponseError(response.status, error.message, error)
    }
    return parseLiveReadResult(await response.json())
  })()

  liveReadCache.set(cacheKey, request)
  try {
    return await request
  } catch (error) {
    if (!shouldFallbackToDirectLiveRead(error)) throw error
    console.warn("Safecafe read API unavailable, falling back to direct public RPC reads:", error)
    return readLiveDataFromCustomRpc(account)
  } finally {
    liveReadCache.delete(cacheKey)
  }
}

function shouldFallbackToDirectLiveRead(error: unknown) {
  if (error instanceof ApiResponseError) {
    return error.status === 404 || error.status === 405 || error.status >= 500
  }
  return error instanceof TypeError || error instanceof SyntaxError
}

async function readLiveDataFromCustomRpc(account: Address, rpcUrl?: string): Promise<LiveReadResult> {
  const client = createSafenetPublicClient(rpcUrl ? { rpcUrl } : undefined)
  const [snapshot, health, validatorMetadata, rewardProofResult] = await Promise.all([
    readAccountSnapshot(client, account),
    readHealth(client),
    fetchValidators(undefined, { fallback: true }),
    fetchRewardProof(account)
      .then((proof) => ({ proof, status: proof ? ("available" as const) : ("missing" as const) }))
      .catch(() => ({ proof: null, status: "unavailable" as const })),
  ])
  const validatorsWithPositions = await readValidatorPositions(client, account, validatorMetadata)
  const rewards = calculateClaimableRewards(rewardProofResult.proof, snapshot.cumulativeClaimed)
  return {
    health,
    rewardProof: rewardProofResult.proof,
    rewardProofStatus: rewardProofResult.status,
    rewards,
    snapshot,
    validatorsWithPositions,
  }
}

function calculateClaimableRewards(proof: RewardProof | null, cumulativeClaimed: bigint) {
  if (!proof) return 0n
  const cumulativeAmount = BigInt(proof.cumulativeAmount)
  return cumulativeAmount > cumulativeClaimed ? cumulativeAmount - cumulativeClaimed : 0n
}

async function readLiveDataError(response: Response) {
  try {
    const body = (await response.json()) as {
      code?: unknown
      error?: unknown
      requestId?: unknown
      resetAt?: unknown
    }
    const message = typeof body.error === "string" ? body.error : `Account live API failed: ${response.status}`
    const code = typeof body.code === "string" ? body.code : undefined
    const requestId = typeof body.requestId === "string" ? body.requestId : response.headers.get("x-request-id")
    return {
      code,
      message: [message, code ? `(${code})` : "", requestId ? `request ${requestId}` : ""].filter(Boolean).join(" "),
      resetAt: typeof body.resetAt === "string" ? body.resetAt : undefined,
    }
  } catch {
    return { message: `Account live API failed: ${response.status}` }
  }
}

function formatLiveDataTimestamp(fetchedAt: number, locale: Locale) {
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(fetchedAt))
  } catch {
    return new Date(fetchedAt).toLocaleTimeString()
  }
}

function formatLiveDataCompactTimestamp(fetchedAt: number, locale: Locale) {
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(fetchedAt))
  } catch {
    return new Date(fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }
}

async function fetchOwnedSafesWithMetadata(owner: Address, signal?: AbortSignal): Promise<DiscoveredSafe[]> {
  const params = new URLSearchParams({ owner })
  const response = await fetch(apiUrl(`/api/safes?${params.toString()}`, import.meta.env.VITE_API_BASE_URL), {
    cache: "no-store",
    signal,
  })
  if (!response.ok) throw new Error(await readApiError(response, "Safe discovery failed"))
  const data = (await response.json()) as { safes?: unknown }
  if (!Array.isArray(data.safes)) return []
  return data.safes.map(parseDiscoveredSafe).filter((safe): safe is DiscoveredSafe => Boolean(safe))
}

async function fetchSafeMetadata(address: Address, signal?: AbortSignal): Promise<DiscoveredSafe> {
  const params = new URLSearchParams({ safe: address })
  const response = await fetch(apiUrl(`/api/safes?${params.toString()}`, import.meta.env.VITE_API_BASE_URL), {
    cache: "no-store",
    signal,
  })
  if (!response.ok) throw new Error(await readApiError(response, "Safe discovery failed"))
  const data = (await response.json()) as { safe?: unknown }
  return parseDiscoveredSafe(data.safe) ?? emptyDiscoveredSafe(address)
}

async function fetchValidatorProtocolData(): Promise<{ validators: ValidatorInfo[]; withdrawDelay: bigint }> {
  const response = await fetch(apiUrl("/api/validators", import.meta.env.VITE_API_BASE_URL), { cache: "no-store" })
  if (!response.ok) throw new Error(await readApiError(response, "Validator metadata failed"))
  const data = (await response.json()) as { validators?: unknown; withdrawDelay?: unknown }
  return {
    validators: Array.isArray(data.validators)
      ? data.validators.map(parseValidatorInfo).filter((validator): validator is ValidatorInfo => Boolean(validator))
      : [],
    withdrawDelay: toBigInt(data.withdrawDelay),
  }
}

function parseValidatorInfo(value: unknown): ValidatorInfo | null {
  if (!value || typeof value !== "object") return null
  const record = value as Partial<ValidatorInfo>
  const address = normalizeAddress(record.address)
  if (!address || typeof record.label !== "string") return null
  return {
    address,
    label: record.label,
    status: record.status === "inactive" ? "inactive" : "active",
    commission: typeof record.commission === "number" && Number.isFinite(record.commission) ? record.commission : 0,
    participationRate:
      typeof record.participationRate === "number" && Number.isFinite(record.participationRate)
        ? record.participationRate
        : 0,
    totalStake: toBigInt(record.totalStake),
    userStake: toBigInt(record.userStake),
  }
}

function parseDiscoveredSafe(value: unknown): DiscoveredSafe | null {
  const address = normalizeAddress(typeof value === "string" ? value : (value as { address?: unknown } | null)?.address)
  if (!address) return null
  if (!value || typeof value !== "object") return emptyDiscoveredSafe(address)
  const ownersCount = safeNumberOrNull((value as { ownersCount?: unknown }).ownersCount)
  const threshold = safeNumberOrNull((value as { threshold?: unknown }).threshold)
  return { address, ownersCount, threshold }
}

function safeNumberOrNull(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

async function readApiError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { code?: unknown; error?: unknown; requestId?: unknown }
    const message = typeof body.error === "string" ? body.error : `${fallback}: ${response.status}`
    const code = typeof body.code === "string" ? body.code : ""
    const requestId = typeof body.requestId === "string" ? body.requestId : response.headers.get("x-request-id")
    return [message, code ? `(${code})` : "", requestId ? `request ${requestId}` : ""].filter(Boolean).join(" ")
  } catch {
    return `${fallback}: ${response.status}`
  }
}

function emptyDiscoveredSafe(address: Address): DiscoveredSafe {
  return {
    address,
    ownersCount: null,
    threshold: null,
  }
}

function mergeDiscoveredSafes(
  currentSafes: DiscoveredSafe[],
  nextSafes: DiscoveredSafe[],
  selectedSafe?: Address | null,
): DiscoveredSafe[] {
  const merged = new Map<string, DiscoveredSafe>()
  const selectedKey = selectedSafe?.toLowerCase()
  for (const safe of currentSafes) {
    if (!selectedKey || safe.address.toLowerCase() === selectedKey) merged.set(safe.address.toLowerCase(), safe)
  }
  for (const safe of nextSafes) {
    const key = safe.address.toLowerCase()
    const existing = merged.get(key)
    merged.set(key, preferSafeWithMetadata(existing, safe))
  }
  return [...merged.values()].sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()))
}

function preferSafeWithMetadata(current: DiscoveredSafe | undefined, next: DiscoveredSafe): DiscoveredSafe {
  if (!current) return next
  if (hasSafeMultisigMetadata(current) && !hasSafeMultisigMetadata(next)) return current
  if (!hasSafeMultisigMetadata(current) && !hasSafeMultisigMetadata(next)) return current
  return next
}

function hasSafeMultisigMetadata(safe: DiscoveredSafe) {
  return safe.threshold !== null && safe.ownersCount !== null
}

function isSameAddress(a: Address, b: Address) {
  return a.toLowerCase() === b.toLowerCase()
}

function summaryFromSnapshot(snapshot: AccountSnapshot, rewards: bigint): AccountSummary {
  const pendingWithdrawals = snapshot.pendingWithdrawals.reduce((sum, item) => sum + item.amount, 0n)
  const now = BigInt(Math.floor(Date.now() / 1000))
  const { amount: nextAmount, claimableAt: nextClaimableAt } = snapshot.nextClaimableWithdrawal
  return {
    safeBalance: snapshot.safeBalance,
    totalStaked: snapshot.totalStaked,
    pendingWithdrawals,
    claimableWithdrawals: nextClaimableAt <= now ? nextAmount : 0n,
    claimableRewards: rewards,
    withdrawDelay: snapshot.withdrawDelay,
  }
}

function mergeValidatorMetadata(metadata: ValidatorInfo[], current: ValidatorInfo[]): ValidatorInfo[] {
  const positionsByAddress = new Map(current.map((validator) => [validator.address.toLowerCase(), validator]))
  return metadata.map((validator) => {
    const currentValidator = positionsByAddress.get(validator.address.toLowerCase())
    return currentValidator
      ? {
          ...validator,
          totalStake: currentValidator.totalStake,
          userStake: currentValidator.userStake,
        }
      : validator
  })
}

function clearValidatorPosition(validator: ValidatorInfo): ValidatorInfo {
  return {
    ...validator,
    totalStake: 0n,
    userStake: 0n,
  }
}

function readToastDurationMs(value: unknown) {
  if (typeof value !== "string" || value.trim() === "") return defaultToastDurationMs
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 500 ? parsed : defaultToastDurationMs
}

function calculateSafenetBetaApyPercent(totalStaked: bigint, nowMs = Date.now()) {
  if (nowMs < safenetBetaRewardStartMs || nowMs >= safenetBetaRewardEndMs || totalStaked <= 0n) return null
  const rewardDurationMs = safenetBetaRewardEndMs - safenetBetaRewardStartMs
  if (rewardDurationMs <= 0) return null
  const apyBps = (safenetBetaRewardTotal * 10_000n * BigInt(msPerYear)) / (totalStaked * BigInt(rewardDurationMs))
  return Number(apyBps) / 100
}

function calculateEstimatedAnnualRewards(totalStaked: bigint, apyPercent: number | null) {
  if (apyPercent === null) return null
  return (totalStaked * BigInt(Math.round(apyPercent * 100))) / 10_000n
}

function formatPercentOrDash(value: number | null) {
  return value === null ? "-" : `${value.toFixed(2)}%`
}

type SerializedTxPlan = {
  account?: string
  action: string
  simulation?: { message: string; simulatedTxs: number; status: string }
  title: string
  txs: Array<{ data: string; label: string; to: string; value: string }>
  warnings: string[]
}

type StoredSafeProposal = {
  execution: ActionExecutionSummary
  plan: SerializedTxPlan
  safeAddress: string
  savedAt: number
  signer: string
  version: 1
}

function writeStoredSafeProposal(input: {
  execution: ActionExecutionSummary
  plan: TxPlan
  safeAddress: Address
  signer: Address
}) {
  writeStorageJson(appStorageKeys.safeProposal, {
    execution: input.execution,
    plan: serializeTxPlan(input.plan),
    safeAddress: input.safeAddress,
    savedAt: Date.now(),
    signer: input.signer,
    version: 1,
  } satisfies StoredSafeProposal)
}

function readStoredSafeProposal(signer: Address, safeAddress: Address) {
  return readStorageJson(appStorageKeys.safeProposal, (value) => {
    const record = typeof value === "object" && value !== null ? (value as Partial<StoredSafeProposal>) : null
    if (record?.version !== 1) return null
    const storedSigner = normalizeAddress(record.signer)
    const storedSafe = normalizeAddress(record.safeAddress)
    if (!storedSigner || !storedSafe) return null
    if (!isSameAddress(storedSigner, signer) || !isSameAddress(storedSafe, safeAddress)) return null
    const plan = readSerializedTxPlan(record.plan)
    const execution = readStoredExecution(record.execution, storedSafe)
    if (!plan || !execution) return null
    return { execution, plan }
  })
}

function removeStoredSafeProposal() {
  removeStorageValue(appStorageKeys.safeProposal)
}

function serializeTxPlan(plan: TxPlan): SerializedTxPlan {
  return {
    account: plan.account,
    action: plan.action,
    simulation: plan.simulation,
    title: plan.title,
    txs: plan.txs.map((tx) => ({
      data: tx.data,
      label: tx.label,
      to: tx.to,
      value: tx.value.toString(),
    })),
    warnings: plan.warnings,
  }
}

function readSerializedTxPlan(value: unknown): TxPlan | null {
  const record = typeof value === "object" && value !== null ? (value as Partial<SerializedTxPlan>) : null
  if (!record || !isTxPlanAction(record.action) || typeof record.title !== "string") return null
  const account = record.account ? normalizeAddress(record.account) : undefined
  if (record.account && !account) return null
  const txs = Array.isArray(record.txs)
    ? record.txs.flatMap((tx) => {
        const item = typeof tx === "object" && tx !== null ? tx : null
        if (!item) return []
        const { data, label, to, value } = item as Partial<SerializedTxPlan["txs"][number]>
        const address = normalizeAddress(to)
        if (typeof label !== "string" || !address || typeof data !== "string" || !isHex(data)) return []
        try {
          return [{ data: data as Hex, label, to: address, value: BigInt(value ?? "") }]
        } catch {
          return []
        }
      })
    : []
  if (txs.length === 0 || txs.length !== record.txs?.length) return null
  return {
    account: account ?? undefined,
    action: record.action,
    simulation: readStoredSimulation(record.simulation),
    title: record.title,
    txs,
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((item) => typeof item === "string") : [],
  }
}

function readStoredExecution(value: unknown, safeAddress: Address): ActionExecutionSummary | null {
  const record = typeof value === "object" && value !== null ? (value as Partial<ActionExecutionSummary>) : null
  if (!record || !isExecutionAction(record.action) || !isExecutionStatus(record.status)) return null
  const steps = Array.isArray(record.steps)
    ? record.steps.flatMap((step) => {
        const item =
          typeof step === "object" && step !== null
            ? (step as { id?: unknown; label?: unknown; status?: unknown })
            : null
        return item &&
          typeof item.id === "string" &&
          typeof item.label === "string" &&
          isExecutionStepStatus(item.status)
          ? [{ id: item.id, label: item.label, status: item.status }]
          : []
      })
    : []
  const proposal = readStoredSafeProposalSummary(record.safeProposal, safeAddress)
  if (steps.length === 0 || !proposal) return null
  return {
    action: record.action,
    actionKey: record.action,
    completedCount: Number(record.completedCount) || 0,
    currentLabel: typeof record.currentLabel === "string" ? record.currentLabel : null,
    errorMessage: typeof record.errorMessage === "string" ? record.errorMessage : "",
    pendingCount: Number(record.pendingCount) || 0,
    safeProposal: proposal,
    skippedCount: Number(record.skippedCount) || 0,
    status: record.status,
    steps,
    title: typeof record.title === "string" ? record.title : "",
    userRejected: record.userRejected === true,
  }
}

function readStoredSafeProposalSummary(
  value: unknown,
  expectedSafeAddress: Address,
): ActionExecutionSummary["safeProposal"] | null {
  const record =
    typeof value === "object" && value !== null
      ? (value as Partial<NonNullable<ActionExecutionSummary["safeProposal"]>>)
      : null
  if (!record) return null
  const safeAddress = normalizeAddress(record.safeAddress)
  if (!safeAddress || !isSameAddress(safeAddress, expectedSafeAddress)) return null
  if (typeof record.safeTxHash !== "string" || !isHex(record.safeTxHash)) return null
  return {
    confirmations: Number(record.confirmations) || 0,
    safeAddress,
    safeTxHash: record.safeTxHash,
    status: record.status === "executed" ? "executed" : "pending",
    threshold: Number(record.threshold) || 0,
    txIndex: Number.isSafeInteger(record.txIndex) ? record.txIndex : undefined,
    txLabel: typeof record.txLabel === "string" ? record.txLabel : undefined,
  }
}

function readStoredSimulation(value: unknown): TxPlan["simulation"] {
  const record =
    typeof value === "object" && value !== null ? (value as Partial<NonNullable<TxPlan["simulation"]>>) : null
  if (!record || !isSimulationStatus(record.status) || typeof record.message !== "string") return undefined
  return {
    message: record.message,
    simulatedTxs: Number(record.simulatedTxs) || 0,
    status: record.status,
  }
}

function isTxPlanAction(value: unknown): value is TxPlanAction {
  return (
    value === "stake" ||
    value === "unstake" ||
    value === "claim-withdrawal" ||
    value === "claim-rewards" ||
    value === "agent-plan"
  )
}

function isExecutionAction(value: unknown): value is ActionExecutionSummary["action"] {
  return isTxPlanAction(value) || value === "claim-rewards-and-stake"
}

function isExecutionStatus(value: unknown): value is ActionExecutionSummary["status"] {
  return value === "completed" || value === "failed" || value === "partial"
}

function isExecutionStepStatus(value: unknown): value is ActionExecutionSummary["steps"][number]["status"] {
  return value === "cancelled" || value === "done" || value === "failed" || value === "pending" || value === "skipped"
}

function isSimulationStatus(value: unknown): value is NonNullable<TxPlan["simulation"]>["status"] {
  return value === "failed" || value === "partial" || value === "passed"
}

function readStoredUserLlmConfig(): UserLlmConfig | null {
  return readStorageJson(appStorageKeys.userLlmConfig, (value) => {
    const record = typeof value === "object" && value !== null ? (value as Partial<UserLlmConfig>) : null
    if (!record) return null
    const apiBase = typeof record.apiBase === "string" ? record.apiBase.trim() : ""
    const apiKey = typeof record.apiKey === "string" ? record.apiKey : ""
    const model = typeof record.model === "string" ? record.model.trim() : ""
    const maxTokens = readUserLlmMaxTokens(String(record.maxTokens ?? defaultUserLlmMaxTokens))
    if (!apiBase || !apiKey || !model) return null
    try {
      if (!isAllowedUserLlmApiBase(new URL(apiBase))) return null
    } catch {
      return null
    }
    return { apiBase, apiKey, maxTokens, model }
  })
}

function createUserLlmDraft(config: UserLlmConfig | null): UserLlmDraft {
  return {
    apiBase: config?.apiBase ?? "",
    apiKey: "",
    maxTokens: String(config?.maxTokens ?? defaultUserLlmMaxTokens),
    model: config?.model ?? "",
  }
}

function readUserLlmMaxTokens(value: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) return defaultUserLlmMaxTokens
  return Math.min(4_000, Math.max(64, parsed))
}

async function verifyCustomRpcUrl(candidate: string, t: MessageBundle) {
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(t.customRpcInvalidUrl)
  }
  if (!isAllowedCustomRpcUrl(parsed)) throw new Error(t.customRpcInvalidUrl)
  const client = createSafenetPublicClient({ rpcUrl: candidate })
  const nextChainId = await client.getChainId()
  if (nextChainId !== CHAIN_ID) throw new Error(t.customRpcWrongChain)
  await client.getBlockNumber()
}

function isAllowedCustomRpcUrl(url: URL) {
  if (url.protocol === "https:") return true
  if (url.protocol !== "http:") return false
  return isLoopbackHostname(url.hostname)
}

async function verifyUserLlmConfig(config: UserLlmConfig, t: MessageBundle) {
  try {
    const response = await fetch(`${config.apiBase.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        max_tokens: 8,
        messages: [{ role: "user", content: "ping" }],
      }),
    })
    if (!response.ok) throw new Error(`${t.userLlmVerifyFailed} (${response.status})`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(t.userLlmVerifyFailed)) throw error
    throw new Error(t.userLlmVerifyFailed)
  }
}

function isAllowedUserLlmApiBase(url: URL) {
  if (url.protocol === "https:") return true
  if (url.protocol !== "http:") return false
  return isLoopbackHostname(url.hostname)
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase()
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]"
}
