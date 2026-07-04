import {
  ArrowDownToLine,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Database,
  Gift,
  Home,
  Info,
  Languages,
  Menu,
  Settings,
  Shield,
  Upload,
  Users,
  Wallet,
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { type Address, createWalletClient, custom } from "viem"
import { mainnet } from "viem/chains"
import {
  type AccountSnapshot,
  CHAIN_ID,
  compactAddress,
  createSafenetPublicClient,
  EXPLORER_BASE_URL,
  fetchRewardProof,
  fetchSafeUsdPrice,
  fetchValidators,
  findValidator,
  planClaimRewards,
  planClaimWithdrawal,
  planStake,
  planUnstake,
  readAccountSnapshot,
  readHealth,
  readValidatorPositions,
  readValidatorTotals,
  SAFE_PRICE_CACHE_MS,
  type TxPlan,
  toSafeTransactionPayload,
  type ValidatorInfo,
} from "../protocol"
import { createPathMap, navFromPath as resolveNavFromPath } from "../shared"
import { SAFECAFE_VERSION } from "../shared/version"
import { DetailModal } from "./DetailModal"
import {
  priceStatusLabel,
  readableSimulationError,
  safeParsedAmount,
  stringifyBigInts,
  translateTxLabel,
} from "./formatters"
import { type Locale, messages } from "./i18n"
import { readCachedSafePrice, writeCachedSafePrice } from "./priceCache"
import {
  type Action,
  type DataStatus,
  defaultValidator,
  emptySummary,
  type Modal,
  type NavItem,
  navItems,
  type SafePriceState,
  type Toast,
} from "./types"
import { FullPanel, Metric } from "./ui"
import { DashboardView, DocsView, RewardsView, ValidatorTable, ValidatorToolbar, WithdrawalsView } from "./views"

const navPaths = createPathMap(navItems)
type ValidatorSort = "stake" | "participation" | "commission" | "name" | "yourStake"

const navFromPath = (pathname: string): NavItem => resolveNavFromPath(pathname, navItems, navPaths, "dashboard")
const navMeta: Record<NavItem, { label: string; icon: typeof Home }> = {
  dashboard: { label: "Dashboard", icon: Home },
  stake: { label: "Stake", icon: Database },
  unstake: { label: "Unstake", icon: Upload },
  withdrawals: { label: "Withdrawals", icon: ArrowDownToLine },
  rewards: { label: "Rewards", icon: Gift },
  validators: { label: "Validators", icon: Users },
  settings: { label: "Settings", icon: Settings },
}

export function App() {
  const [locale, setLocale] = useState<Locale>(() => {
    const saved = window.localStorage.getItem("safecafe:locale")
    if (saved === "en" || saved === "zh") return saved
    return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en"
  })
  const [activeNav, setActiveNav] = useState<NavItem>(() => navFromPath(window.location.pathname))
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [account, setAccount] = useState<Address | null>(null)
  const [action, setAction] = useState<Action>("stake")
  const [validator, setValidator] = useState<Address>(defaultValidator.address)
  const [amount, setAmount] = useState("")
  const [txPlan, setTxPlan] = useState<TxPlan | null>(null)
  const [modal, setModal] = useState<Modal>(null)
  const [showOnlyActive, setShowOnlyActive] = useState(false)
  const [validatorQuery, setValidatorQuery] = useState("")
  const [validatorSort, setValidatorSort] = useState<ValidatorSort>("stake")
  const [toasts, setToasts] = useState<Toast[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [liveSnapshot, setLiveSnapshot] = useState<AccountSnapshot | null>(null)
  const [liveRewards, setLiveRewards] = useState<bigint | null>(null)
  const [liveBlock, setLiveBlock] = useState<bigint | null>(null)
  const [liveError, setLiveError] = useState("")
  const [isReadingLive, setIsReadingLive] = useState(false)
  const [isLoadingValidators, setIsLoadingValidators] = useState(true)
  const [validators, setValidators] = useState<ValidatorInfo[]>([])
  const [validatorLoadError, setValidatorLoadError] = useState("")
  const [rewardProof, setRewardProof] = useState<Awaited<ReturnType<typeof fetchRewardProof>> | null>(null)
  const [liveMerkleRoot, setLiveMerkleRoot] = useState<string | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [txProgress, setTxProgress] = useState("")
  const [validatorStakeError, setValidatorStakeError] = useState("")
  const [safePrice, setSafePrice] = useState<SafePriceState>(() => readCachedSafePrice())

  const t = messages[locale]
  const connectedAccount = account
  const selectedValidator = useMemo(
    () => findValidator(validators, validator) ?? validators[0] ?? defaultValidator,
    [validator, validators],
  )
  const hasLiveAccountData = Boolean(account && liveSnapshot)
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
    const [nextAmount, nextClaimableAt] = liveSnapshot.nextClaimableWithdrawal
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

  const toast = useCallback((message: string, tone: Toast["tone"] = "info", title?: string) => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current.slice(-3), { id, message, tone, title }])
    window.setTimeout(
      () => {
        setToasts((current) => current.filter((item) => item.id !== id))
      },
      message.length > 120 ? 6200 : 3600,
    )
  }, [])

  useEffect(() => {
    const handlePopState = () => setActiveNav(navFromPath(window.location.pathname))
    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
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

  useEffect(() => {
    setIsLoadingValidators(true)
    setValidatorLoadError("")
    fetchValidators(undefined, { fallback: false })
      .then(async (items) => {
        const client = createSafenetPublicClient(import.meta.env.VITE_RPC_URL)
        setValidatorStakeError("")
        const validatorsWithTotals = await readValidatorTotals(client, items).catch((error) => {
          setValidatorStakeError(error instanceof Error ? error.message : t.validatorStakeUnavailable)
          return items
        })
        setValidators(validatorsWithTotals)
        setValidator(
          (current) =>
            findValidator(validatorsWithTotals, current)?.address ?? validatorsWithTotals[0]?.address ?? current,
        )
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : t.validatorInfoFailed
        setValidatorLoadError(message)
        toast(message, "warning")
      })
      .finally(() => {
        setIsLoadingValidators(false)
      })
  }, [t.validatorInfoFailed, t.validatorStakeUnavailable, toast])

  const refreshLiveReads = useCallback(
    async (target = account) => {
      if (!target) {
        toast(t.connectToLoad, "warning")
        return
      }
      setIsReadingLive(true)
      setLiveError("")
      try {
        const client = createSafenetPublicClient(import.meta.env.VITE_RPC_URL)
        const [snapshot, health, validatorMetadata] = await Promise.all([
          readAccountSnapshot(client, target),
          readHealth(client),
          fetchValidators(undefined, { fallback: false }),
        ])
        setLiveSnapshot(snapshot)
        setLiveBlock(health.blockNumber)
        setLiveMerkleRoot(health.merkleRoot)
        setValidatorLoadError("")
        setValidators(await readValidatorPositions(client, target, validatorMetadata))

        try {
          const proof = await fetchRewardProof(target)
          setRewardProof(proof)
          const cumulativeAmount = proof ? BigInt(proof.cumulativeAmount) : 0n
          setLiveRewards(
            cumulativeAmount > snapshot.cumulativeClaimed ? cumulativeAmount - snapshot.cumulativeClaimed : 0n,
          )
        } catch {
          setRewardProof(null)
          setLiveRewards(0n)
        }

        toast(t.liveLoaded, "success")
      } catch (error) {
        const message = error instanceof Error ? error.message : t.liveDataFailed
        setLiveError(message)
        toast(message, "warning")
      } finally {
        setIsReadingLive(false)
      }
    },
    [account, t.connectToLoad, t.liveDataFailed, t.liveLoaded, toast],
  )

  useEffect(() => {
    if (!window.ethereum) return
    window.ethereum
      .request({ method: "eth_chainId" })
      .then((value) => setChainId(Number.parseInt(value as string, 16)))
      .catch(() => undefined)
    window.ethereum
      .request({ method: "eth_accounts" })
      .then(async (accounts) => {
        const [first] = accounts as Address[]
        if (!first) return
        setAccount(first)
        await refreshLiveReads(first)
      })
      .catch(() => undefined)

    const handleAccountsChanged = (accounts: unknown) => {
      const [first] = accounts as Address[]
      setAccount(first ?? null)
      setTxPlan(null)
      setLiveSnapshot(null)
      setRewardProof(null)
      setLiveRewards(null)
      if (first) void refreshLiveReads(first)
    }
    const handleChainChanged = (value: unknown) => {
      setChainId(Number.parseInt(value as string, 16))
      window.ethereum
        ?.request({ method: "eth_accounts" })
        .then((accounts) => {
          const [first] = accounts as Address[]
          if (first) void refreshLiveReads(first)
        })
        .catch(() => undefined)
    }
    window.ethereum.on?.("accountsChanged", handleAccountsChanged)
    window.ethereum.on?.("chainChanged", handleChainChanged)
    return () => {
      window.ethereum?.removeListener?.("accountsChanged", handleAccountsChanged)
      window.ethereum?.removeListener?.("chainChanged", handleChainChanged)
    }
  }, [refreshLiveReads])

  function closeToast(id: number) {
    setToasts((current) => current.filter((item) => item.id !== id))
  }

  function switchLocale() {
    const nextLocale: Locale = locale === "en" ? "zh" : "en"
    setLocale(nextLocale)
    window.localStorage.setItem("safecafe:locale", nextLocale)
  }

  function navigate(nextNav: NavItem) {
    setActiveNav(nextNav)
    setIsMenuOpen(false)
    if (nextNav === "stake") setAction("stake")
    if (nextNav === "unstake") setAction("unstake")
    if (nextNav === "withdrawals") setAction("claim-withdrawal")
    if (nextNav === "rewards") setAction("claim-rewards")
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
    try {
      const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[]
      setAccount(accounts[0])
      await ensureMainnet()
      toast(t.walletReady, "success")
      await refreshLiveReads(accounts[0])
    } catch (error) {
      toast(error instanceof Error ? error.message : t.wrongNetwork, "warning")
    }
  }

  function disconnectWallet() {
    setAccount(null)
    setLiveSnapshot(null)
    setLiveRewards(null)
    setRewardProof(null)
    setTxPlan(null)
    setTxProgress("")
    toast(t.walletDisconnected, "info")
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
    await refreshLiveReads(account)
  }

  async function buildPlan(nextAction = action) {
    if (!account || !liveSnapshot) {
      setTxPlan(null)
      toast(t.connectToPlan, "warning")
      return
    }
    const validation = validateAction(nextAction)
    if (validation) {
      setTxPlan(null)
      toast(validation, "warning")
      return
    }
    try {
      let nextPlan: TxPlan | null = null
      if (nextAction === "stake") {
        nextPlan = planStake({ validator, amount, account, allowance: liveSnapshot.stakingAllowance })
      }
      if (nextAction === "unstake") {
        nextPlan = planUnstake({ validator, amount, account })
      }
      if (nextAction === "claim-withdrawal") {
        nextPlan = planClaimWithdrawal(account)
      }
      if (nextAction === "claim-rewards") {
        if (!rewardProof?.proof) throw new Error(t.noProof)
        if (liveMerkleRoot && rewardProof.merkleRoot.toLowerCase() !== liveMerkleRoot.toLowerCase()) {
          throw new Error(t.merkleMismatch)
        }
        if ((liveRewards ?? 0n) <= 0n) throw new Error(t.noProof)
        nextPlan = planClaimRewards({
          account,
          cumulativeAmount: BigInt(rewardProof.cumulativeAmount),
          merkleRoot: rewardProof.merkleRoot,
          proof: rewardProof.proof,
        })
      }
      if (!nextPlan) return
      const simulatedPlan = await simulateTxPlan(nextPlan)
      setTxPlan(simulatedPlan)
      if (simulatedPlan.simulation?.status === "failed") {
        toast(simulatedPlan.simulation.message, "warning")
        return
      }
      toast(t.planReady, "success")
    } catch (error) {
      toast(error instanceof Error ? error.message : t.buildPlanFailed, "warning")
    }
  }

  async function simulateTxPlan(plan: TxPlan): Promise<TxPlan> {
    if (!account) return plan
    const client = createSafenetPublicClient(import.meta.env.VITE_RPC_URL)
    const txsToSimulate = plan.action === "stake" && plan.txs.length > 1 ? plan.txs.slice(0, 1) : plan.txs
    try {
      for (const tx of txsToSimulate) {
        await client.call({
          account,
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

  async function submitPlan() {
    if (!txPlan) return
    if (!window.ethereum) {
      toast(t.noWallet, "warning")
      return
    }
    if (!account) {
      await connectWallet()
      return
    }
    setIsSubmitting(true)
    setTxProgress("")
    try {
      await ensureMainnet()
      const validation = validateAction(txPlan.action)
      if (validation) throw new Error(validation)
      if (!txPlan.simulation) throw new Error(t.connectToPlan)
      if (txPlan.simulation.status === "failed") throw new Error(txPlan.simulation.message)
      const client = createWalletClient({
        account,
        chain: mainnet,
        transport: custom(window.ethereum),
      })
      const publicClient = createSafenetPublicClient(import.meta.env.VITE_RPC_URL)
      for (const tx of txPlan.txs) {
        setTxProgress(`${t.simulationStatus}: ${translateTxLabel(tx.label, t)}`)
        try {
          await publicClient.call({
            account,
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
      await refreshLiveReads(account)
    } catch (error) {
      toast(error instanceof Error ? error.message : t.transactionFailed, "warning")
    } finally {
      setIsSubmitting(false)
      setTxProgress("")
    }
  }

  function validateAction(targetAction = action): string | null {
    if (!account || !liveSnapshot) return t.connectToPlan
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

  function selectAction(nextAction: Action) {
    setAction(nextAction)
    if (account && liveSnapshot) {
      void buildPlan(nextAction)
    } else {
      setTxPlan(null)
    }
  }

  function exportSafePayload() {
    if (!txPlan) {
      toast(t.connectToPlan, "warning")
      return
    }
    const payload = toSafeTransactionPayload(txPlan, CHAIN_ID, {
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
              <span>S</span>
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
              aria-label={account ? t.wallet : t.connectWallet}
            >
              <Wallet size={17} />
              <span>{account ? compactAddress(account, 5, 4) : t.connectWallet}</span>
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
              <button type="button" className="language-pill" onClick={switchLocale} aria-label={t.switchLanguage}>
                <Languages size={17} />
                <span>{locale === "en" ? "中文" : "EN"}</span>
              </button>
              <button
                type="button"
                className="wallet-pill"
                onClick={() => (account ? setModal({ type: "wallet" }) : connectWallet())}
              >
                <Wallet size={18} />
                <span>
                  <strong>{account ? compactAddress(account, 6, 4) : t.connectWallet}</strong>
                  <small>{account ? t.connected : t.notConnected}</small>
                </span>
                <ChevronDown size={16} />
              </button>
            </div>
          </div>
          <div className="sidebar-project">
            <Shield size={22} />
            <strong>Safecafe</strong>
            <ChevronDown size={17} />
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
              <p>{liveSnapshot && account ? `${t.liveDataFor} ${compactAddress(account)}.` : t.connectToBegin}</p>
            </div>
            <div className="button-row">
              <div className={`price-chip ${safePrice.stale ? "stale" : ""}`}>
                <strong>{safePrice.usd === null ? t.priceUnavailable : `$${safePrice.usd.toFixed(3)}`}</strong>
                <small>{priceStatusLabel(safePrice, t)}</small>
              </div>
              <button type="button" className="soft-button" disabled={isReadingLive} onClick={refreshOrConnect}>
                <Database size={16} />
                {isReadingLive ? t.reading : t.refreshLive}
              </button>
            </div>
          </div>
          {liveError && <p className="warning">{liveError}</p>}
          {!account && (
            <div className="connect-panel">
              <Wallet size={20} />
              <div>
                <strong>{t.connectWallet}</strong>
                <small>{t.connectWalletHint}</small>
              </div>
              <button type="button" className="primary-button" onClick={connectWallet}>
                {t.connectWallet}
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

        {(activeNav === "dashboard" || activeNav === "stake" || activeNav === "unstake") && (
          <DashboardView
            t={t}
            action={action}
            amount={amount}
            accountReady={hasLiveAccountData}
            connectedAccount={connectedAccount}
            copyText={copyText}
            isLoadingValidators={isLoadingValidators}
            isSubmitting={isSubmitting}
            modal={modal}
            onConnect={refreshOrConnect}
            openExplorer={openExplorer}
            exportSafePayload={exportSafePayload}
            selectAction={selectAction}
            selectedValidator={selectedValidator}
            setActiveNav={navigate}
            setAmount={updateAmount}
            setModal={setModal}
            setValidator={updateValidator}
            showOnlyActive={showOnlyActive}
            submitPlan={submitPlan}
            txProgress={txProgress}
            txPlan={txPlan?.action === action ? txPlan : null}
            validator={validator}
            visibleValidators={dashboardValidators}
            validators={dashboardValidators}
            buildPlan={buildPlan}
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
                updateValidator(nextValidator)
                selectAction("stake")
                navigate("stake")
              }}
              onUnstake={(nextValidator) => {
                updateValidator(nextValidator)
                selectAction("unstake")
                navigate("unstake")
              }}
            />
          </FullPanel>
        )}
        {activeNav === "rewards" && (
          <RewardsView
            account={connectedAccount}
            copyText={copyText}
            t={t}
            exportSafePayload={exportSafePayload}
            isSubmitting={isSubmitting}
            selectAction={selectAction}
            selectedValidator={selectedValidator}
            summary={displaySummary}
            dataStatus={dataStatus}
            submitPlan={submitPlan}
            txPlan={txPlan?.action === "claim-rewards" ? txPlan : null}
            txProgress={txProgress}
          />
        )}
        {activeNav === "withdrawals" && (
          <WithdrawalsView
            account={connectedAccount}
            copyText={copyText}
            t={t}
            exportSafePayload={exportSafePayload}
            isSubmitting={isSubmitting}
            selectAction={selectAction}
            selectedValidator={selectedValidator}
            summary={displaySummary}
            submitPlan={submitPlan}
            txPlan={txPlan?.action === "claim-withdrawal" ? txPlan : null}
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
          copyText={copyText}
          dataStatus={dataStatus}
          disconnectWallet={disconnectWallet}
          modal={modal}
          onClose={() => setModal(null)}
          openExplorer={openExplorer}
          t={t}
        />
      )}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((item) => (
          <ToastItem
            closeLabel={t.closeNotification}
            item={item}
            key={item.id}
            notificationLabel={t.notification}
            onClose={() => closeToast(item.id)}
          />
        ))}
      </div>
    </div>
  )
}

function ToastItem(props: { closeLabel: string; item: Toast; notificationLabel: string; onClose: () => void }) {
  const Icon = props.item.tone === "success" ? CircleCheck : props.item.tone === "warning" ? CircleAlert : Info
  return (
    <div className={`toast ${props.item.tone ?? "info"}`}>
      <Icon size={18} />
      <span>
        <strong>{props.item.title ?? props.notificationLabel}</strong>
        <small>{props.item.message}</small>
      </span>
      <button type="button" onClick={props.onClose} aria-label={props.closeLabel}>
        <X size={16} />
      </button>
    </div>
  )
}

function compareBigintDesc(a: bigint, b: bigint) {
  if (a === b) return 0
  return a > b ? -1 : 1
}
