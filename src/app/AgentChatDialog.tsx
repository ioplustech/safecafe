import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Download,
  FilePlus2,
  Loader2,
  MessageSquare,
  Send,
  Trash2,
  Wallet,
  Wrench,
  X,
} from "lucide-react"
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react"
import {
  type AgentContext,
  type AgentIntent,
  type AgentPlan,
  type AgentRisk,
  compileAgentPlan,
  flattenCurrentExecutableTxPlan,
  flattenExecutableTxPlan,
  hasAgentServiceAccess,
  parseAgentInstruction,
  requestAgentReplyStream,
  toAgentChatContext,
} from "../agent"
import { compactAddress, type TxPlan } from "../protocol"
import { AgentLogo } from "./AgentLogo"
import { translateTxLabel, translateTxWarning } from "./formatters"
import type { MessageBundle } from "./i18n"

type AgentChatMessage = {
  id: string
  role: "assistant" | "tool" | "user"
  content: string
  isLoading?: boolean
  thinking?: string
  thinkingOpen?: boolean
}

type AgentSession = {
  draft: AgentPlan | null
  draftKey: string
  executablePlan: TxPlan | null
  id: string
  title: string
  messages: AgentChatMessage[]
  pendingIntentText: string
  warningsAccepted: boolean
}

export type AgentChatDialogProps = {
  t: MessageBundle
  isOpen: boolean
  anchor: { x: number; y: number } | null
  context: AgentContext
  isSubmitting: boolean
  rpcAuthToken: string | null
  onApplyPlan: (plan: TxPlan) => void
  onAuthenticateAgent: () => Promise<string | null>
  onClose: () => void
  onConnectWallet: () => Promise<void>
  onExportPlan: (plan: TxPlan) => void
  onSimulatePlan: (plan: TxPlan) => Promise<TxPlan>
  onSubmitPlan: (plan: TxPlan) => Promise<void>
}

export function AgentChatDialog(props: AgentChatDialogProps) {
  const [input, setInput] = useState("")
  const [sessions, setSessions] = useState<AgentSession[]>(() => [createSession(props.t.agentNewSession)])
  const [activeSessionId, setActiveSessionId] = useState(() => sessions[0].id)
  const [isDrafting, setIsDrafting] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [isSessionMenuOpen, setIsSessionMenuOpen] = useState(false)
  const requestSeqRef = useRef(0)
  const contextKeyRef = useRef("")
  const dialogRef = useRef<HTMLElement>(null)
  const sessionMenuRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const messageListRef = useRef<HTMLDivElement>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0]
  const currentContextKey = agentContextKey(props.context)
  const isStale = Boolean(activeSession.draft && activeSession.draftKey && activeSession.draftKey !== currentContextKey)
  const blocked = activeSession.draft?.risks.some((risk) => risk.severity === "blocked") ?? false
  const warnings = useMemo(
    () => collectWarnings(activeSession.draft, activeSession.executablePlan),
    [activeSession.draft, activeSession.executablePlan],
  )
  const canUsePlan = Boolean(
    activeSession.executablePlan && !blocked && !isStale && (warnings.length === 0 || activeSession.warningsAccepted),
  )
  const canChat = Boolean(props.context.account)
  const agentAccess = hasAgentServiceAccess(props.context)
  const isBusy = isDrafting || isStreaming || props.isSubmitting
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
        if (isSessionMenuOpen) {
          setIsSessionMenuOpen(false)
          return
        }
        props.onClose()
      }
      if (event.key === "Tab") trapFocus(event, dialogRef.current)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [isSessionMenuOpen, props.isOpen, props.onClose])

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
    requestSeqRef.current += 1
    setIsDrafting(false)
    setIsStreaming(false)
    setSessions((current) =>
      current.map((session) =>
        session.id === activeSessionId
          ? {
              ...session,
              draft: null,
              draftKey: "",
              executablePlan: null,
              pendingIntentText: "",
              warningsAccepted: false,
            }
          : session,
      ),
    )
  }, [activeSessionId, currentContextKey])

  async function send(text = input) {
    const trimmed = text.trim()
    if (!trimmed || isBusy) return
    if (!canChat) {
      setInput("")
      return
    }
    const requestId = requestSeqRef.current + 1
    requestSeqRef.current = requestId
    const requestSessionId = activeSession.id
    setInput("")
    const history = activeSession.messages
      .filter((message) => message.role === "assistant" || message.role === "user")
      .map(({ role, content }) => ({ role: role as "assistant" | "user", content }))
    updateActiveSession((session) => ({
      ...session,
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
    const parse = parseAgentInstruction(candidate, props.context.validators)

    if (parse.status === "needs-clarification") {
      updateActiveSession((session) => ({
        ...session,
        pendingIntentText: candidate,
        messages: [
          ...session.messages,
          createMessage(
            "assistant",
            !props.context.account ? props.t.agentClarifyWithoutWallet : localizeClarification(parse.question, props.t),
          ),
        ],
      }))
      return
    }
    updateActiveSession((session) => ({ ...session, pendingIntentText: "" }))
    if (parse.status === "blocked") {
      updateActiveSession((session) => ({
        ...session,
        messages: [...session.messages, createMessage("assistant", riskText(parse.risks, props.t))],
      }))
      return
    }
    if (
      !props.context.account ||
      !(props.context.subjectAccount ?? props.context.account) ||
      !props.context.liveSnapshot
    ) {
      updateActiveSession((session) => ({
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
    if (!agentAccess) {
      updateActiveSession((session) => ({
        ...session,
        messages: [...session.messages, createMessage("assistant", props.t.agentAccessRequired)],
      }))
      return
    }

    const authToken = await props.onAuthenticateAgent()
    if (!authToken) {
      updateActiveSession((session) => ({
        ...session,
        messages: [...session.messages, createMessage("assistant", props.t.agentAuthRequired)],
      }))
      return
    }

    setIsDrafting(true)
    updateActiveSession((session) => ({
      ...session,
      messages: [...session.messages, createMessage("tool", props.t.agentToolReadWallet, true)],
    }))
    try {
      const nextDraft = compileAgentPlan(candidate, parse.intent, props.context)
      if (requestSeqRef.current !== requestId) return
      updateSession(requestSessionId, (session) => ({ ...session, draft: nextDraft }))
      updateLastLoadingTool(requestSessionId, props.t.agentToolCompilePlan)
      const flattened = flattenExecutableTxPlan(nextDraft) ?? flattenCurrentExecutableTxPlan(nextDraft)
      updateLastLoadingTool(requestSessionId, props.t.agentToolSimulatePlan)
      const simulated = flattened ? await props.onSimulatePlan(flattened) : null
      if (requestSeqRef.current !== requestId) return
      updateSession(requestSessionId, (session) => ({
        ...session,
        draftKey: currentContextKey,
        executablePlan: simulated,
      }))
      finishLastLoadingTool(requestSessionId, props.t.agentToolReady)
      updateSession(requestSessionId, (session) => ({
        ...session,
        messages: [
          ...session.messages,
          createMessage("assistant", simulated ? props.t.agentPlanReady : props.t.agentPlanDrafted),
        ],
      }))
      void appendAgentReply(trimmed, history, requestId, requestSessionId, authToken)
    } catch (error) {
      finishLastLoadingTool(requestSessionId, props.t.agentToolFailed)
      updateSession(requestSessionId, (session) => ({
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

  async function appendAgentReply(
    message: string,
    history: Array<{ role: "assistant" | "user"; content: string }>,
    requestId: number,
    sessionId: string,
    authToken: string,
  ) {
    if (!agentAccess) return
    const assistantId = createId()
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
            updateMessage(sessionId, assistantId, (item) => ({ ...item, thinking: event.content }))
          if (event.type === "delta") {
            updateMessage(sessionId, assistantId, (item) => ({
              ...item,
              content: item.content + event.content,
              isLoading: false,
            }))
          }
          if (event.type === "final") {
            updateMessage(sessionId, assistantId, (item) => ({ ...item, content: event.content, isLoading: false }))
          }
        },
      )
    } catch {
      if (requestSeqRef.current === requestId) {
        updateMessage(sessionId, assistantId, (item) => ({
          ...item,
          content: props.t.agentServiceUnavailable,
          isLoading: false,
        }))
      }
    } finally {
      if (requestSeqRef.current === requestId) setIsStreaming(false)
    }
  }

  function createNewSession() {
    requestSeqRef.current += 1
    resetBusy()
    const session = createSession(props.t.agentNewSession)
    setSessions((current) => [session, ...current].slice(0, 5))
    setActiveSessionId(session.id)
    setIsSessionMenuOpen(false)
  }

  function clearSession() {
    requestSeqRef.current += 1
    resetBusy()
    updateActiveSession((session) => ({
      ...session,
      draft: null,
      draftKey: "",
      executablePlan: null,
      messages: [],
      pendingIntentText: "",
      warningsAccepted: false,
    }))
    setIsSessionMenuOpen(false)
  }

  function selectSession(sessionId: string) {
    if (sessionId === activeSessionId) {
      setIsSessionMenuOpen(false)
      return
    }
    requestSeqRef.current += 1
    resetBusy()
    setActiveSessionId(sessionId)
    setIsSessionMenuOpen(false)
  }

  function resetBusy() {
    setIsDrafting(false)
    setIsStreaming(false)
  }

  function updateActiveSession(updater: (session: AgentSession) => AgentSession) {
    updateSession(activeSessionId, updater)
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

  function updateLastLoadingTool(sessionId: string, content: string) {
    updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.map((message, index) =>
        index === session.messages.length - 1 && message.role === "tool" && message.isLoading
          ? { ...message, content }
          : message,
      ),
    }))
  }

  function finishLastLoadingTool(sessionId: string, content: string) {
    updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.map((message, index) =>
        index === session.messages.length - 1 && message.role === "tool" && message.isLoading
          ? { ...message, content, isLoading: false }
          : message,
      ),
    }))
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return
    event.preventDefault()
    void send()
  }

  if (!props.isOpen) return null

  return (
    <section
      ref={dialogRef}
      className="agent-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={props.t.agentTitle}
      aria-busy={isBusy}
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
        {!canChat ? (
          <AgentDisconnectedPanel t={props.t} onConnectWallet={props.onConnectWallet} />
        ) : (
          !agentAccess && (
            <article className="agent-access-panel">
              <AgentLogo />
              <span>{props.t.agentAccessRequired}</span>
            </article>
          )
        )}
        {canChat && (
          <div className="agent-prompt-chip-row">
            {[
              props.t.agentPromptClaimRewards,
              props.t.agentPromptStake,
              props.t.agentPromptRestake,
              props.t.agentPromptRebalance,
            ].map((prompt) => (
              <button type="button" key={prompt} disabled={isBusy} onClick={() => void send(prompt)}>
                {prompt}
              </button>
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
                updateMessage(activeSessionId, message.id, (item) => ({ ...item, thinkingOpen: !item.thinkingOpen }))
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
            safeSubject={props.context.subjectKind === "safe"}
            isSubmitting={props.isSubmitting}
            onAcceptWarnings={(value) => updateActiveSession((session) => ({ ...session, warningsAccepted: value }))}
            onApply={() => activeSession.executablePlan && props.onApplyPlan(activeSession.executablePlan)}
            onExport={() => activeSession.executablePlan && props.onExportPlan(activeSession.executablePlan)}
            onSubmit={() => activeSession.executablePlan && void props.onSubmitPlan(activeSession.executablePlan)}
          />
        )}
        <div className="agent-message-end" ref={messageEndRef} aria-hidden="true" />
      </div>

      <div className="agent-dialog-footer">
        <label className="agent-composer">
          <span>{props.t.agentPrompt}</span>
          <textarea
            ref={composerRef}
            rows={2}
            value={input}
            placeholder={canChat ? props.t.agentPlaceholder : props.t.agentConnectToChat}
            disabled={!canChat}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleComposerKeyDown}
          />
        </label>
        {canChat ? (
          <button
            type="button"
            className="agent-send-button"
            disabled={isBusy || !input.trim()}
            onClick={() => void send()}
          >
            {isBusy ? <Loader2 size={16} className="spin-icon" /> : <Send size={16} />}
            {isBusy ? props.t.agentThinking : props.t.agentSend}
          </button>
        ) : (
          <button type="button" className="agent-connect-button wide" onClick={() => void props.onConnectWallet()}>
            <Wallet size={16} />
            {props.t.connectWallet}
          </button>
        )}
      </div>
    </section>
  )
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

function AgentMessageView(props: { t: MessageBundle; message: AgentChatMessage; onToggleThinking: () => void }) {
  const { message } = props
  return (
    <article className={`agent-message ${message.role}`}>
      {message.role === "tool" && <Wrench size={14} />}
      <span>{message.content || (message.isLoading ? props.t.agentThinking : "")}</span>
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
  isSubmitting: boolean
  safeSubject: boolean
  onAcceptWarnings: (value: boolean) => void
  onApply: () => void
  onExport: () => void
  onSubmit: () => void
}) {
  const intentLabel = describeIntent(props.draft.intent)
  return (
    <article className={`agent-plan-card ${props.isStale ? "stale" : ""}`}>
      <div className="agent-plan-title">
        <CheckCircle2 size={18} />
        <span>
          <strong>{props.t.agentParsedIntent}</strong>
          <small>{intentLabel}</small>
        </span>
      </div>
      {props.isStale && (
        <p className="agent-risk blocked">
          <strong>{props.t.agentRiskBlocked}: </strong>
          {props.t.agentStalePlan}
        </p>
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
        <strong>{props.t.agentPlanPhases}</strong>
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
          {props.executablePlan.txs.map((tx) => (
            <span key={`${tx.to}-${tx.data}`}>{translateTxLabel(tx.label, props.t)}</span>
          ))}
          <small>{props.t.agentWalletConfirmations}</small>
        </div>
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
        <button type="button" className="soft-button" disabled={!props.canUsePlan} onClick={props.onApply}>
          {props.t.applyAgentPlan}
        </button>
        <button type="button" className="soft-button" disabled={!props.canUsePlan} onClick={props.onExport}>
          <Download size={15} />
          {props.t.exportSafePayload}
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={!props.canUsePlan || props.isSubmitting}
          onClick={props.safeSubject ? props.onExport : props.onSubmit}
        >
          {props.isSubmitting
            ? props.t.submitting
            : props.safeSubject
              ? props.t.exportSafePayload
              : props.t.agentOpenWallet}
        </button>
      </div>
    </article>
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

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
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
  if (risk.code === "no-claimable-rewards") return t.noProof
  if (risk.code === "delayed-phase") return t.agentDelayedPhaseRisk
  if (risk.code === "compile-failed") return t.buildPlanFailed
  return translateTxWarning(risk.message, t)
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
  return /\b(claim|stake|unstake|move|rebalance)\b|领取|质押|提款|调仓|移动/.test(input.toLowerCase())
}

function agentAccessKey(context: AgentContext) {
  if (!context.account || !(context.subjectAccount ?? context.account) || !context.liveSnapshot) return "locked"
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

function localizeClarification(question: string, t: MessageBundle) {
  if (question === "Which validator should receive this stake?") return t.agentClarifyStakeValidator
  if (question === "Which amount and validator should be staked?") return t.agentClarifyStake
  if (question === "Which validator should be unstaked?") return t.agentClarifyUnstakeValidator
  if (question === "Which amount and validator should be unstaked?") return t.agentClarifyUnstake
  if (question === "Which amount and validators should be used for the rebalance?") return t.agentClarifyRebalance
  return t.agentClarifyGeneral
}
