import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  FilePlus2,
  Loader2,
  MessageSquare,
  Play,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  ShieldQuestion,
  Square,
  Trash2,
  Wallet,
  Wrench,
  X,
} from "lucide-react"
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react"
import { type Address, isAddress } from "viem"
import {
  type AgentAmount,
  AgentApiError,
  type AgentContext,
  type AgentIntent,
  type AgentPlan,
  type AgentRisk,
  type AgentValidatorRef,
  compileAgentPlan,
  flattenCurrentExecutableTxPlan,
  flattenExecutableTxPlan,
  hasAgentServiceAccess,
  parseAgentInstruction,
  readStoredAgentSessions,
  requestAgentReplyStream,
  serializeAgentSessions,
  toAgentChatContext,
  type UserLlmConfig,
} from "../agent"
import { compactAddress, formatSafe, type TxPlan } from "../protocol"
import { AgentLogo } from "./AgentLogo"
import { type ChainTxStepStatus, chainActionBusyLabel, chainTxStepStatuses } from "./actionStatus"
import { isAgentAuthRequired } from "./agentAuthConfig"
import { translateTxLabel, translateTxWarning } from "./formatters"
import type { MessageBundle } from "./i18n"
import { appStorageKeys, readStorageText, removeStorageValue, writeStorageJson, writeStorageText } from "./persistence"
import type { ActionExecutionSummary } from "./types"
import { ButtonBusyLabel, ConfirmDialog, ExecutionSummaryCard, Tooltip } from "./ui"

type AgentChatMessage = {
  id: string
  role: "assistant" | "tool" | "user"
  content: string
  isLoading?: boolean
  thinking?: string
  thinkingPinned?: boolean
  thinkingOpen?: boolean
  contentExpanded?: boolean
}

type PreparedStakingActionData = {
  intent?: AgentIntent
  requiresWalletConfirmation?: boolean
}

type AgentSession = {
  composerText: string
  draft: AgentPlan | null
  draftKey: string
  executablePlan: TxPlan | null
  id: string
  title: string
  messages: AgentChatMessage[]
  pendingIntentText: string
  warningsAccepted: boolean
}

type AgentAuthStatus =
  | "auth-disabled"
  | "connected"
  | "custom-llm"
  | "needs-live-data"
  | "needs-signature"
  | "no-access"
  | "no-wallet"

export type AgentChatDialogProps = {
  t: MessageBundle
  isOpen: boolean
  isClosing?: boolean
  anchor: { x: number; y: number } | null
  context: AgentContext
  executionState: ActionExecutionSummary | null
  isSubmitting: boolean
  txProgress: string
  userLlmConfig: UserLlmConfig | null
  rpcAuthToken: string | null
  onAuthenticateAgent: () => Promise<string | null>
  onClose: () => void
  onConnectWallet: () => Promise<void>
  onContinueSafeProposal: () => void
  onCopySafeTxHash: (safeTxHash: string) => void
  onExportSafePayload: () => void
  onRefreshLiveData: () => Promise<AgentContext | null>
  onSimulatePlan: (plan: TxPlan) => Promise<TxPlan>
  onSubmitPlan: (plan: TxPlan) => Promise<void>
}

const agentAuthRequired = isAgentAuthRequired()
export function AgentChatDialog(props: AgentChatDialogProps) {
  const [sessions, setSessions] = useState<AgentSession[]>(() => loadStoredSessions(props.t.agentNewSession))
  const [activeSessionId, setActiveSessionId] = useState(() => loadStoredActiveSessionId(sessions))
  const [isDrafting, setIsDrafting] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [isSessionMenuOpen, setIsSessionMenuOpen] = useState(false)
  const [isStopConfirmOpen, setIsStopConfirmOpen] = useState(false)
  const composerId = useId()
  const requestSeqRef = useRef(0)
  const contextKeyRef = useRef("")
  const streamAbortRef = useRef<AbortController | null>(null)
  const executedToolCallsRef = useRef(new Set<string>())
  const dialogRef = useRef<HTMLElement>(null)
  const sessionMenuRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const messageListRef = useRef<HTMLDivElement>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)
  const didHydrateStorageRef = useRef(false)

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0]
  const input = activeSession?.composerText ?? ""
  const currentContextKey = agentContextKey(props.context)
  const isStale = Boolean(activeSession.draft && activeSession.draftKey && activeSession.draftKey !== currentContextKey)
  const blocked = activeSession.draft?.risks.some((risk) => risk.severity === "blocked") ?? false
  const warnings = useMemo(
    () => collectWarnings(activeSession.draft, activeSession.executablePlan),
    [activeSession.draft, activeSession.executablePlan],
  )
  const canUsePlan = Boolean(
    activeSession.executablePlan &&
      activeSession.executablePlan.simulation?.status !== "failed" &&
      !blocked &&
      !isStale &&
      (warnings.length === 0 || activeSession.warningsAccepted),
  )
  const agentAccess = hasAgentServiceAccess(props.context)
  const agentChatRequiresServerAuth = agentAuthRequired && !props.userLlmConfig
  const authStatus = resolveAgentAuthStatus(
    props.context,
    agentAccess,
    props.rpcAuthToken,
    agentChatRequiresServerAuth,
    Boolean(props.userLlmConfig),
  )
  const authStatusView = getAgentAuthStatusView(authStatus, props.t)
  const canChat = authStatus === "connected" || authStatus === "auth-disabled" || authStatus === "custom-llm"
  const canStopAgentRun = isDrafting || isStreaming
  const isAgentBusy = canStopAgentRun
  const lastMessage = activeSession.messages[activeSession.messages.length - 1]
  const scrollSignal = useMemo(
    () =>
      [
        activeSession.id,
        activeSession.messages.length,
        lastMessage?.content.length ?? 0,
        lastMessage?.isLoading ? "loading" : "idle",
        activeSession.draft ? "draft" : "empty",
        activeSession.executablePlan?.txs.length ?? 0,
      ].join(":"),
    [activeSession.draft, activeSession.executablePlan, activeSession.id, activeSession.messages.length, lastMessage],
  )

  useEffect(() => {
    if (!props.isOpen) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        if (isStopConfirmOpen) return
        if (isSessionMenuOpen) {
          setIsSessionMenuOpen(false)
        }
        return
      }
      if (isStopConfirmOpen) return
      if (event.key === "Tab") trapFocus(event, dialogRef.current)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [isSessionMenuOpen, isStopConfirmOpen, props.isOpen])

  useEffect(() => {
    if (!isSessionMenuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!sessionMenuRef.current?.contains(target)) setIsSessionMenuOpen(false)
    }
    window.addEventListener("pointerdown", onPointerDown)
    return () => window.removeEventListener("pointerdown", onPointerDown)
  }, [isSessionMenuOpen])

  useEffect(() => {
    if (!props.isOpen) return
    const frame = window.requestAnimationFrame(() => composerRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [props.isOpen])

  useEffect(() => {
    if (!props.isOpen || !composerRef.current) return
    void input
    resizeComposer(composerRef.current)
  }, [input, props.isOpen])

  useEffect(() => {
    if (!canStopAgentRun && isStopConfirmOpen) setIsStopConfirmOpen(false)
  }, [canStopAgentRun, isStopConfirmOpen])

  useEffect(() => {
    if (!sessions.some((session) => session.id === activeSessionId) && sessions[0]) setActiveSessionId(sessions[0].id)
  }, [activeSessionId, sessions])

  useEffect(() => {
    if (!didHydrateStorageRef.current) {
      didHydrateStorageRef.current = true
      return
    }
    if (typeof window === "undefined") return
    writeStorageJson(appStorageKeys.agentSessions, serializeAgentSessions(sessions))
    writeStorageText(appStorageKeys.agentActiveSession, activeSessionId)
  }, [activeSessionId, sessions])

  useEffect(() => {
    void scrollSignal
    if (!props.isOpen) return
    const scrollToLatest = () => {
      messageEndRef.current?.scrollIntoView({ block: "end" })
      const list = messageListRef.current
      if (list) list.scrollTop = list.scrollHeight
    }
    const frame = window.requestAnimationFrame(scrollToLatest)
    const timer = window.setTimeout(scrollToLatest, 80)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [props.isOpen, scrollSignal])

  useEffect(() => {
    if (!contextKeyRef.current) {
      contextKeyRef.current = currentContextKey
      return
    }
    if (contextKeyRef.current === currentContextKey) return
    contextKeyRef.current = currentContextKey
    if (activeSession.draftKey && activeSession.draftKey === currentContextKey) return
    requestSeqRef.current += 1
    executedToolCallsRef.current.clear()
    streamAbortRef.current?.abort()
    streamAbortRef.current = null
    setIsDrafting(false)
    setIsStreaming(false)
    setSessions((current) =>
      current.map((session) =>
        session.id === activeSessionId
          ? {
              ...session,
              executablePlan: null,
              pendingIntentText: "",
              warningsAccepted: false,
            }
          : session,
      ),
    )
  }, [activeSession.draftKey, activeSessionId, currentContextKey])

  async function send(text = input) {
    const trimmed = text.trim()
    if (!trimmed || isAgentBusy) return
    if (canChat && isConfirmationText(trimmed) && activeSession.executablePlan) {
      setComposerText("")
      resetComposer(composerRef.current)
      updateActiveSession((session) => ({
        ...session,
        composerText: "",
        messages: [...session.messages, createMessage("user", trimmed)],
      }))
      if (!canUsePlan) {
        updateActiveSession((session) => ({
          ...session,
          messages: [
            ...session.messages,
            createMessage("assistant", resolvePlanNotReadyMessage(props.t, warnings, activeSession.executablePlan)),
          ],
        }))
        return
      }
      if (props.isSubmitting) {
        updateActiveSession((session) => ({
          ...session,
          messages: [...session.messages, createMessage("assistant", props.t.agentTransactionInProgress)],
        }))
        return
      }
      void submitActivePlan()
      return
    }
    if (!canChat) {
      setComposerText("")
      resetComposer(composerRef.current)
      updateActiveSession((session) => ({
        ...session,
        composerText: "",
        messages: [...session.messages, createMessage("assistant", authStatusView.body)],
      }))
      return
    }
    const requestId = requestSeqRef.current + 1
    requestSeqRef.current = requestId
    const requestSessionId = activeSession.id
    setComposerText("")
    resetComposer(composerRef.current)
    const history = activeSession.messages
      .filter((message) => message.role === "assistant" || message.role === "tool" || message.role === "user")
      .map(({ role, content }) => ({ role: role as "assistant" | "tool" | "user", content }))
    updateActiveSession((session) => ({
      ...session,
      composerText: "",
      draft: null,
      draftKey: "",
      executablePlan: null,
      title: session.messages.length === 0 ? trimmed.slice(0, 36) : session.title,
      messages: [...session.messages, createMessage("user", trimmed)],
      warningsAccepted: false,
    }))

    const candidate = shouldStartNewIntent(trimmed)
      ? trimmed
      : joinPendingIntent(activeSession.pendingIntentText, trimmed)
    updateActiveSession((session) => ({ ...session, pendingIntentText: "" }))
    const authToken = agentChatRequiresServerAuth ? (props.rpcAuthToken ?? (await props.onAuthenticateAgent())) : null
    if (agentChatRequiresServerAuth && !authToken) {
      updateActiveSession((session) => ({
        ...session,
        messages: [...session.messages, createMessage("assistant", props.t.agentAuthRequired)],
      }))
      return
    }
    const result = await appendAgentReply(candidate, history, requestId, requestSessionId, authToken)
    if (requestSeqRef.current !== requestId) return
    if (result.preparedIntent) {
      await buildAndSimulateAgentPlan(candidate, result.preparedIntent, requestId, requestSessionId)
      return
    }
    if (result.source === "fallback") {
      await runLocalPlanFallback(candidate, requestId, requestSessionId)
    }
  }

  async function appendAgentReply(
    message: string,
    history: Array<{ role: "assistant" | "tool" | "user"; content: string }>,
    requestId: number,
    sessionId: string,
    authToken: string | null,
  ): Promise<{ preparedIntent: AgentIntent | null; source: "fallback" | "llm" | null }> {
    if (agentChatRequiresServerAuth && !agentAccess) return { preparedIntent: null, source: null }
    const assistantId = createId()
    const controller = new AbortController()
    let preparedIntent: AgentIntent | null = null
    let source: "fallback" | "llm" | null = null
    const clientToolResults: Array<Promise<string | null>> = []
    streamAbortRef.current?.abort()
    streamAbortRef.current = controller
    setIsStreaming(true)
    updateSession(sessionId, (session) => ({
      ...session,
      messages: [...session.messages, { id: assistantId, role: "assistant", content: "", isLoading: true }],
    }))
    try {
      await requestAgentReplyStream(
        {
          authToken,
          message,
          messages: history,
          context: toAgentChatContext(props.context),
        },
        (event) => {
          if (requestSeqRef.current !== requestId) return
          if (event.type === "thinking")
            updateMessage(sessionId, assistantId, (item) => ({
              ...item,
              thinking: event.content,
              thinkingOpen: item.thinkingPinned ? item.thinkingOpen : false,
            }))
          if (event.type === "delta") {
            updateMessage(sessionId, assistantId, (item) => ({
              ...item,
              content: item.content + event.content,
              isLoading: false,
            }))
          }
          if (event.type === "tool") {
            upsertToolMessage(sessionId, event.callId, event.content || event.name, event.status === "running")
            const clientTool = runClientTool(event, sessionId)
            if (clientTool) clientToolResults.push(clientTool)
            const intent = event.status === "completed" ? readPreparedIntent(event.name, event.data) : null
            if (intent) preparedIntent = intent
          }
          if (event.type === "final") {
            source = event.source
            updateMessage(sessionId, assistantId, (item) => ({ ...item, content: event.content, isLoading: false }))
          }
        },
        controller.signal,
        props.userLlmConfig,
      )
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return { preparedIntent, source }
      if (requestSeqRef.current === requestId) {
        updateMessage(sessionId, assistantId, (item) => ({
          ...item,
          content: resolveAgentApiErrorMessage(error, props.t),
          isLoading: false,
        }))
      }
      source = null
    } finally {
      if (streamAbortRef.current === controller) streamAbortRef.current = null
      if (requestSeqRef.current === requestId) setIsStreaming(false)
    }
    const summaries = (await Promise.all(clientToolResults)).filter((summary): summary is string => Boolean(summary))
    if (requestSeqRef.current === requestId && summaries.length > 0) {
      updateSession(sessionId, (session) => ({
        ...session,
        messages: [...session.messages, ...summaries.map((summary) => createMessage("assistant", summary))],
      }))
    }
    return { preparedIntent, source }
  }

  async function buildAndSimulateAgentPlan(
    instruction: string,
    intent: AgentIntent,
    requestId: number,
    sessionId: string,
  ) {
    if (!props.context.account || !props.context.subjectAccount || !props.context.liveSnapshot) {
      updateSession(sessionId, (session) => ({
        ...session,
        messages: [
          ...session.messages,
          createMessage(
            "assistant",
            props.context.account ? props.t.agentWalletRequired : props.t.agentPreviewWithoutWallet,
          ),
        ],
      }))
      return
    }
    setIsDrafting(true)
    try {
      upsertToolMessage(sessionId, "local-compile-plan", props.t.agentToolCompilePlan, true)
      const nextDraft = compileAgentPlan(instruction, intent, props.context)
      if (requestSeqRef.current !== requestId) return
      if (shouldReplyWithoutActionCard(nextDraft)) {
        updateSession(sessionId, (session) => ({
          ...session,
          draft: null,
          draftKey: "",
          executablePlan: null,
          pendingIntentText: "",
          messages: [...session.messages, createMessage("assistant", directGuidanceText(nextDraft, props.t))],
        }))
        return
      }
      updateSession(sessionId, (session) => ({ ...session, draft: nextDraft }))
      upsertToolMessage(sessionId, "local-simulate-plan", props.t.agentToolSimulatePlan, true)
      const flattened = flattenExecutableTxPlan(nextDraft) ?? flattenCurrentExecutableTxPlan(nextDraft)
      const simulated = flattened ? await props.onSimulatePlan(flattened) : null
      if (requestSeqRef.current !== requestId) return
      updateSession(sessionId, (session) => ({
        ...session,
        draftKey: currentContextKey,
        executablePlan: simulated,
      }))
      finishToolMessage(sessionId, "local-compile-plan", props.t.agentToolReady)
      finishToolMessage(
        sessionId,
        "local-simulate-plan",
        simulated?.simulation?.status === "failed" ? props.t.agentToolFailed : props.t.agentToolReady,
      )
      updateSession(sessionId, (session) => ({
        ...session,
        messages: [
          ...session.messages,
          createMessage(
            "assistant",
            simulated?.simulation?.status === "failed"
              ? props.t.agentPlanSimulationFailed
              : simulated
                ? props.t.agentPlanReady
                : props.t.agentPlanDrafted,
          ),
        ],
      }))
    } catch (error) {
      finishToolMessage(sessionId, "local-compile-plan", props.t.agentToolFailed)
      finishToolMessage(sessionId, "local-simulate-plan", props.t.agentToolFailed)
      updateSession(sessionId, (session) => ({
        ...session,
        messages: [
          ...session.messages,
          createMessage("assistant", error instanceof Error ? error.message : props.t.buildPlanFailed),
        ],
      }))
    } finally {
      if (requestSeqRef.current === requestId) setIsDrafting(false)
    }
  }

  async function runLocalPlanFallback(candidate: string, requestId: number, sessionId: string) {
    const parse = parseAgentInstruction(candidate, props.context.validators)
    if (parse.status === "ok") {
      await buildAndSimulateAgentPlan(candidate, parse.intent, requestId, sessionId)
      return
    }
    if (parse.status === "needs-clarification") {
      updateSession(sessionId, (session) => ({
        ...session,
        pendingIntentText: candidate,
        messages: [...session.messages, createMessage("assistant", localizeClarification(parse.question, props.t))],
      }))
      return
    }
    updateSession(sessionId, (session) => ({
      ...session,
      messages: [...session.messages, createMessage("assistant", riskText(parse.risks, props.t))],
    }))
  }

  function createNewSession() {
    requestSeqRef.current += 1
    executedToolCallsRef.current.clear()
    resetBusy()
    const session = createSession(props.t.agentNewSession)
    setSessions((current) => [session, ...current].slice(0, 5))
    setActiveSessionId(session.id)
    setIsSessionMenuOpen(false)
  }

  function clearSession() {
    requestSeqRef.current += 1
    executedToolCallsRef.current.clear()
    resetBusy()
    updateActiveSession((session) => ({
      ...session,
      composerText: "",
      draft: null,
      draftKey: "",
      executablePlan: null,
      messages: [],
      pendingIntentText: "",
      warningsAccepted: false,
    }))
    setIsSessionMenuOpen(false)
  }

  function clearAllSessions() {
    requestSeqRef.current += 1
    executedToolCallsRef.current.clear()
    resetBusy()
    const session = createSession(props.t.agentNewSession)
    setSessions([session])
    setActiveSessionId(session.id)
    setIsSessionMenuOpen(false)
    if (typeof window !== "undefined") {
      removeStorageValue(appStorageKeys.agentSessions)
      removeStorageValue(appStorageKeys.agentActiveSession)
    }
  }

  function selectSession(sessionId: string) {
    if (sessionId === activeSessionId) {
      setIsSessionMenuOpen(false)
      return
    }
    requestSeqRef.current += 1
    executedToolCallsRef.current.clear()
    resetBusy()
    setActiveSessionId(sessionId)
    setIsSessionMenuOpen(false)
  }

  function resetBusy() {
    streamAbortRef.current?.abort()
    streamAbortRef.current = null
    setIsDrafting(false)
    setIsStreaming(false)
  }

  function stopAgentRun() {
    setIsStopConfirmOpen(false)
    requestSeqRef.current += 1
    executedToolCallsRef.current.clear()
    streamAbortRef.current?.abort()
    streamAbortRef.current = null
    resetBusy()
    updateActiveSession((session) => ({
      ...session,
      messages: session.messages.map((message) =>
        message.isLoading
          ? {
              ...message,
              content: message.content || props.t.agentStopped,
              isLoading: false,
            }
          : message,
      ),
    }))
  }

  function updateActiveSession(updater: (session: AgentSession) => AgentSession) {
    updateSession(activeSessionId, updater)
  }

  function setComposerText(nextText: string) {
    updateActiveSession((session) => ({ ...session, composerText: nextText }))
  }

  function updateSession(sessionId: string, updater: (session: AgentSession) => AgentSession) {
    setSessions((current) => current.map((session) => (session.id === sessionId ? updater(session) : session)))
  }

  function updateMessage(
    sessionId: string,
    messageId: string,
    updater: (message: AgentChatMessage) => AgentChatMessage,
  ) {
    updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.map((message) => (message.id === messageId ? updater(message) : message)),
    }))
  }

  function finishToolMessage(sessionId: string, toolCallId: string, content: string) {
    updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.map((message) =>
        message.id === toolCallId && message.role === "tool" ? { ...message, content, isLoading: false } : message,
      ),
    }))
  }

  function upsertToolMessage(sessionId: string, toolCallId: string, content: string, isLoading: boolean) {
    updateSession(sessionId, (session) => {
      const existingIndex = session.messages.findIndex(
        (message) => message.id === toolCallId && message.role === "tool",
      )
      if (existingIndex >= 0) {
        return {
          ...session,
          messages: session.messages.map((message, index) =>
            index === existingIndex ? { ...message, content, isLoading } : message,
          ),
        }
      }
      return {
        ...session,
        messages: [...session.messages, { id: toolCallId, role: "tool", content, isLoading }],
      }
    })
  }

  function runClientTool(
    event: {
      callId: string
      name: string
      status: "completed" | "failed" | "running"
      data?: unknown
    },
    sessionId: string,
  ): Promise<string | null> | null {
    if (event.status !== "completed") return null
    if (!isRefreshLiveDataTool(event.name, event.data)) return null
    const toolKey = `${requestSeqRef.current}:${sessionId}:${event.callId}`
    if (executedToolCallsRef.current.has(toolKey)) return null
    executedToolCallsRef.current.add(toolKey)
    return refreshLiveDataForAgent(sessionId, event.callId)
  }

  async function refreshLiveDataForAgent(sessionId: string, toolCallId: string) {
    upsertToolMessage(sessionId, toolCallId, props.t.agentToolRefreshLiveData, true)
    try {
      const refreshed = await props.onRefreshLiveData()
      if (!refreshed) {
        finishToolMessage(sessionId, toolCallId, props.t.agentToolFailed)
        return props.t.liveDataFailed
      }
      finishToolMessage(sessionId, toolCallId, props.t.agentToolReady)
      return formatLiveAccountSummary(refreshed, props.t)
    } catch {
      finishToolMessage(sessionId, toolCallId, props.t.agentToolFailed)
      return props.t.liveDataFailed
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return
    event.preventDefault()
    void send()
  }

  function handleAuthStatusAction() {
    if (!authStatusView.actionable) return
    if (authStatus === "no-wallet") {
      void props.onConnectWallet()
      return
    }
    if (authStatus === "needs-signature") {
      void props.onAuthenticateAgent()
    }
  }

  async function submitActivePlan() {
    const plan = activeSession.executablePlan
    if (!plan || !canUsePlan || props.isSubmitting) return
    await props.onSubmitPlan({
      ...plan,
      action: "agent-plan",
    })
  }

  async function regenerateActivePlan() {
    const draft = activeSession.draft
    if (!draft || isAgentBusy || props.isSubmitting) return
    const requestId = requestSeqRef.current + 1
    requestSeqRef.current = requestId
    executedToolCallsRef.current.clear()
    streamAbortRef.current?.abort()
    streamAbortRef.current = null
    updateActiveSession((session) => ({
      ...session,
      executablePlan: null,
      warningsAccepted: false,
    }))
    await buildAndSimulateAgentPlan(describeIntent(draft.intent), draft.intent, requestId, activeSession.id)
  }

  return (
    <section
      ref={dialogRef}
      className={`agent-dialog${props.isClosing ? " closing" : ""}`}
      role="dialog"
      aria-modal={props.isOpen}
      aria-hidden={!props.isOpen}
      aria-label={props.t.agentTitle}
      aria-busy={isAgentBusy}
      inert={!props.isOpen}
      style={props.anchor ? dialogPosition() : undefined}
    >
      <div className="agent-dialog-header">
        <div className="agent-dialog-identity">
          <AgentLogo />
          <span>
            <strong>{props.t.agentTitle}</strong>
            <small>
              {props.context.subjectAccount
                ? compactAddress(props.context.subjectAccount)
                : props.context.account
                  ? compactAddress(props.context.account)
                  : props.t.notConnected}
            </small>
          </span>
        </div>
        <div className="agent-header-actions">
          <Tooltip label={`${authStatusView.title}. ${authStatusView.body}`}>
            <button
              type="button"
              className={`agent-auth-status ${authStatusView.tone}`}
              aria-label={authStatusView.title}
              aria-disabled={!authStatusView.actionable}
              onClick={handleAuthStatusAction}
            >
              <AgentAuthStatusIcon status={authStatus} />
            </button>
          </Tooltip>
          <div className={`agent-session-menu ${isSessionMenuOpen ? "open" : ""}`} ref={sessionMenuRef}>
            <button
              type="button"
              className="agent-session-trigger"
              aria-haspopup="menu"
              aria-expanded={isSessionMenuOpen}
              aria-label={props.t.agentSessions}
              onClick={() => setIsSessionMenuOpen((value) => !value)}
            >
              <MessageSquare size={16} />
              <span>
                <strong>{activeSession.title}</strong>
                <small>{props.t.agentSessionCount.replace("{count}", sessions.length.toString())}</small>
              </span>
              <ChevronDown size={15} />
            </button>
            {isSessionMenuOpen && (
              <div className="agent-session-popover" role="menu" aria-label={props.t.agentSessions}>
                <div className="agent-session-popover-title">
                  <span>{props.t.agentSessionHistory}</span>
                  <button type="button" role="menuitem" onClick={createNewSession}>
                    <FilePlus2 size={15} />
                    {props.t.agentNewSession}
                  </button>
                </div>
                <div className="agent-session-list">
                  {sessions.map((session) => (
                    <button
                      type="button"
                      className={session.id === activeSessionId ? "active" : ""}
                      key={session.id}
                      role="menuitemradio"
                      aria-checked={session.id === activeSessionId}
                      onClick={() => selectSession(session.id)}
                    >
                      <span>
                        <strong>{session.title}</strong>
                        <small>
                          {session.messages.length
                            ? props.t.agentMessageCount.replace("{count}", session.messages.length.toString())
                            : props.t.agentEmptySession}
                        </small>
                      </span>
                      {session.id === activeSessionId && <Check size={15} />}
                    </button>
                  ))}
                </div>
                <button type="button" className="agent-session-clear" role="menuitem" onClick={clearSession}>
                  <Trash2 size={15} />
                  {props.t.agentClearSession}
                </button>
                <button type="button" className="agent-session-clear danger" role="menuitem" onClick={clearAllSessions}>
                  <Trash2 size={15} />
                  {props.t.agentClearAllSessions}
                </button>
              </div>
            )}
          </div>
          <button type="button" className="agent-icon-button" onClick={props.onClose} aria-label={props.t.agentClose}>
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="agent-message-list" ref={messageListRef}>
        <article className="agent-message assistant">{props.t.agentGreeting}</article>
        {authStatus === "no-wallet" ? (
          <AgentDisconnectedPanel t={props.t} onConnectWallet={props.onConnectWallet} />
        ) : (
          authStatus !== "connected" &&
          authStatus !== "auth-disabled" &&
          authStatus !== "custom-llm" && (
            <article className="agent-access-panel">
              <AgentAuthStatusIcon status={authStatus} />
              <span>{authStatusView.body}</span>
            </article>
          )
        )}
        {props.context.account && (
          <div className="agent-prompt-chip-row">
            {[
              props.t.agentPromptClaimRewards,
              props.t.agentPromptStake,
              props.t.agentPromptRestake,
              props.t.agentPromptRebalance,
            ].map((prompt) => (
              <Tooltip label={!canChat ? authStatusView.body : prompt} key={prompt}>
                <button type="button" disabled={!canChat || isAgentBusy} onClick={() => void send(prompt)}>
                  {prompt}
                </button>
              </Tooltip>
            ))}
          </div>
        )}
        <div className="agent-message-log" role="log" aria-live="polite" aria-relevant="additions">
          {activeSession.messages.map((message) => (
            <AgentMessageView
              t={props.t}
              message={message}
              key={message.id}
              onToggleThinking={() =>
                updateMessage(activeSessionId, message.id, (item) => {
                  const thinkingOpen = !item.thinkingOpen
                  return {
                    ...item,
                    thinkingOpen,
                    thinkingPinned: true,
                  }
                })
              }
              onToggleContent={() =>
                updateMessage(activeSessionId, message.id, (item) => ({
                  ...item,
                  contentExpanded: item.contentExpanded === false,
                }))
              }
            />
          ))}
        </div>
        {activeSession.draft && (
          <AgentPlanCard
            t={props.t}
            draft={activeSession.draft}
            executablePlan={activeSession.executablePlan}
            isStale={isStale}
            warnings={warnings}
            warningsAccepted={activeSession.warningsAccepted}
            canUsePlan={canUsePlan}
            executionState={props.executionState}
            isSubmitting={props.isSubmitting}
            onContinueSafeProposal={props.onContinueSafeProposal}
            onCopySafeTxHash={props.onCopySafeTxHash}
            onExportSafePayload={props.onExportSafePayload}
            txProgress={props.txProgress}
            safeSubject={props.context.subjectKind === "safe"}
            onAcceptWarnings={(value) => updateActiveSession((session) => ({ ...session, warningsAccepted: value }))}
            onRegenerate={() => void regenerateActivePlan()}
            onSubmit={() => void submitActivePlan()}
          />
        )}
        <div className="agent-message-end" ref={messageEndRef} aria-hidden="true" />
      </div>

      <div className="agent-dialog-footer">
        <div className="agent-composer">
          <label htmlFor={composerId}>{props.t.agentPrompt}</label>
          <div className={`agent-composer-input ${canChat ? "" : "locked"}`}>
            <textarea
              id={composerId}
              ref={composerRef}
              rows={1}
              value={input}
              placeholder={canChat ? props.t.agentPlaceholder : authStatusView.body}
              disabled={!canChat}
              onChange={(event) => {
                setComposerText(event.currentTarget.value)
                resizeComposer(event.currentTarget)
              }}
              onKeyDown={handleComposerKeyDown}
            />
            {canChat && (
              <button
                type="button"
                className={`agent-send-button ${canStopAgentRun ? "is-stopping" : ""}`}
                aria-label={canStopAgentRun ? props.t.agentStop : props.t.agentSend}
                title={canStopAgentRun ? props.t.agentStop : props.t.agentSend}
                disabled={!isAgentBusy && !input.trim()}
                onClick={() => (canStopAgentRun ? setIsStopConfirmOpen(true) : void send())}
              >
                {canStopAgentRun ? (
                  <>
                    <Loader2 size={18} className="agent-send-spinner" aria-hidden="true" />
                    <Square
                      size={9}
                      className="agent-stop-glyph"
                      strokeWidth={0}
                      fill="currentColor"
                      aria-hidden="true"
                    />
                  </>
                ) : (
                  <Send size={18} className="agent-send-icon" strokeWidth={2.45} aria-hidden="true" />
                )}
              </button>
            )}
          </div>
        </div>
        {!canChat && (
          <button
            type="button"
            className="agent-connect-button wide"
            disabled={!authStatusView.actionable}
            onClick={handleAuthStatusAction}
          >
            {authStatus === "needs-signature" ? <ShieldCheck size={16} /> : <Wallet size={16} />}
            {authStatusView.actionLabel}
          </button>
        )}
      </div>
      {isStopConfirmOpen && (
        <ConfirmDialog
          title={props.t.agentStopConfirmTitle}
          message={props.t.agentStopConfirmBody}
          cancelLabel={props.t.agentStopConfirmCancel}
          confirmLabel={props.t.agentStopConfirmAction}
          tone="warning"
          onCancel={() => setIsStopConfirmOpen(false)}
          onConfirm={stopAgentRun}
        />
      )}
    </section>
  )
}

function AgentAuthStatusIcon(props: { status: AgentAuthStatus }) {
  if (props.status === "connected") return <ShieldCheck size={17} />
  if (props.status === "custom-llm") return <ShieldOff size={17} />
  if (props.status === "auth-disabled") return <ShieldOff size={17} />
  if (props.status === "needs-signature") return <ShieldQuestion size={17} />
  return <ShieldAlert size={17} />
}

function resizeComposer(field: HTMLTextAreaElement) {
  const style = window.getComputedStyle(field)
  const lineHeight = Number.parseFloat(style.lineHeight) || 20
  const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
  const border = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)
  const minHeight = 44
  const maxHeight = Math.ceil(lineHeight * 4 + padding + border)

  field.style.height = "auto"
  field.style.height = `${Math.max(minHeight, Math.min(field.scrollHeight, maxHeight))}px`
  field.style.overflowY = field.scrollHeight > maxHeight ? "auto" : "hidden"
}

function resetComposer(field: HTMLTextAreaElement | null) {
  if (!field) return
  field.style.height = "44px"
  field.style.overflowY = "hidden"
}

function resolveAgentAuthStatus(
  context: AgentContext,
  agentAccess: boolean,
  rpcAuthToken: string | null,
  serverAuthRequired: boolean,
  hasUserLlmConfig: boolean,
): AgentAuthStatus {
  if (!context.account) return "no-wallet"
  if (!context.subjectAccount || !context.liveSnapshot) return "needs-live-data"
  if (!agentAccess) return "no-access"
  if (hasUserLlmConfig) return "custom-llm"
  if (!serverAuthRequired) return "auth-disabled"
  if (!rpcAuthToken) return "needs-signature"
  return "connected"
}

function getAgentAuthStatusView(status: AgentAuthStatus, t: MessageBundle) {
  if (status === "connected") {
    return {
      actionable: false,
      actionLabel: t.agentAuthReadyTitle,
      body: t.agentAuthReadyBody,
      title: t.agentAuthReadyTitle,
      tone: "ready",
    }
  }
  if (status === "auth-disabled") {
    return {
      actionable: false,
      actionLabel: t.agentAuthDisabledTitle,
      body: t.agentAuthDisabledBody,
      title: t.agentAuthDisabledTitle,
      tone: "off",
    }
  }
  if (status === "custom-llm") {
    return {
      actionable: false,
      actionLabel: t.userLlmAgentReadyTitle,
      body: t.userLlmAgentReadyBody,
      title: t.userLlmAgentReadyTitle,
      tone: "off",
    }
  }
  if (status === "needs-signature") {
    return {
      actionable: true,
      actionLabel: t.agentAuthSignAction,
      body: t.agentAuthSignBody,
      title: t.agentAuthSignTitle,
      tone: "pending",
    }
  }
  if (status === "needs-live-data") {
    return {
      actionable: false,
      actionLabel: t.agentAuthUnavailableAction,
      body: t.agentAuthLiveDataBody,
      title: t.agentAuthLiveDataTitle,
      tone: "pending",
    }
  }
  if (status === "no-access") {
    return {
      actionable: false,
      actionLabel: t.agentAuthUnavailableAction,
      body: t.agentAuthNoAccessBody,
      title: t.agentAuthNoAccessTitle,
      tone: "blocked",
    }
  }
  return {
    actionable: true,
    actionLabel: t.agentAuthConnectAction,
    body: t.agentAuthNoWalletBody,
    title: t.agentAuthNoWalletTitle,
    tone: "blocked",
  }
}

function AgentDisconnectedPanel(props: { t: MessageBundle; onConnectWallet: () => Promise<void> }) {
  return (
    <article className="agent-wallet-onboarding">
      <div className="agent-wallet-onboarding-title">
        <AgentLogo />
        <span>
          <strong>{props.t.agentDisconnectedTitle}</strong>
          <small>{props.t.agentDisconnectedBody}</small>
        </span>
      </div>
      <div className="agent-wallet-onboarding-list">
        <span>{props.t.agentDisconnectedCanExplore}</span>
        <span>{props.t.agentDisconnectedUnlocks}</span>
        <span>{props.t.agentDisconnectedSafety}</span>
      </div>
      <button type="button" className="agent-connect-button" onClick={() => void props.onConnectWallet()}>
        <Wallet size={16} />
        {props.t.connectWallet}
      </button>
    </article>
  )
}

function AgentMessageView(props: {
  t: MessageBundle
  message: AgentChatMessage
  onToggleContent: () => void
  onToggleThinking: () => void
}) {
  const { message } = props
  const hasContent = Boolean(message.content)
  const canCollapseContent = shouldCollapseMessageContent(message.content)
  const contentExpanded = message.contentExpanded !== false
  return (
    <article className={`agent-message ${message.role}`}>
      {message.role === "tool" && <Wrench size={14} />}
      <span className={`agent-message-content ${canCollapseContent && !contentExpanded ? "collapsed" : ""}`}>
        {message.content || (message.isLoading ? props.t.agentThinking : "")}
      </span>
      {hasContent && canCollapseContent && (
        <button
          type="button"
          className="agent-message-toggle"
          aria-expanded={contentExpanded}
          onClick={props.onToggleContent}
        >
          {contentExpanded ? props.t.agentCollapseContent : props.t.agentExpandContent}
        </button>
      )}
      {message.isLoading && <Loader2 size={14} className="spin-icon" />}
      {message.thinking && (
        <div className="agent-thinking">
          <button type="button" onClick={props.onToggleThinking} aria-expanded={Boolean(message.thinkingOpen)}>
            <ChevronDown size={14} />
            {message.thinkingOpen ? props.t.agentHideThinking : props.t.agentShowThinking}
          </button>
          {message.thinkingOpen && <p>{message.thinking}</p>}
        </div>
      )}
    </article>
  )
}

function dialogPosition() {
  const width = 420
  const height = 660
  const left = Math.max(292, window.innerWidth - width - 24)
  const top = Math.max(16, window.innerHeight - height - 24)
  return { left, top, right: "auto", bottom: "auto" }
}

function trapFocus(event: globalThis.KeyboardEvent, dialog: HTMLElement | null) {
  if (!dialog) return
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.offsetParent !== null)
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
    return
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function AgentPlanCard(props: {
  t: MessageBundle
  draft: AgentPlan
  executablePlan: TxPlan | null
  isStale: boolean
  warnings: string[]
  warningsAccepted: boolean
  canUsePlan: boolean
  executionState: ActionExecutionSummary | null
  isSubmitting: boolean
  onContinueSafeProposal: () => void
  onCopySafeTxHash: (safeTxHash: string) => void
  onExportSafePayload: () => void
  txProgress: string
  safeSubject: boolean
  onAcceptWarnings: (value: boolean) => void
  onRegenerate: () => void
  onSubmit: () => void
}) {
  const intentLabel = describeIntent(props.draft.intent)
  const txStepLabels = props.executablePlan?.txs.map((tx) => translateTxLabel(tx.label, props.t)) ?? []
  const txStepStatuses = chainTxStepStatuses(txStepLabels, props.txProgress, props.isSubmitting)
  return (
    <article className={`agent-plan-card ${props.isStale ? "stale" : ""}`}>
      <div className="agent-plan-title">
        <CheckCircle2 size={18} />
        <span>
          <strong>{props.executablePlan ? props.t.agentActionReadyTitle : props.t.agentActionDraftTitle}</strong>
          <small>{intentLabel}</small>
        </span>
      </div>
      {props.isStale && (
        <div className="agent-stale-notice">
          <AlertTriangle size={15} />
          <span>{props.t.agentStalePlan}</span>
        </div>
      )}
      {props.draft.risks.length > 0 && (
        <div className="agent-risk-list">
          <strong>{props.t.agentRisks}</strong>
          {props.draft.risks.map((risk) => (
            <p className={`agent-risk ${risk.severity}`} key={`${risk.code}-${risk.message}`}>
              <strong>{translateRiskSeverity(risk.severity, props.t)}: </strong>
              {translateAgentRisk(risk, props.t)}
            </p>
          ))}
        </div>
      )}
      <div className="agent-phase-list">
        <strong>{props.t.agentActionSteps}</strong>
        {props.draft.phases.map((phase) => (
          <div className="agent-phase" key={phase.id}>
            <span>{phase.title}</span>
            <small>{phase.executableNow ? props.t.ready : props.t.agentDelayedPhase}</small>
          </div>
        ))}
      </div>
      {props.executablePlan && (
        <div className="agent-tx-list">
          <strong>{props.t.transactionSteps}</strong>
          {props.executablePlan.txs.map((tx, index) => (
            <AgentTxStep
              key={`${tx.to}-${tx.data}`}
              label={txStepLabels[index] ?? translateTxLabel(tx.label, props.t)}
              status={txStepStatuses[index] ?? "pending"}
            />
          ))}
          {props.executablePlan.simulation?.status === "failed" && (
            <p className="agent-simulation-error">
              <AlertTriangle size={14} />
              {props.executablePlan.simulation.message}
            </p>
          )}
          <small>{props.t.agentWalletConfirmations}</small>
        </div>
      )}
      {!props.isSubmitting && props.executionState?.action === "agent-plan" && (
        <ExecutionSummaryCard
          summary={props.executionState}
          t={props.t}
          onContinueSafeProposal={props.onContinueSafeProposal}
          onCopySafeTxHash={props.onCopySafeTxHash}
          onExportSafePayload={props.onExportSafePayload}
        />
      )}
      {props.warnings.length > 0 && (
        <label className="agent-warning-ack">
          <input
            type="checkbox"
            checked={props.warningsAccepted}
            onChange={(event) => props.onAcceptWarnings(event.target.checked)}
          />
          <span>{props.t.agentAcknowledgeWarnings}</span>
        </label>
      )}
      <p className="agent-review-reminder">
        <AlertTriangle size={15} />
        {props.t.agentReviewReminder}
      </p>
      <div className="agent-plan-actions">
        {props.isStale && (
          <button type="button" className="soft-button" disabled={props.isSubmitting} onClick={props.onRegenerate}>
            <RefreshCw size={14} />
            {props.t.agentRegenerateAction}
          </button>
        )}
        <button
          type="button"
          className="primary-button"
          disabled={!props.canUsePlan || props.isSubmitting}
          onClick={props.onSubmit}
        >
          {props.isSubmitting ? (
            <ButtonBusyLabel>{chainActionBusyLabel(props.t, props.txProgress)}</ButtonBusyLabel>
          ) : props.safeSubject ? (
            props.t.agentReviewSafeAction
          ) : (
            props.t.agentConfirmAction
          )}
          {!props.isSubmitting && <Play size={14} />}
        </button>
      </div>
    </article>
  )
}

function AgentTxStep({ label, status }: { label: string; status: ChainTxStepStatus }) {
  return (
    <span className={`agent-tx-step ${status}`}>
      <span className="agent-tx-step-icon" aria-hidden="true">
        {status === "done" ? <Check size={12} /> : status === "current" ? <Loader2 size={12} /> : null}
      </span>
      <span>{label}</span>
    </span>
  )
}

function describeIntent(intent: AgentIntent) {
  if (intent.kind === "claim-rewards") return "claim rewards"
  if (intent.kind === "claim-withdrawal") return "claim withdrawal"
  if (intent.kind === "rebalance") return "rebalance stake"
  if (intent.kind === "restake-rewards") return "restake rewards"
  return intent.kind
}

function createSession(title: string): AgentSession {
  return {
    composerText: "",
    draft: null,
    draftKey: "",
    executablePlan: null,
    id: createId(),
    title,
    messages: [],
    pendingIntentText: "",
    warningsAccepted: false,
  }
}

function createMessage(role: AgentChatMessage["role"], content: string, isLoading = false): AgentChatMessage {
  return { id: createId(), role, content, isLoading }
}

function loadStoredSessions(fallbackTitle: string): AgentSession[] {
  if (typeof window === "undefined") return [createSession(fallbackTitle)]
  return readStoredAgentSessions(readStorageText(appStorageKeys.agentSessions), fallbackTitle) as AgentSession[]
}

function loadStoredActiveSessionId(sessions: AgentSession[]): string {
  if (typeof window !== "undefined") {
    const stored = readStorageText(appStorageKeys.agentActiveSession)
    if (stored && sessions.some((session) => session.id === stored)) return stored
  }
  return sessions[0]?.id ?? createId()
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function shouldCollapseMessageContent(content: string) {
  if (!content.trim()) return false
  return content.split(/\r?\n/).length > 4 || content.length > 220
}

function collectWarnings(draft: AgentPlan | null, plan: TxPlan | null) {
  if (!draft) return []
  return [
    ...draft.risks.filter((risk) => risk.severity === "warning").map((risk) => risk.message),
    ...(plan?.warnings ?? []),
  ]
}

function riskText(risks: AgentRisk[], t: MessageBundle) {
  if (!risks.length) return t.agentUnsupported
  return risks.map((risk) => translateAgentRisk(risk, t)).join("\n")
}

function translateAgentRisk(risk: AgentRisk, t: MessageBundle) {
  if (risk.code === "unsupported-operation") return t.agentUnsupported
  if (risk.code === "validator-selection") {
    if (risk.message === "Selected by address.") return t.agentValidatorSelectedByAddress
    if (risk.message === "Selected by name.") return t.agentValidatorSelectedByName
    return t.agentValidatorSelectedBest
  }
  if (risk.code === "wallet-required") return t.agentWalletRequired
  if (risk.code === "live-data-required") return t.agentLiveDataRequired
  if (risk.code === "wrong-chain") return t.wrongNetwork
  if (risk.code === "validators-required") return t.agentValidatorsRequired
  if (risk.code === "inactive-validator") return t.inactiveValidator
  if (risk.code === "insufficient-safe-balance") return t.insufficientSafeBalance
  if (risk.code === "insufficient-validator-stake") return t.insufficientValidatorStake
  if (risk.code === "no-claimable-withdrawal") return t.noClaimableWithdrawal
  if (risk.code === "reward-proof-required") return t.agentRewardProofRequired
  if (risk.code === "merkle-root-mismatch") return t.merkleMismatch
  if (risk.code === "no-claimable-rewards-direct-stake") return t.agentNoRewardsCanStake
  if (risk.code === "no-claimable-rewards") return t.noProof
  if (risk.code === "delayed-phase") return t.agentDelayedPhaseRisk
  if (risk.code === "compile-failed") return t.buildPlanFailed
  return translateTxWarning(risk.message, t)
}

function shouldReplyWithoutActionCard(plan: AgentPlan) {
  return plan.phases.length === 0 && plan.risks.some((risk) => risk.code === "no-claimable-rewards-direct-stake")
}

function directGuidanceText(plan: AgentPlan, t: MessageBundle) {
  const risks = plan.risks.filter((risk) => risk.code !== "validator-selection")
  return riskText(risks, t)
}

function translateRiskSeverity(severity: AgentRisk["severity"], t: MessageBundle) {
  if (severity === "blocked") return t.agentRiskBlocked
  if (severity === "warning") return t.agentRiskWarning
  return t.agentRiskInfo
}

function joinPendingIntent(pending: string, input: string) {
  return pending ? `${pending} ${input}` : input
}

function shouldStartNewIntent(input: string) {
  return /\b(claim|stake|unstake|restake|move|rebalance)\b|领取|质押|复投|提款|调仓|移动/.test(input.toLowerCase())
}

function agentAccessKey(context: AgentContext) {
  if (!context.account || !context.subjectAccount || !context.liveSnapshot) return "locked"
  return context.summary.safeBalance > 0n || context.summary.totalStaked > 0n ? "eligible" : "empty"
}

function agentContextKey(context: AgentContext) {
  const snapshot = context.liveSnapshot
  const pending = snapshot?.pendingWithdrawals.map((item) => `${item.amount}:${item.claimableAt}`).join(",") ?? ""
  const nextWithdrawal = snapshot?.nextClaimableWithdrawal
    ? `${snapshot.nextClaimableWithdrawal.amount}:${snapshot.nextClaimableWithdrawal.claimableAt}`
    : ""
  return [
    context.account ?? "",
    context.subjectAccount ?? "",
    context.chainId ?? "",
    agentAccessKey(context),
    context.summary.safeBalance,
    context.summary.totalStaked,
    context.summary.claimableRewards,
    context.summary.claimableWithdrawals,
    context.summary.pendingWithdrawals,
    snapshot?.stakingAllowance ?? "",
    snapshot?.cumulativeClaimed ?? "",
    nextWithdrawal,
    pending,
    context.rewardProof?.cumulativeAmount ?? "",
    context.rewardProof?.merkleRoot ?? "",
    context.liveMerkleRoot ?? "",
  ].join(":")
}

function isRefreshLiveDataTool(toolName: string, data: unknown) {
  const record = readRecord(data)
  return toolName === "refresh_live_staking_context" && record?.clientAction === "refresh-live-staking-context"
}

function formatLiveAccountSummary(context: AgentContext, t: MessageBundle) {
  const subject = context.subjectAccount ? compactAddress(context.subjectAccount) : t.notChecked
  const subjectKind = context.subjectKind === "safe" ? "Safe" : "EOA"
  const positions = context.validators.filter((validator) => validator.userStake > 0n).slice(0, 5)
  const positionText = positions.length
    ? positions.map((validator) => `${validator.label}: ${formatSafe(validator.userStake)} SAFE`).join("\n")
    : t.agentLiveSummaryNoPositions
  return [
    t.agentLiveSummaryTitle,
    `${t.stakingSubject}: ${subject} (${subjectKind})`,
    `${t.safeBalance}: ${formatSafe(context.summary.safeBalance)} SAFE`,
    `${t.totalStaked}: ${formatSafe(context.summary.totalStaked)} SAFE`,
    `${t.claimableRewards}: ${formatSafe(context.summary.claimableRewards)} SAFE`,
    `${t.claimableWithdrawals}: ${formatSafe(context.summary.claimableWithdrawals)} SAFE`,
    `${t.pendingWithdrawals}: ${formatSafe(context.summary.pendingWithdrawals)} SAFE`,
    `${t.yourStake}:`,
    positionText,
  ].join("\n")
}

function localizeClarification(question: string, t: MessageBundle) {
  if (question === "Which validator should receive this stake?") return t.agentClarifyStakeValidator
  if (question === "Which validator should receive restaked rewards?") return t.agentClarifyRestakeValidator
  if (question === "Which amount and validator should be staked?") return t.agentClarifyStake
  if (question === "Which validator should be unstaked?") return t.agentClarifyUnstakeValidator
  if (question === "Which amount and validator should be unstaked?") return t.agentClarifyUnstake
  if (question === "Which amount and validators should be used for the rebalance?") return t.agentClarifyRebalance
  return t.agentClarifyGeneral
}

function readPreparedIntent(toolName: string, data: unknown): AgentIntent | null {
  if (toolName !== "prepare_staking_action") return null
  const record = readRecord(data) as PreparedStakingActionData | null
  if (record?.requiresWalletConfirmation !== true) return null
  return coerceAgentIntent(record?.intent)
}

function coerceAgentIntent(input: unknown): AgentIntent | null {
  const record = readRecord(input)
  const kind = typeof record?.kind === "string" ? record.kind : ""
  if (kind === "claim-withdrawal") return { kind }
  if (kind === "claim-rewards") return { kind }
  if (kind === "stake" || kind === "unstake") {
    const amount = coerceAgentAmount(record?.amount)
    const validator = coerceAgentValidator(record?.validator)
    return amount && validator ? { kind, amount, validator } : null
  }
  if (kind === "restake-rewards") {
    const amount = coerceAgentAmount(record?.amount)
    const validator = coerceAgentValidator(record?.validator)
    return amount && validator ? { kind, amount, validator } : null
  }
  if (kind === "rebalance") {
    const amount = coerceAgentAmount(record?.amount)
    const from = coerceAgentValidator(record?.from)
    const to = coerceAgentValidator(record?.to)
    return amount && from && to ? { kind, amount, from, to } : null
  }
  return null
}

function coerceAgentAmount(input: unknown): AgentAmount | null {
  const record = readRecord(input)
  const type = typeof record?.type === "string" ? record.type : ""
  if (type === "safe") {
    const value = typeof record?.value === "string" ? record.value.trim() : ""
    return /^\d+(?:\.\d{1,18})?$/.test(value) ? { type, value } : null
  }
  if (type === "percent-wallet" || type === "percent-validator-stake") {
    const value = typeof record?.value === "number" ? record.value : Number(record?.value)
    return Number.isFinite(value) && value > 0 && value <= 100 ? { type, value } : null
  }
  if (type === "all-wallet" || type === "all-validator-stake" || type === "all-claimable-rewards") {
    return { type }
  }
  return null
}

function coerceAgentValidator(input: unknown): AgentValidatorRef | null {
  const record = readRecord(input)
  const type = typeof record?.type === "string" ? record.type : ""
  if (type === "best-active") {
    return { type }
  }
  const value = typeof record?.value === "string" ? record.value.trim() : ""
  if (type === "label" && value) {
    return { type, value }
  }
  if (type === "address" && isAddress(value)) {
    return { type, value: value as Address }
  }
  return null
}

function formatAgentResetTime(resetAt: string | undefined) {
  if (!resetAt) return "later"
  const date = new Date(resetAt)
  if (Number.isNaN(date.getTime())) return "later"
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

function resolveAgentApiErrorMessage(error: unknown, t: MessageBundle) {
  if (!(error instanceof AgentApiError)) return t.agentServiceUnavailable
  if (error.code === "agent_daily_limit_exceeded") {
    return t.agentDailyLimitExceeded.replace("{resetAt}", formatAgentResetTime(error.resetAt))
  }
  if (error.code === "agent_access_denied") return t.agentAccessDeniedNoSafe
  if (error.code === "agent_auth_mismatch") return t.agentAuthMismatch
  if (error.code === "agent_invalid_context") return t.agentInvalidContext
  if (error.code === "agent_auth_required") return t.agentAuthSessionRequired
  return error.message || t.agentServiceUnavailable
}

function readRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : null
}

function isConfirmationText(input: string) {
  return /^(continue|confirm|yes|go ahead|execute|submit|ok|okay|继续|确认|确定|执行|提交|可以|好的|开始)$/i.test(
    input.trim(),
  )
}

function resolvePlanNotReadyMessage(t: MessageBundle, warnings: string[], plan: TxPlan | null) {
  if (plan?.simulation?.status === "failed") return t.agentPlanSimulationFailed
  if (warnings.length > 0) return t.agentConfirmWarningsRequired
  return t.agentActionNotReady
}
