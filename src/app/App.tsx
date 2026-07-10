import {
  ArrowDownToLine,
  ChevronDown,
  Database,
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
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast as sonnerToast, Toaster } from "sonner"
import { type Address, createWalletClient, custom } from "viem"
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
import { SAFECAFE_VERSION } from "../shared/version"
import { AgentLauncher } from "./AgentLauncher"
import { DetailModal } from "./DetailModal"
import { readableSimulationError, safeParsedAmount, stringifyBigInts, translateTxLabel } from "./formatters"
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
  type Modal,
  type NavItem,
  navItems,
  type SafePriceState,
} from "./types"
import { ExternalActionButton, FullPanel, Metric } from "./ui"
import { compareBigintDesc, findPreferredRestakeValidator } from "./validatorSelection"
import { DashboardView, DocsView, RewardsView, ValidatorTable, ValidatorToolbar, WithdrawalsView } from "./views"
import { createWalletIdentity, isSelfSubject, normalizeAddress } from "./walletIdentity"

const navPaths = createPathMap(navItems)
type ValidatorSort = "stake" | "participation" | "commission" | "name" | "yourStake"
type WalletStatus = "idle" | "restoring" | "connecting" | "connected"
type CustomRpcStatus = "checking" | "idle" | "invalid" | "valid"
type UserSafeApiStatus = "checking" | "idle" | "invalid" | "valid"
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
  skipValidation?: boolean
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

export function App() {
  const [locale, setLocale] = useState<Locale>(() => {
    const saved = readStorageText(appStorageKeys.locale)
    if (isLocale(saved)) return saved
    return detectLocale(navigator.language)
  })
  const [activeNav, setActiveNav] = useState<NavItem>(() => navFromPath(window.location.pathname))
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isLanguageMenuOpen, setIsLanguageMenuOpen] = useState(false)
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
    readStorageText(appStorageKeys.userSafeApiKey)?.trim() ? "valid" : "idle",
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
  const customRpcEnabled = customRpcStatus === "valid" && Boolean(customRpcUrl.trim())
  const effectiveRpcUrl = customRpcEnabled ? customRpcUrl.trim() : import.meta.env.VITE_RPC_URL
  const releaseRecord = releaseTrust.record
  const releaseCid = releaseRecord?.ipfs?.cid
  const trustBadgeTone =
    releaseTrust.kind === "record" && !releaseRecord?.dirty && releaseTrust.ens.status === "matched"
      ? "verified"
      : "review"
  const trustBadgeValue =
    releaseTrust.kind === "loading" || releaseTrust.ens.status === "loading"
      ? t.reading
      : releaseTrust.kind !== "record"
        ? t.notChecked
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
  const walletBusy = walletStatus === "restoring" || walletStatus === "connecting"
  const walletButtonLabel = account
    ? compactAddress(account, 6, 4)
    : walletStatus === "restoring"
      ? t.walletRestoring
      : walletStatus === "connecting"
        ? t.walletConnecting
        : t.connectWallet
  const walletButtonStatus = account ? t.connected : walletBusy ? t.reading : t.notConnected
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
  const displaySummary = hasLiveAccountData ? summary : emptySummary
  const displayValidators = visibleValidators
  const displaySafePriceUsd = safePrice.usd
  const activeValidatorCount = useMemo(() => validators.filter((item) => item.status === "active").length, [validators])
  const estimatedApyPercent = calculateSafenetBetaApyPercent(validatorPoolTotal)
  const estimatedAnnualRewards = hasLiveAccountData
    ? calculateEstimatedAnnualRewards(summary.totalStaked, estimatedApyPercent)
    : null
  const decisionMetrics = {
    activeValidatorCount,
    apyPercent: estimatedApyPercent,
    estimatedAnnualRewards,
    protocolTvlUsd: formatUsdFromSafe(validatorPoolTotal, displaySafePriceUsd),
    validatorPoolTotal,
    withdrawDelay: summary.withdrawDelay || liveSnapshot?.withdrawDelay || 0n,
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
    if (!stakingAccount || walletIdentity.subjectKind !== "safe") return false
    const selectedSafe = discoveredSafes.find((safe) => isSameAddress(safe.address, stakingAccount))
    return Boolean(selectedSafe && hasSafeMultisigMetadata(selectedSafe))
  }, [discoveredSafes, stakingAccount, walletIdentity.subjectKind])
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

  const updateAmount = useCallback((nextAmount: string) => {
    setAmount(nextAmount)
    setSafeMultisigPlan(null)
    setTxPlan(null)
    setTxExecution(null)
  }, [])

  const updateValidator = useCallback((nextValidator: Address) => {
    setValidator(nextValidator)
    writeStorageAddress(appStorageKeys.selectedValidator, nextValidator)
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
    fetchValidatorMetadata()
      .then((items: ValidatorInfo[]) => {
        setValidatorStakeError("")
        setValidators((current) => {
          const merged = mergeValidatorMetadata(items, current)
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
        const message = error instanceof Error ? error.message : t.liveDataFailed
        const fallbackMessage = cached ? `${t.liveDataRefreshFailedCached} ${message}` : message
        setLiveError(fallbackMessage)
        toast(fallbackMessage, "warning")
        return cached?.data ?? null
      } finally {
        if (liveReadRequestId.current === requestId) setIsReadingLive(false)
      }
    },
    [
      applyLiveReadResult,
      customRpcEnabled,
      effectiveRpcUrl,
      subjectAccount,
      t.connectToLoad,
      t.liveDataFailed,
      t.liveDataRefreshFailedCached,
      toast,
    ],
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
          await refreshLiveReadsRef.current?.(identity.subject)
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
        void refreshLiveReadsRef.current?.(identity.subject)
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
          if (first) void refreshLiveReadsRef.current?.(identity.subject)
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
  }, [resetLiveAccountState, selectStakingSubject])

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
    const nextValidatorInfo = findValidator(validators, nextValidator)
    const actionLabel = nextAction === "stake" ? t.prepareStakeAction : t.prepareUnstakeAction
    toast(
      t.validatorActionPrepared
        .replace("{action}", actionLabel)
        .replace("{validator}", nextValidatorInfo?.label ?? compactAddress(nextValidator)),
      "info",
    )
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
      toast(error instanceof Error ? error.message : t.agentAuthFailed, "warning")
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

  async function saveUserSafeApiKey() {
    const candidate = userSafeApiKeyDraft.trim() || userSafeApiKey
    if (!candidate) {
      setUserSafeApiStatus("invalid")
      setUserSafeApiMessage(t.userSafeApiKeyRequired)
      toast(t.userSafeApiKeyRequired, "warning")
      return
    }
    setUserSafeApiStatus("checking")
    setUserSafeApiMessage(t.userSafeApiChecking)
    try {
      await verifyUserSafeApiKey(candidate, t)
      setUserSafeApiKey(candidate)
      setUserSafeApiKeyDraft("")
      setUserSafeApiStatus("valid")
      setUserSafeApiMessage(t.userSafeApiActive)
      writeStorageText(appStorageKeys.userSafeApiKey, candidate)
      toast(t.userSafeApiSaved, "success")
    } catch (error) {
      setUserSafeApiStatus("invalid")
      setUserSafeApiMessage(error instanceof Error ? error.message : t.userSafeApiFailed)
      toast(error instanceof Error ? error.message : t.userSafeApiFailed, "warning")
    }
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
      toast(readableSimulationError(error, t.transactionFailed), "warning")
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
      toast(readableSimulationError(error, t.transactionFailed), "warning")
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
          message: error instanceof Error ? error.message : t.agentAuthFailed,
        },
      }
    }
    const client = createSafenetPublicClient({ authToken, rpcUrl: effectiveRpcUrl })
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
          throw new Error(`${translateTxLabel(tx.label, t)}: ${readableSimulationError(error, t.simulationFailed)}`)
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
          message: readableSimulationError(error, t.simulationFailed),
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
      const publicClient = createSafenetPublicClient({ authToken, rpcUrl: effectiveRpcUrl })
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
            throw new Error(`${label}: ${readableSimulationError(error, t.simulationFailed)}`)
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
      const message = readableSimulationError(error, t.transactionFailed)
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
      toast(readableSimulationError(error, t.transactionFailed), "warning")
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
    const result = await submitSafeMultisigPlan({
      origin: "Safecafe",
      authToken: params.authToken,
      plan: params.plan,
      provider: window.ethereum,
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
    if (result.mode === "executed") {
      setTxExecution(
        createExecutionState(params.executionAction, params.plan.title, markSteps(params.executionSteps, "done"), {
          status: "completed",
        }),
      )
      toast(`${t.safeProposalExecuted}: ${compactAddress(result.safeTxHash, 10, 8)}`, "success")
      await refreshLiveReads(subjectAccount, { forceRefresh: true })
      return
    }
    const execution = createExecutionState(params.executionAction, params.plan.title, params.executionSteps, {
      errorMessage: t.safeProposalWaiting,
      status: "partial",
    })
    setTxExecution({
      ...execution,
      safeProposal: {
        confirmations: result.confirmations,
        safeAddress: subjectAccount,
        safeTxHash: result.safeTxHash,
        status: "pending",
        threshold: result.threshold || params.threshold,
      },
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
      const safeTx = buildSafeExecTransaction({ safe: subjectAccount, signer: account, tx })
      try {
        await params.publicClient.call({
          account,
          to: safeTx.to,
          data: safeTx.data,
          value: safeTx.value,
        })
      } catch (error) {
        throw new Error(`${label}: ${readableSimulationError(error, t.simulationFailed)}`)
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
          aria-label={account ? `${t.wallet}: ${walletButtonLabel}, ${walletButtonStatus}` : t.connectWallet}
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
    <div className="app-shell">
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
              aria-label={account ? `${t.wallet}: ${walletButtonLabel}, ${walletButtonStatus}` : t.connectWallet}
              aria-haspopup={account ? "dialog" : undefined}
            >
              <Wallet size={17} />
              <span>{account ? compactAddress(account, 5, 4) : walletButtonLabel}</span>
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
                  <strong>{liveDataStatusText}</strong>
                </span>
                {liveDataUpdatedText && <small>{liveDataUpdatedText}</small>}
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
                <strong>{t.chainIdentity}</strong>
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
              <span>{t.frontendProof}</span>
              <small>{trustBadgeValue}</small>
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
              <Metric
                icon={<Database />}
                label={t.safeBalance}
                value={hasLiveAccountData ? displaySummary.safeBalance : null}
                unavailable={t.notConnected}
                safePriceUsd={displaySafePriceUsd}
              />
              <Metric
                icon={<Wallet />}
                label={t.totalStaked}
                value={hasLiveAccountData ? displaySummary.totalStaked : null}
                unavailable={t.notConnected}
                safePriceUsd={displaySafePriceUsd}
              />
              <Metric
                icon={<Gift />}
                label={t.claimableRewards}
                value={hasLiveAccountData ? displaySummary.claimableRewards : null}
                unavailable={t.notConnected}
                safePriceUsd={displaySafePriceUsd}
              />
              <div className="metric metric-rate">
                <span className="metric-icon">
                  <TrendingUp />
                </span>
                <span>
                  <small>{t.currentApy}</small>
                  <strong>{formatPercentOrDash(estimatedApyPercent)}</strong>
                  <em>{t.estimatedAnnualRewards}</em>
                </span>
              </div>
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
          <FullPanel>
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
          }}
          onUseSignerAsSubject={() => {
            if (!account) return
            const identity = createWalletIdentity(account)
            selectStakingSubject(identity, { refresh: true })
          }}
          t={t}
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
    const response = await fetch(`/api/account/live?${params.toString()}`, { cache: "no-store" })
    if (!response.ok) throw new Error(await readLiveDataError(response))
    return parseLiveReadResult(await response.json())
  })()

  liveReadCache.set(cacheKey, request)
  try {
    return await request
  } finally {
    liveReadCache.delete(cacheKey)
  }
}

async function readLiveDataFromCustomRpc(account: Address, rpcUrl: string): Promise<LiveReadResult> {
  const client = createSafenetPublicClient({ rpcUrl })
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
    const body = (await response.json()) as { code?: unknown; error?: unknown; requestId?: unknown }
    const message = typeof body.error === "string" ? body.error : `Account live API failed: ${response.status}`
    const code = typeof body.code === "string" ? body.code : ""
    const requestId = typeof body.requestId === "string" ? body.requestId : response.headers.get("x-request-id")
    return [message, code ? `(${code})` : "", requestId ? `request ${requestId}` : ""].filter(Boolean).join(" ")
  } catch {
    return `Account live API failed: ${response.status}`
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

async function fetchOwnedSafesWithMetadata(owner: Address, signal?: AbortSignal): Promise<DiscoveredSafe[]> {
  const params = new URLSearchParams({ owner })
  const response = await fetch(`/api/safes?${params.toString()}`, { cache: "no-store", signal })
  if (!response.ok) throw new Error(await readApiError(response, "Safe discovery failed"))
  const data = (await response.json()) as { safes?: unknown }
  if (!Array.isArray(data.safes)) return []
  return data.safes.map(parseDiscoveredSafe).filter((safe): safe is DiscoveredSafe => Boolean(safe))
}

async function fetchSafeMetadata(address: Address, signal?: AbortSignal): Promise<DiscoveredSafe> {
  const params = new URLSearchParams({ safe: address })
  const response = await fetch(`/api/safes?${params.toString()}`, { cache: "no-store", signal })
  if (!response.ok) throw new Error(await readApiError(response, "Safe discovery failed"))
  const data = (await response.json()) as { safe?: unknown }
  return parseDiscoveredSafe(data.safe) ?? emptyDiscoveredSafe(address)
}

async function fetchValidatorMetadata(): Promise<ValidatorInfo[]> {
  const response = await fetch("/api/validators", { cache: "no-store" })
  if (!response.ok) throw new Error(await readApiError(response, "Validator metadata failed"))
  const data = (await response.json()) as { validators?: unknown }
  if (!Array.isArray(data.validators)) return []
  return data.validators.map(parseValidatorInfo).filter((validator): validator is ValidatorInfo => Boolean(validator))
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

async function verifyUserSafeApiKey(apiKey: string, t: MessageBundle) {
  try {
    const response = await fetch("https://api.safe.global/tx-service/eth/api/v1/about", {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error(t.userSafeApiUnauthorized)
      if (response.status === 429) throw new Error(t.userSafeApiRateLimited)
      throw new Error(`${t.userSafeApiFailed} (${response.status})`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(t.userSafeApiFailed)) throw error
    if (error instanceof Error && error.message === t.userSafeApiUnauthorized) throw error
    if (error instanceof Error && error.message === t.userSafeApiRateLimited) throw error
    throw new Error(t.userSafeApiVerifyFailed)
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
