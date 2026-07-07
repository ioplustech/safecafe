import {
  ArrowDownToLine,
  ChevronDown,
  Database,
  Gift,
  Home,
  Languages,
  Menu,
  Settings,
  Users,
  Wallet,
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast as sonnerToast, Toaster } from "sonner"
import { type Address, createWalletClient, custom } from "viem"
import {
  type AccountSnapshot,
  CHAIN_ID,
  compactAddress,
  createSafenetPublicClient,
  EXPLORER_BASE_URL,
  fetchRewardProof,
  fetchValidators,
  findValidator,
  isTxPlanForAccount,
  planClaimRewards,
  planClaimWithdrawal,
  planStake,
  planUnstake,
  SAFE_PRICE_CACHE_MS,
  type TxPlan,
  toSafeTransactionPayload,
  type ValidatorInfo,
} from "../protocol"
import { ethereumMainnet } from "../protocol/chains"
import { createPathMap, navFromPath as resolveNavFromPath } from "../shared"
import { SAFECAFE_VERSION } from "../shared/version"
import { AgentLauncher } from "./AgentLauncher"
import { DetailModal } from "./DetailModal"
import {
  priceStatusLabel,
  readableSimulationError,
  safeParsedAmount,
  stringifyBigInts,
  translateTxLabel,
} from "./formatters"
import { detectLocale, getMessages, isLocale, type Locale, localeOptions } from "./i18n"
import { readCachedSafePrice, writeCachedSafePrice } from "./priceCache"
import { clearRpcSession, ensureRpcSession, readRpcSession } from "./rpcAuth"
import { fetchSafeUsdPrice } from "./safePriceApi"
import {
  type Action,
  type DataStatus,
  defaultValidator,
  emptySummary,
  type Modal,
  type NavItem,
  navItems,
  type SafePriceState,
} from "./types"
import { FullPanel, Metric } from "./ui"
import { DashboardView, DocsView, RewardsView, ValidatorTable, ValidatorToolbar, WithdrawalsView } from "./views"
import { createWalletIdentity, isSelfSubject, normalizeAddress } from "./walletIdentity"

const navPaths = createPathMap(navItems)
type ValidatorSort = "stake" | "participation" | "commission" | "name" | "yourStake"
type WalletStatus = "idle" | "restoring" | "connecting" | "connected"
type DashboardAction = Extract<Action, "stake" | "unstake" | "claim-rewards">
type SimulateTxPlanOptions = { requireAuth?: boolean }
type SubmitPlanOptions = {
  alreadySubmitting?: boolean
  requireAuth?: boolean
  skipValidation?: boolean
}
type LiveReadResult = {
  health: {
    blockNumber: bigint
    merkleRoot: `0x${string}`
    withdrawDelay: bigint
  }
  snapshot: AccountSnapshot
  validatorsWithPositions: ValidatorInfo[]
}

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

function dashboardActionFromPath(pathname: string): DashboardAction {
  const normalized = pathname.replace(/\/+$/, "") || "/"
  if (normalized === "/unstake") return "unstake"
  return "stake"
}

function isLegacyActionPath(pathname: string) {
  const normalized = pathname.replace(/\/+$/, "") || "/"
  return normalized === "/stake" || normalized === "/unstake"
}
const walletDisconnectKey = "safecafe:wallet-disconnected"
const defaultToastDurationMs = 3600
const toastDurationMs = readToastDurationMs(import.meta.env.VITE_TOAST_DURATION_MS)
const mockRewardProofEnabled = import.meta.env.VITE_MOCK_REWARD_PROOF === "true"
const mockRewardMerkleRoot = `0x${"11".repeat(32)}` as const
type ToastTone = "success" | "warning" | "info"
const navMeta: Record<NavItem, { label: string; icon: typeof Home }> = {
  dashboard: { label: "Dashboard", icon: Home },
  withdrawals: { label: "Withdrawals", icon: ArrowDownToLine },
  rewards: { label: "Rewards", icon: Gift },
  validators: { label: "Validators", icon: Users },
  settings: { label: "Settings", icon: Settings },
}

export function App() {
  const [locale, setLocale] = useState<Locale>(() => {
    const saved = window.localStorage.getItem("safecafe:locale")
    if (isLocale(saved)) return saved
    return detectLocale(navigator.language)
  })
  const [activeNav, setActiveNav] = useState<NavItem>(() => navFromPath(window.location.pathname))
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isLanguageMenuOpen, setIsLanguageMenuOpen] = useState(false)
  const [account, setAccount] = useState<Address | null>(null)
  const [stakingAccount, setStakingAccount] = useState<Address | null>(null)
  const [action, setAction] = useState<Action>(() => actionFromPath(window.location.pathname))
  const [dashboardAction, setDashboardAction] = useState<DashboardAction>(() =>
    dashboardActionFromPath(window.location.pathname),
  )
  const [validator, setValidator] = useState<Address>(defaultValidator.address)
  const [amount, setAmount] = useState("")
  const [txPlan, setTxPlan] = useState<TxPlan | null>(null)
  const [modal, setModal] = useState<Modal>(null)
  const [showOnlyActive, setShowOnlyActive] = useState(false)
  const [validatorQuery, setValidatorQuery] = useState("")
  const [validatorSort, setValidatorSort] = useState<ValidatorSort>("stake")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [liveSnapshot, setLiveSnapshot] = useState<AccountSnapshot | null>(null)
  const [liveRewards, setLiveRewards] = useState<bigint | null>(null)
  const [liveBlock, setLiveBlock] = useState<bigint | null>(null)
  const [liveError, setLiveError] = useState("")
  const [isReadingLive, setIsReadingLive] = useState(false)
  const [walletStatus, setWalletStatus] = useState<WalletStatus>("idle")
  const [isLoadingValidators, setIsLoadingValidators] = useState(true)
  const [validators, setValidators] = useState<ValidatorInfo[]>([])
  const [validatorLoadError, setValidatorLoadError] = useState("")
  const [rewardProof, setRewardProof] = useState<Awaited<ReturnType<typeof fetchRewardProof>> | null>(null)
  const [liveMerkleRoot, setLiveMerkleRoot] = useState<string | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [rpcAuthToken, setRpcAuthToken] = useState<string | null>(null)
  const [txProgress, setTxProgress] = useState("")
  const [validatorStakeError, setValidatorStakeError] = useState("")
  const [safePrice, setSafePrice] = useState<SafePriceState>(() => readCachedSafePrice())

  const t = getMessages(locale)
  const activeLocale = localeOptions.find((option) => option.code === locale) ?? localeOptions[0]
  const connectedAccount = account
  const walletIdentity = useMemo(() => createWalletIdentity(account, stakingAccount), [account, stakingAccount])
  const subjectAccount = walletIdentity.subject
  const walletBusy = walletStatus === "restoring" || walletStatus === "connecting"
  const walletButtonLabel = account
    ? compactAddress(account, 6, 4)
    : walletStatus === "restoring"
      ? t.walletRestoring
      : walletStatus === "connecting"
        ? t.walletConnecting
        : t.connectWallet
  const walletButtonStatus = account ? t.connected : walletBusy ? t.reading : t.notConnected
  const languageButtonRef = useRef<HTMLButtonElement | null>(null)
  const languageMenuRef = useRef<HTMLDivElement | null>(null)
  const liveReadRequestId = useRef(0)
  const refreshLiveReadsRef = useRef<
    ((target?: Address | null, options?: { forceRefresh?: boolean }) => Promise<void>) | null
  >(null)
  const selectedValidator = useMemo(
    () => findValidator(validators, validator) ?? validators[0] ?? defaultValidator,
    [validator, validators],
  )
  const hasLiveAccountData = Boolean(subjectAccount && liveSnapshot)
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
      rewardsSource: rewardProof ? t.proofLoaded : liveSnapshot ? t.proofMissing : t.notChecked,
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
    t,
    validatorPoolTotal,
    validatorStakeError,
    validators.length,
  ])
  const displaySummary = hasLiveAccountData ? summary : emptySummary
  const displayValidators = visibleValidators
  const displaySafePriceUsd = safePrice.usd
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

  useEffect(() => {
    const handlePopState = () => {
      setActiveNav(navFromPath(window.location.pathname))
      if (isLegacyActionPath(window.location.pathname)) {
        const nextAction = actionFromPath(window.location.pathname)
        setAction(nextAction)
        setDashboardAction(dashboardActionFromPath(window.location.pathname))
      }
    }
    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [])

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
    setTxPlan(null)
  }, [])

  const updateValidator = useCallback((nextValidator: Address) => {
    setValidator(nextValidator)
    setTxPlan(null)
  }, [])

  const resetLiveAccountState = useCallback(() => {
    liveReadRequestId.current += 1
    setLiveSnapshot(null)
    setLiveRewards(null)
    setRewardProof(null)
    setLiveMerkleRoot(null)
    setLiveBlock(null)
    setLiveError("")
    setTxPlan(null)
    setTxProgress("")
  }, [])

  const setWalletIdentityState = useCallback((identity: ReturnType<typeof createWalletIdentity>) => {
    setAccount(identity.signer)
    setStakingAccount(identity.subject)
  }, [])

  useEffect(() => {
    setIsLoadingValidators(true)
    setValidatorLoadError("")
    fetchValidators(undefined, { fallback: false })
      .then((items) => {
        setValidatorStakeError("")
        setValidators(items)
        setValidator((current) => findValidator(items, current)?.address ?? items[0]?.address ?? current)
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : t.validatorInfoFailed
        setValidatorLoadError(message)
        toast(message, "warning")
      })
      .finally(() => {
        setIsLoadingValidators(false)
      })
  }, [t.validatorInfoFailed, toast])

  const refreshLiveReads = useCallback(
    async (target = subjectAccount, options: { forceRefresh?: boolean } = {}) => {
      if (!target) {
        toast(t.connectToLoad, "warning")
        return
      }
      const requestId = liveReadRequestId.current + 1
      liveReadRequestId.current = requestId
      setIsReadingLive(true)
      setLiveError("")
      try {
        const { health, snapshot, validatorsWithPositions } = await readLiveData(target, options)
        if (liveReadRequestId.current !== requestId) return
        setLiveSnapshot(snapshot)
        setLiveBlock(health.blockNumber)
        setLiveMerkleRoot(health.merkleRoot)
        setValidatorLoadError("")
        setValidators(validatorsWithPositions)

        try {
          const proof = mockRewardProofEnabled
            ? {
                cumulativeAmount: "95000000000000000000",
                merkleRoot: mockRewardMerkleRoot,
                proof: [],
              }
            : await fetchRewardProof(target)
          if (liveReadRequestId.current !== requestId) return
          setRewardProof(proof)
          const cumulativeAmount = proof ? BigInt(proof.cumulativeAmount) : 0n
          setLiveRewards(
            cumulativeAmount > snapshot.cumulativeClaimed ? cumulativeAmount - snapshot.cumulativeClaimed : 0n,
          )
        } catch {
          if (liveReadRequestId.current !== requestId) return
          setRewardProof(null)
          setLiveRewards(0n)
        }
      } catch (error) {
        if (liveReadRequestId.current !== requestId) return
        const message = error instanceof Error ? error.message : t.liveDataFailed
        setLiveError(message)
        toast(message, "warning")
      } finally {
        if (liveReadRequestId.current === requestId) setIsReadingLive(false)
      }
    },
    [subjectAccount, t.connectToLoad, t.liveDataFailed, toast],
  )

  useEffect(() => {
    refreshLiveReadsRef.current = refreshLiveReads
  }, [refreshLiveReads])

  useEffect(() => {
    if (!window.ethereum) return
    let cancelled = false
    window.ethereum
      .request({ method: "eth_chainId" })
      .then((value) => {
        if (!cancelled) setChainId(Number.parseInt(value as string, 16))
      })
      .catch(() => undefined)

    if (window.localStorage.getItem(walletDisconnectKey) !== "true") {
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
          const identity = createWalletIdentity(first)
          setWalletIdentityState(identity)
          const session = readRpcSession(identity)
          setRpcAuthToken(session?.token ?? null)
          setWalletStatus("connected")
          await refreshLiveReadsRef.current?.(identity.subject)
        })
        .catch(() => {
          if (!cancelled) setWalletStatus("idle")
        })
    }

    const handleAccountsChanged = (accounts: unknown) => {
      const [first] = accounts as Address[]
      const identity = createWalletIdentity(first ?? null)
      resetLiveAccountState()
      setWalletIdentityState(identity)
      const session = first ? readRpcSession(identity) : null
      setRpcAuthToken(session?.token ?? null)
      setWalletStatus(first ? "connected" : "idle")
      if (first) {
        window.localStorage.removeItem(walletDisconnectKey)
        void refreshLiveReadsRef.current?.(identity.subject)
      } else {
        window.localStorage.setItem(walletDisconnectKey, "true")
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
          const identity = createWalletIdentity(first ?? null)
          const session = first ? readRpcSession(identity) : null
          setWalletIdentityState(identity)
          setRpcAuthToken(session?.token ?? null)
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
  }, [resetLiveAccountState, setWalletIdentityState])

  useEffect(() => {
    if (!isLanguageMenuOpen) return
    window.requestAnimationFrame(() => {
      languageMenuRef.current?.querySelector<HTMLButtonElement>("[aria-checked='true']")?.focus()
    })
    const closeLanguageMenu = (event: PointerEvent) => {
      if (languageMenuRef.current?.contains(event.target as Node)) return
      setIsLanguageMenuOpen(false)
    }
    const closeLanguageMenuWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsLanguageMenuOpen(false)
        languageButtonRef.current?.focus()
      }
    }
    document.addEventListener("pointerdown", closeLanguageMenu)
    document.addEventListener("keydown", closeLanguageMenuWithEscape)
    return () => {
      document.removeEventListener("pointerdown", closeLanguageMenu)
      document.removeEventListener("keydown", closeLanguageMenuWithEscape)
    }
  }, [isLanguageMenuOpen])

  function selectLocale(nextLocale: Locale) {
    setLocale(nextLocale)
    window.localStorage.setItem("safecafe:locale", nextLocale)
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

  async function connectWallet() {
    if (!window.ethereum) {
      toast(t.noWallet, "warning")
      return
    }
    setWalletStatus("connecting")
    try {
      window.localStorage.removeItem(walletDisconnectKey)
      const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[]
      const identity = createWalletIdentity(accounts[0] ?? null)
      await ensureMainnet()
      if (!identity.signer || !identity.subject) throw new Error(t.noAccount)
      setWalletIdentityState(identity)
      const session = readRpcSession(identity)
      setRpcAuthToken(session?.token ?? null)
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
    window.localStorage.setItem(walletDisconnectKey, "true")
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

  function createTxPlan(nextAction = action): TxPlan | null {
    if (!subjectAccount || !liveSnapshot) return null
    if (nextAction === "stake") {
      return planStake({ validator, amount, account: subjectAccount, allowance: liveSnapshot.stakingAllowance })
    }
    if (nextAction === "unstake") {
      return planUnstake({ validator, amount, account: subjectAccount })
    }
    if (nextAction === "claim-withdrawal") {
      return planClaimWithdrawal(subjectAccount)
    }
    if (nextAction === "claim-rewards") {
      if (!rewardProof?.proof) throw new Error(t.noProof)
      if (liveMerkleRoot && rewardProof.merkleRoot.toLowerCase() !== liveMerkleRoot.toLowerCase()) {
        throw new Error(t.merkleMismatch)
      }
      if ((liveRewards ?? 0n) <= 0n) throw new Error(t.noProof)
      return planClaimRewards({
        account: subjectAccount,
        cumulativeAmount: BigInt(rewardProof.cumulativeAmount),
        merkleRoot: rewardProof.merkleRoot,
        proof: rewardProof.proof,
      })
    }
    return null
  }

  async function executeAction(nextAction = action) {
    if (!account) {
      await connectWallet()
      return
    }
    if (!window.ethereum) {
      toast(t.noWallet, "warning")
      return
    }
    if (isSubmitting) return
    setAction(nextAction)
    setTxPlan(null)
    setIsSubmitting(true)
    setTxProgress(t.preparingAction)
    try {
      await ensureMainnet()
      if (!subjectAccount || !liveSnapshot) throw new Error(t.connectToPlan)
      const validation = validateAction(nextAction)
      if (validation) throw new Error(validation)
      const nextPlan = createTxPlan(nextAction)
      if (!nextPlan) throw new Error(t.transactionFailed)
      const simulatedPlan = await simulateTxPlan(nextPlan, { requireAuth: true })
      if (simulatedPlan.simulation?.status === "failed") throw new Error(simulatedPlan.simulation.message)
      setTxPlan(simulatedPlan)
      await submitPlan(simulatedPlan, { alreadySubmitting: true, requireAuth: true, skipValidation: true })
    } catch (error) {
      toast(error instanceof Error ? error.message : t.transactionFailed, "warning")
    } finally {
      setIsSubmitting(false)
      setTxProgress("")
    }
  }

  async function simulateTxPlan(plan: TxPlan, options: SimulateTxPlanOptions = {}): Promise<TxPlan> {
    if (!subjectAccount) return plan
    let authToken: string | null = options.requireAuth ? rpcAuthToken : null
    try {
      if (options.requireAuth) authToken = await ensureRpcAuthTokenForCurrentWallet()
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
    const client = createSafenetPublicClient({ authToken, rpcUrl: import.meta.env.VITE_RPC_URL })
    const txsToSimulate = usesApprovalBeforeStake(plan) ? plan.txs.slice(0, 1) : plan.txs
    try {
      for (const tx of txsToSimulate) {
        await client.call({
          account: subjectAccount,
          to: tx.to,
          data: tx.data,
          value: tx.value,
        })
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

  function usesApprovalBeforeStake(plan: TxPlan) {
    return (
      plan.txs.length > 1 &&
      plan.txs[0]?.label === "Approve SAFE for staking contract" &&
      plan.txs.some((tx) => tx.label === "Stake SAFE to validator")
    )
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
    if (!options.alreadySubmitting) setIsSubmitting(true)
    setTxProgress("")
    try {
      await ensureMainnet()
      if (!subjectAccount || !isTxPlanForAccount(planToSubmit, subjectAccount)) throw new Error(t.agentAccountChanged)
      const validation =
        options.skipValidation || planToSubmit.action === "agent-plan" ? null : validateAction(planToSubmit.action)
      if (validation) throw new Error(validation)
      if (!planToSubmit.simulation) throw new Error(t.connectToPlan)
      if (planToSubmit.simulation.status === "failed") throw new Error(planToSubmit.simulation.message)
      if (!isSelfSubject(walletIdentity)) {
        exportSafePayload(planToSubmit)
        toast(t.safeSubjectExportOnly, "info")
        return
      }
      const client = createWalletClient({
        account,
        chain: ethereumMainnet,
        transport: custom(window.ethereum),
      })
      const authToken = options.requireAuth ? await ensureRpcAuthTokenForCurrentWallet() : null
      const publicClient = createSafenetPublicClient({ authToken, rpcUrl: import.meta.env.VITE_RPC_URL })
      for (const tx of planToSubmit.txs) {
        setTxProgress(`${t.simulationStatus}: ${translateTxLabel(tx.label, t)}`)
        try {
          await publicClient.call({
            account: subjectAccount,
            to: tx.to,
            data: tx.data,
            value: tx.value,
          })
        } catch (error) {
          throw new Error(readableSimulationError(error, t.simulationFailed))
        }
        setTxProgress(translateTxLabel(tx.label, t))
        const hash = await client.sendTransaction({
          account,
          to: tx.to,
          data: tx.data,
          value: tx.value,
        })
        toast(`${t.submittedTx} ${translateTxLabel(tx.label, t)}: ${compactAddress(hash, 10, 8)}`, "success")
        await publicClient.waitForTransactionReceipt({ hash })
      }
      await refreshLiveReads(subjectAccount, { forceRefresh: true })
    } catch (error) {
      toast(error instanceof Error ? error.message : t.transactionFailed, "warning")
    } finally {
      if (!options.alreadySubmitting) setIsSubmitting(false)
      setTxProgress("")
    }
  }

  function validateAction(targetAction = action): string | null {
    if (!subjectAccount || !liveSnapshot) return t.connectToPlan
    if (chainId !== null && chainId !== CHAIN_ID) return t.wrongNetwork
    if (targetAction === "stake" || targetAction === "unstake") {
      const parsedAmount = safeParsedAmount(amount)
      if (parsedAmount === null) return t.invalidAmount
      if (selectedValidator.status !== "active") return t.inactiveValidator
      if (targetAction === "stake" && liveSnapshot.safeBalance < parsedAmount) return t.insufficientSafeBalance
      if (targetAction === "unstake" && selectedValidator.userStake < parsedAmount) return t.insufficientValidatorStake
    }
    if (targetAction === "claim-withdrawal" && summary.claimableWithdrawals <= 0n) return t.noClaimableWithdrawal
    if (targetAction === "claim-rewards") {
      if (!rewardProof?.proof || (liveRewards ?? 0n) <= 0n) return t.noProof
      if (liveMerkleRoot && rewardProof.merkleRoot.toLowerCase() !== liveMerkleRoot.toLowerCase())
        return t.merkleMismatch
    }
    return null
  }

  function validateActionSelection(targetAction: Action): string | null {
    if (targetAction === "stake" || targetAction === "unstake") {
      if (!subjectAccount || !liveSnapshot) return null
      if (chainId !== null && chainId !== CHAIN_ID) return t.wrongNetwork
    }
    if (targetAction === "stake") {
      if (!findPreferredValidator(targetAction)) return t.inactiveValidator
    }
    if (targetAction === "unstake") {
      if (!findPreferredValidator(targetAction)) return t.insufficientValidatorStake
    }
    return null
  }

  function selectAction(nextAction: Action) {
    const validation = validateActionSelection(nextAction)
    if (validation) {
      toast(validation, "warning")
      return
    }
    const preferredValidator = findPreferredValidator(nextAction)
    if (preferredValidator && preferredValidator.address !== validator) {
      updateValidator(preferredValidator.address)
    }
    setAction(nextAction)
    if (
      nextAction === "stake" ||
      nextAction === "unstake" ||
      (nextAction === "claim-rewards" && activeNav === "dashboard")
    ) {
      setDashboardAction(nextAction)
    }
    setTxPlan(null)
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
      setDashboardAction(nextAction)
    }
    setTxPlan(null)
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
    } catch {
      toast(t.copyFailed, "warning")
    }
  }

  function openExplorer(address: Address) {
    window.open(`${EXPLORER_BASE_URL}/address/${address}`, "_blank", "noopener,noreferrer")
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <button type="button" className="brand" onClick={() => navigate("dashboard")} aria-label="Safecafe dashboard">
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

          <div className={`topbar-menu ${isMenuOpen ? "open" : ""}`}>
            <nav className="nav-tabs" aria-label="Primary navigation">
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

            <div className="topbar-status">
              <div className="language-menu-wrap" ref={languageMenuRef}>
                <button
                  ref={languageButtonRef}
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
          </div>
          <span className="sidebar-version">Version {SAFECAFE_VERSION}</span>
        </div>
      </header>

      <main className="page">
        <div className="dashboard-topline">
          <h1>{t.appTitle}</h1>
        </div>
        <section className="summary-card enter">
          <div className="section-heading">
            <div>
              <h1>{t.accountSummary}</h1>
              <p>
                {walletStatus === "restoring"
                  ? t.walletRestoring
                  : liveSnapshot && subjectAccount
                    ? `${t.liveDataFor} ${compactAddress(subjectAccount)}.`
                    : t.connectToBegin}
              </p>
            </div>
            <div className="button-row">
              <div className={`price-chip ${safePrice.stale ? "stale" : ""}`}>
                <strong>{safePrice.usd === null ? t.priceUnavailable : `$${safePrice.usd.toFixed(3)}`}</strong>
                <small>{priceStatusLabel(safePrice, t)}</small>
              </div>
              <button type="button" className="soft-button" disabled={isReadingLive} onClick={refreshOrConnect}>
                <Database size={16} />
                {isReadingLive || walletBusy ? t.reading : account ? t.refreshLive : t.connectWallet}
              </button>
            </div>
          </div>
          {liveError && <p className="warning">{liveError}</p>}
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
              unavailable={t.connectWallet}
              safePriceUsd={displaySafePriceUsd}
            />
            <Metric
              icon={<Wallet />}
              label={t.totalStaked}
              value={hasLiveAccountData ? displaySummary.totalStaked : null}
              unavailable={t.connectWallet}
              safePriceUsd={displaySafePriceUsd}
            />
            <Metric
              icon={<Gift />}
              label={t.claimableRewards}
              value={hasLiveAccountData ? displaySummary.claimableRewards : null}
              unavailable={t.connectWallet}
              safePriceUsd={displaySafePriceUsd}
            />
          </div>
        </section>

        {activeNav === "dashboard" && (
          <DashboardView
            t={t}
            action={dashboardAction}
            amount={amount}
            accountReady={hasLiveAccountData}
            connectedAccount={connectedAccount}
            executeAction={executeAction}
            isLoadingValidators={isLoadingValidators}
            isSubmitting={isSubmitting}
            modal={modal}
            onConnect={refreshOrConnect}
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
            setShowOnlyActive={setShowOnlyActive}
            dataStatus={dataStatus}
            stakingAllowance={liveSnapshot?.stakingAllowance ?? 0n}
            summary={displaySummary}
            safePriceUsd={displaySafePriceUsd}
            validatorPoolTotal={validatorPoolTotal}
          />
        )}
        {activeNav === "validators" && (
          <FullPanel title={t.stakingDistribution}>
            <ValidatorToolbar
              activeOnly={showOnlyActive}
              isLoading={isLoadingValidators}
              query={validatorQuery}
              setActiveOnly={setShowOnlyActive}
              setQuery={setValidatorQuery}
              setSort={setValidatorSort}
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
                if (selectValidatorAction(nextValidator, "stake")) navigate("dashboard")
              }}
              onUnstake={(nextValidator) => {
                if (selectValidatorAction(nextValidator, "unstake")) navigate("dashboard")
              }}
            />
          </FullPanel>
        )}
        {activeNav === "rewards" && (
          <RewardsView
            t={t}
            executeAction={executeAction}
            isSubmitting={isSubmitting}
            selectAction={selectAction}
            summary={displaySummary}
            dataStatus={dataStatus}
            txProgress={txProgress}
          />
        )}
        {activeNav === "withdrawals" && (
          <WithdrawalsView
            t={t}
            executeAction={executeAction}
            isSubmitting={isSubmitting}
            selectAction={selectAction}
            summary={displaySummary}
            txProgress={txProgress}
          />
        )}
        {activeNav === "settings" && <DocsView t={t} />}
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
          signerAccount={account}
          subjectAccount={subjectAccount}
          subjectKind={walletIdentity.subjectKind}
          copyText={copyText}
          dataStatus={dataStatus}
          disconnectWallet={disconnectWallet}
          modal={modal}
          onClose={() => setModal(null)}
          openExplorer={openExplorer}
          onRefreshSubject={(subject) => {
            const nextSubject = normalizeAddress(subject)
            if (!account || !nextSubject) {
              toast(t.invalidSafeAccount, "warning")
              return
            }
            const identity = createWalletIdentity(account, nextSubject)
            setStakingAccount(identity.subject)
            setTxPlan(null)
            setLiveSnapshot(null)
            setRewardProof(null)
            setLiveRewards(null)
            const session = readRpcSession(identity)
            setRpcAuthToken(session?.token ?? null)
            void refreshLiveReads(identity.subject, { forceRefresh: true })
          }}
          onUseSignerAsSubject={() => {
            if (!account) return
            const identity = createWalletIdentity(account)
            setStakingAccount(identity.subject)
            setTxPlan(null)
            setLiveSnapshot(null)
            setRewardProof(null)
            setLiveRewards(null)
            const session = readRpcSession(identity)
            setRpcAuthToken(session?.token ?? null)
            void refreshLiveReads(identity.subject, { forceRefresh: true })
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
        isSubmitting={isSubmitting}
        rpcAuthToken={rpcAuthToken}
        onAuthenticateAgent={authenticateAgent}
        onConnectWallet={connectWallet}
        onSimulatePlan={(plan) => simulateTxPlan(plan, { requireAuth: true })}
        onExportPlan={exportSafePayload}
        onOpen={() => setModal(null)}
        onSubmitPlan={(plan) => submitPlan(plan, { requireAuth: true })}
        onApplyPlan={(plan) => {
          setTxPlan(plan)
          toast(t.planReady, "success")
        }}
      />
    </div>
  )
}

const liveReadCache = new Map<string, Promise<LiveReadResult>>()

async function readLiveData(account: Address, options: { forceRefresh?: boolean } = {}): Promise<LiveReadResult> {
  const cacheKey = `${account.toLowerCase()}:account-live:${options.forceRefresh ? "refresh" : "cached"}`
  const cached = liveReadCache.get(cacheKey)
  if (cached) return cached

  const request = (async () => {
    const params = new URLSearchParams({ account })
    if (options.forceRefresh) params.set("refresh", "true")
    const response = await fetch(`/api/account/live?${params.toString()}`, { cache: "no-store" })
    if (!response.ok) throw new Error(`Account live API failed: ${response.status}`)
    return parseLiveReadResult(await response.json())
  })()

  liveReadCache.set(cacheKey, request)
  try {
    return await request
  } finally {
    liveReadCache.delete(cacheKey)
  }
}

function parseLiveReadResult(value: unknown): LiveReadResult {
  const data = value as {
    health?: { blockNumber?: string; merkleRoot?: string; withdrawDelay?: string }
    snapshot?: {
      cumulativeClaimed?: string
      nextClaimableWithdrawal?: { amount?: string; claimableAt?: string }
      pendingWithdrawals?: Array<{ amount?: string; claimableAt?: string }>
      safeBalance?: string
      stakingAllowance?: string
      totalStaked?: string
      withdrawDelay?: string
    }
    validatorsWithPositions?: Array<ValidatorInfo & { totalStake?: string; userStake?: string }>
  }
  if (!data.health || !data.snapshot || !Array.isArray(data.validatorsWithPositions)) {
    throw new Error("Account live API returned an invalid payload.")
  }
  if (typeof data.health.merkleRoot !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(data.health.merkleRoot)) {
    throw new Error("Account live API returned an invalid merkle root.")
  }
  return {
    health: {
      blockNumber: toBigInt(data.health.blockNumber),
      merkleRoot: data.health.merkleRoot as `0x${string}`,
      withdrawDelay: toBigInt(data.health.withdrawDelay),
    },
    snapshot: {
      cumulativeClaimed: toBigInt(data.snapshot.cumulativeClaimed),
      nextClaimableWithdrawal: {
        amount: toBigInt(data.snapshot.nextClaimableWithdrawal?.amount),
        claimableAt: toBigInt(data.snapshot.nextClaimableWithdrawal?.claimableAt),
      },
      pendingWithdrawals: (data.snapshot.pendingWithdrawals ?? []).map((item) => ({
        amount: toBigInt(item.amount),
        claimableAt: toBigInt(item.claimableAt),
      })),
      safeBalance: toBigInt(data.snapshot.safeBalance),
      stakingAllowance: toBigInt(data.snapshot.stakingAllowance),
      totalStaked: toBigInt(data.snapshot.totalStaked),
      withdrawDelay: toBigInt(data.snapshot.withdrawDelay),
    },
    validatorsWithPositions: data.validatorsWithPositions.map((validator) => ({
      ...validator,
      totalStake: toBigInt(validator.totalStake),
      userStake: toBigInt(validator.userStake),
    })),
  }
}

function toBigInt(value: unknown) {
  if (typeof value === "bigint") return value
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value)
  return 0n
}

function compareBigintDesc(a: bigint, b: bigint) {
  if (a === b) return 0
  return a > b ? -1 : 1
}

function readToastDurationMs(value: unknown) {
  if (typeof value !== "string" || value.trim() === "") return defaultToastDurationMs
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 500 ? parsed : defaultToastDurationMs
}
