import { AlertTriangle, Check, CheckCircle2, ChevronDown, Clock3, Copy, ExternalLink } from "lucide-react"
import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { formatSafe, formatUsdFromSafe } from "../protocol"
import { translateTxLabel } from "./formatters"
import type { MessageBundle } from "./i18n"
import type { PlanExecutionSummary } from "./planExecution"

export function FullPanel({
  children,
  className = "",
  title,
}: {
  children: ReactNode
  className?: string
  title?: string
}) {
  return (
    <section className={`panel full-panel enter ${className}`.trim()}>
      {title && (
        <div className="panel-title">
          <h2>{title}</h2>
        </div>
      )}
      {children}
    </section>
  )
}

export function InfoCard({ icon, title, value }: { icon: ReactNode; title: string; value: string }) {
  return (
    <div className="info-card">
      <span>{icon}</span>
      <small>{title}</small>
      <strong>{value}</strong>
    </div>
  )
}

export function Metric({
  icon,
  label,
  value,
  unavailable,
  safePriceUsd,
}: {
  icon: ReactNode
  label: string
  value: bigint | null
  unavailable: string
  safePriceUsd: number | null
}) {
  return (
    <div className="metric">
      <span className="metric-icon">{icon}</span>
      <span>
        <small>{label}</small>
        <strong>{value === null ? "--" : formatSafe(value)}</strong>
        <em>{value === null ? unavailable : formatUsdFromSafe(value, safePriceUsd)}</em>
      </span>
    </div>
  )
}

export function ActionButton(props: {
  active?: boolean
  disabled?: boolean
  icon: ReactNode
  title: string
  subtitle: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`action-button ${props.active ? "active" : ""}`}
      disabled={props.disabled}
      aria-pressed={Boolean(props.active)}
      onClick={props.onClick}
    >
      <span>{props.icon}</span>
      <strong>{props.title}</strong>
      <small>{props.subtitle}</small>
    </button>
  )
}

export function ButtonBusyLabel({ children }: { children: ReactNode }) {
  return (
    <span className="button-busy-label" aria-live="polite">
      <span className="button-spinner" aria-hidden="true" />
      <span>{children}</span>
    </span>
  )
}

export function Progress({ value, variant = "blue" }: { value: number; variant?: "blue" | "green" }) {
  return (
    <span className="progress-track">
      <span className={`progress-fill ${variant}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </span>
  )
}

export function StatusBadge({ status, t }: { status: string; t: MessageBundle }) {
  const label = status === "active" ? t.active : status === "inactive" ? t.inactive : status
  return <span className={`status-badge ${status}`}>{label}</span>
}

export function ExecutionSummaryCard({
  onContinueSafeProposal,
  onCopySafeTxHash,
  onExportSafePayload,
  summary,
  t,
}: {
  onContinueSafeProposal?: () => void
  onCopySafeTxHash?: (safeTxHash: string) => void
  onExportSafePayload?: () => void
  summary: PlanExecutionSummary
  t: MessageBundle
}) {
  const title =
    summary.status === "completed"
      ? t.executionCompletedTitle
      : summary.userRejected
        ? t.executionInterruptedTitle
        : summary.status === "partial"
          ? t.executionPartialTitle
          : t.transactionFailed
  const body =
    summary.status === "completed"
      ? summary.skippedCount > 0
        ? t.executionSkippedBody.replace("{count}", summary.skippedCount.toString())
        : t.executionCompletedBody
      : summary.userRejected
        ? t.executionInterruptedBody
        : summary.errorMessage || t.executionReviewBody
  return (
    <section className={`execution-summary-card ${summary.status}${summary.userRejected ? " user-rejected" : ""}`}>
      <div className="execution-summary-heading">
        <span>
          <strong>{title}</strong>
          <small>{body}</small>
        </span>
        <em>
          {summary.completedCount + summary.skippedCount}/{summary.steps.length}
        </em>
      </div>
      <div className="execution-summary-steps">
        {summary.steps.map((step) => (
          <span key={step.id} className={`execution-summary-step ${step.status}`}>
            <span className="execution-summary-step-dot" aria-hidden="true" />
            <span>{translateTxLabel(step.label, t)}</span>
          </span>
        ))}
      </div>
      {summary.safeProposal && (
        <div className="execution-safe-proposal">
          <span>
            <strong>
              {summary.safeProposal.status === "executed" ? t.safeProposalExecuted : t.safeProposalPending}
            </strong>
            <small>
              {summary.safeProposal.confirmations}/{summary.safeProposal.threshold} · {summary.safeProposal.safeTxHash}
            </small>
          </span>
          <div className="execution-safe-actions">
            {onCopySafeTxHash && (
              <CopyActionButton
                className="code-icon-button"
                copiedLabel={t.copied}
                label={t.safeProposalCopyHash}
                onCopy={() => onCopySafeTxHash(summary.safeProposal?.safeTxHash ?? "")}
                value={summary.safeProposal.safeTxHash}
              />
            )}
            <ExternalActionButton
              className="code-icon-button"
              href={safeAppTransactionUrl(summary.safeProposal.safeAddress, summary.safeProposal.safeTxHash)}
              label={t.safeProposalOpenSafe}
            />
            {onExportSafePayload && (
              <button type="button" className="soft-button compact" onClick={onExportSafePayload}>
                {t.exportSafePayload}
              </button>
            )}
            {summary.safeProposal.status === "pending" && onContinueSafeProposal && (
              <button type="button" className="primary-button compact" onClick={onContinueSafeProposal}>
                {t.safeProposalContinue}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function safeAppTransactionUrl(safeAddress: string, safeTxHash: string) {
  return `https://app.safe.global/transactions/tx?safe=eth:${safeAddress}&id=multisig_${safeAddress}_${safeTxHash}`
}

export function ConfirmDialog(props: {
  cancelLabel: string
  confirmLabel: string
  message: string
  onCancel: () => void
  onConfirm: () => void
  title: string
  tone?: "default" | "warning"
}) {
  const titleId = useId()
  const messageId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const tone = props.tone ?? "default"

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault()
      props.onCancel()
      return
    }
    if (event.key === "Tab") trapDialogFocus(event, dialogRef.current)
  }

  return createPortal(
    <div className="confirm-dialog-backdrop" role="presentation">
      <button type="button" className="confirm-dialog-scrim" aria-label={props.cancelLabel} onClick={props.onCancel} />
      <div
        ref={dialogRef}
        className={`confirm-dialog-card ${tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onKeyDown={handleKeyDown}
      >
        <div className="confirm-dialog-icon" aria-hidden="true">
          <AlertTriangle size={18} />
        </div>
        <div className="confirm-dialog-copy">
          <h2 id={titleId}>{props.title}</h2>
          <p id={messageId}>{props.message}</p>
        </div>
        <div className="confirm-dialog-actions">
          <button ref={cancelRef} type="button" className="confirm-dialog-cancel" onClick={props.onCancel}>
            {props.cancelLabel}
          </button>
          <button type="button" className="confirm-dialog-confirm" onClick={props.onConfirm}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function CustomSelect(props: {
  disabled?: boolean
  label: string
  options: Array<{ value: string; label: string; detail?: string; badge?: string }>
  value: string
  onChange: (value: string) => void
  optionAction?: {
    copiedLabel?: string
    label: string
    onClick: (value: string) => boolean | Promise<boolean> | Promise<void> | void
  }
}) {
  const [open, setOpen] = useState(false)
  const [copiedOption, setCopiedOption] = useState<string | null>(null)
  const [menuPosition, setMenuPosition] = useState<{
    left: number
    maxHeight: number
    top: number
    width: number
  } | null>(null)
  const buttonRef = useRef<HTMLDivElement>(null)
  const copiedTimerRef = useRef<number | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = props.options.find((option) => option.value === props.value) ?? props.options[0]

  useEffect(() => {
    if (props.disabled && open) setOpen(false)
  }, [open, props.disabled])

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    },
    [],
  )

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    window.addEventListener("pointerdown", onPointerDown)
    return () => window.removeEventListener("pointerdown", onPointerDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    const updatePosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (!rect) return
      const belowSpace = window.innerHeight - rect.bottom - 12
      const aboveSpace = rect.top - 12
      const maxHeight = Math.max(160, Math.min(260, Math.max(belowSpace, aboveSpace)))
      const top = belowSpace < 180 && aboveSpace > belowSpace ? Math.max(12, rect.top - maxHeight - 8) : rect.bottom + 8
      setMenuPosition({
        left: rect.left,
        maxHeight,
        top,
        width: rect.width,
      })
    }
    updatePosition()
    window.addEventListener("resize", updatePosition)
    window.addEventListener("scroll", updatePosition, true)
    return () => {
      window.removeEventListener("resize", updatePosition)
      window.removeEventListener("scroll", updatePosition, true)
    }
  }, [open])

  function toggleOpen() {
    if (props.disabled || props.options.length === 0) return
    setOpen((value) => !value)
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown") return
    event.preventDefault()
    toggleOpen()
  }

  async function runOptionAction(event: MouseEvent<HTMLButtonElement>, value: string) {
    event.stopPropagation()
    if (!props.optionAction) return
    const result = await props.optionAction.onClick(value)
    if (result === false) return
    setCopiedOption(value)
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = window.setTimeout(() => {
      setCopiedOption((current) => (current === value ? null : current))
      copiedTimerRef.current = null
    }, 1300)
  }

  function selectOption(value: string) {
    if (props.disabled) return
    props.onChange(value)
    setOpen(false)
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLDivElement>, value: string) {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    selectOption(value)
  }

  return (
    <div className={`custom-select ${open ? "open" : ""}`} ref={rootRef}>
      <div
        className="custom-select-control"
        ref={buttonRef}
        data-disabled={props.disabled || props.options.length === 0 ? "true" : "false"}
      >
        <button
          type="button"
          className="custom-select-value-button"
          aria-expanded={open}
          aria-label={props.label}
          disabled={props.disabled || props.options.length === 0}
          onClick={toggleOpen}
          onKeyDown={handleTriggerKeyDown}
        >
          <span>
            <strong>
              <span className="custom-select-label-text">{selected?.label ?? props.label}</span>
              {selected?.badge && <em className="custom-select-badge">{selected.badge}</em>}
            </strong>
            {selected?.detail && <small>{selected.detail}</small>}
          </span>
        </button>
        <button
          type="button"
          className="custom-select-chevron-button"
          aria-expanded={open}
          aria-label={props.label}
          disabled={props.disabled || props.options.length === 0}
          onClick={toggleOpen}
          onKeyDown={handleTriggerKeyDown}
        >
          <ChevronDown size={18} />
        </button>
      </div>
      {open &&
        menuPosition &&
        createPortal(
          <div
            className="custom-select-menu floating-select-menu"
            ref={menuRef}
            role="listbox"
            aria-label={props.label}
            style={{
              left: menuPosition.left,
              maxHeight: menuPosition.maxHeight,
              top: menuPosition.top,
              width: menuPosition.width,
            }}
          >
            {props.options.map((option) => (
              <div
                className={`custom-select-option ${option.value === props.value ? "selected" : ""}`}
                data-has-action={props.optionAction ? "true" : "false"}
                key={option.value}
                role="option"
                aria-disabled={props.disabled}
                aria-selected={option.value === props.value}
                tabIndex={props.disabled ? -1 : 0}
                onClick={() => selectOption(option.value)}
                onKeyDown={(event) => handleOptionKeyDown(event, option.value)}
              >
                <div className="custom-select-option-main">
                  <span>
                    <span>
                      <strong>
                        <span className="custom-select-label-text">{option.label}</span>
                      </strong>
                      <span className="custom-select-option-side">
                        {props.optionAction && (
                          <Tooltip
                            label={
                              copiedOption === option.value
                                ? (props.optionAction.copiedLabel ?? props.optionAction.label)
                                : props.optionAction.label
                            }
                          >
                            <button
                              type="button"
                              className={`inline-action-button custom-select-option-action ${copiedOption === option.value ? "copied" : ""}`}
                              aria-label={`${props.optionAction.label} ${option.label}`}
                              disabled={props.disabled}
                              onClick={(event) => void runOptionAction(event, option.value)}
                            >
                              {copiedOption === option.value ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                          </Tooltip>
                        )}
                        {option.badge && <em className="custom-select-badge">{option.badge}</em>}
                      </span>
                    </span>
                    {option.detail && <small>{option.detail}</small>}
                  </span>
                </div>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
}

type CopyActionHandler = (value: string) => boolean | Promise<boolean> | Promise<void> | void

export function CopyActionButton({
  children,
  className = "",
  copiedLabel,
  label,
  onCopy,
  size = 14,
  stopPropagation = false,
  value,
}: {
  children?: ReactNode
  className?: string
  copiedLabel?: string
  label: string
  onCopy: CopyActionHandler
  size?: number
  stopPropagation?: boolean
  value: string
}) {
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    },
    [],
  )

  async function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (stopPropagation) event.stopPropagation()
    const result = await onCopy(value)
    if (result === false) return
    setCopied(true)
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = window.setTimeout(() => {
      setCopied(false)
      copiedTimerRef.current = null
    }, 1300)
  }

  return (
    <Tooltip label={copied ? (copiedLabel ?? label) : label}>
      <button
        type="button"
        className={`inline-action-button ${copied ? "copied" : ""} ${className}`.trim()}
        onClick={(event) => void handleClick(event)}
        aria-label={label}
      >
        {copied ? <Check size={size} /> : <Copy size={size} />}
        {children}
      </button>
    </Tooltip>
  )
}

export function ExternalActionButton({
  children,
  className = "",
  href,
  label,
  onOpen,
  size = 14,
  stopPropagation = false,
}: {
  children?: ReactNode
  className?: string
  href?: string
  label: string
  onOpen?: () => void
  size?: number
  stopPropagation?: boolean
}) {
  const icon = <ExternalLink size={size} />
  if (href) {
    return (
      <Tooltip label={label}>
        <a
          className={`inline-action-button ${className}`.trim()}
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-label={label}
        >
          {icon}
          {children}
        </a>
      </Tooltip>
    )
  }

  return (
    <Tooltip label={label}>
      <button
        type="button"
        className={`inline-action-button ${className}`.trim()}
        onClick={(event) => {
          if (stopPropagation) event.stopPropagation()
          onOpen?.()
        }}
        aria-label={label}
      >
        {icon}
        {children}
      </button>
    </Tooltip>
  )
}

export function Tooltip({
  className = "",
  label,
  children,
}: {
  className?: string
  label: string
  children: ReactNode
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [rendered, setRendered] = useState(false)
  const [position, setPosition] = useState<{ left: number; placement: "bottom" | "top"; top: number } | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const frameRef = useRef<number | null>(null)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
    },
    [],
  )

  function show() {
    const rect = readTooltipAnchorRect(rootRef.current)
    if (!rect) return
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
    const placement = rect.top < 86 ? "bottom" : "top"
    const estimatedWidth = Math.min(280, window.innerWidth - 24)
    const minLeft = 12 + estimatedWidth / 2
    const maxLeft = window.innerWidth - 12 - estimatedWidth / 2
    const centeredLeft = rect.left + rect.width / 2
    setPosition({
      left: Math.min(maxLeft, Math.max(minLeft, centeredLeft)),
      placement,
      top: placement === "top" ? rect.top - 10 : rect.bottom + 10,
    })
    setRendered(true)
    frameRef.current = window.requestAnimationFrame(() => setOpen(true))
  }

  function hide() {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    setOpen(false)
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = window.setTimeout(() => {
      setRendered(false)
      closeTimerRef.current = null
    }, 170)
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: this wrapper only positions hover help around children that may already be interactive.
    <span
      className={`tooltip-wrap ${className}`}
      aria-describedby={open ? id : undefined}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
        hide()
      }}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLElement && event.target.matches(":focus-visible")) show()
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") hide()
      }}
      role="presentation"
      onMouseEnter={show}
      onMouseLeave={hide}
      ref={rootRef}
    >
      {children}
      {rendered &&
        position &&
        createPortal(
          <span
            id={id}
            className={`tooltip-bubble floating-tooltip ${position.placement}`}
            data-state={open ? "open" : "closed"}
            role="tooltip"
            style={{ left: position.left, top: position.top }}
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  )
}

function readTooltipAnchorRect(root: HTMLElement | null) {
  if (!root) return null
  const rect = root.getBoundingClientRect()
  if (rect.width > 0 && rect.height > 0) return rect
  const child = Array.from(root.children).find((item): item is HTMLElement => item instanceof HTMLElement)
  return child?.getBoundingClientRect() ?? rect
}

function trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement | null) {
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

export function ChecklistRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className={`check-row ${ok ? "ok" : "needs-attention"}`}>
      {ok ? <CheckCircle2 size={17} /> : <Clock3 size={17} />}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

export function KeyValue({ label, value, link }: { label: string; value: string; link?: string }) {
  return (
    <div className="key-row">
      <span>{label}</span>
      <strong>{value}</strong>
      {link && <ExternalActionButton className="key-row-action" href={link} label={label} />}
    </div>
  )
}
