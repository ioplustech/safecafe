import { Check, CheckCircle2, ChevronDown, Clock3, ExternalLink } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { formatSafe, formatUsdFromSafe } from "../protocol"
import type { MessageBundle } from "./i18n"

export function FullPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel full-panel enter">
      <div className="panel-title">
        <h2>{title}</h2>
      </div>
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

export function CustomSelect(props: {
  disabled?: boolean
  label: string
  options: Array<{ value: string; label: string; detail?: string }>
  value: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<{
    left: number
    maxHeight: number
    top: number
    width: number
  } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = props.options.find((option) => option.value === props.value) ?? props.options[0]

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

  return (
    <div className={`custom-select ${open ? "open" : ""}`} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-label={props.label}
        disabled={props.disabled || props.options.length === 0}
        onClick={() => setOpen((value) => !value)}
      >
        <span>
          <strong>{selected?.label ?? props.label}</strong>
          {selected?.detail && <small>{selected.detail}</small>}
        </span>
        <ChevronDown size={18} />
      </button>
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
              <button
                type="button"
                className={option.value === props.value ? "selected" : ""}
                key={option.value}
                role="option"
                aria-selected={option.value === props.value}
                onClick={() => {
                  props.onChange(option.value)
                  setOpen(false)
                }}
              >
                <span>
                  <strong>{option.label}</strong>
                  {option.detail && <small>{option.detail}</small>}
                </span>
                {option.value === props.value && <Check size={16} />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
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
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; placement: "bottom" | "top"; top: number } | null>(null)
  const rootRef = useRef<HTMLSpanElement>(null)

  function show() {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return
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
    setOpen(true)
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: this wrapper only positions hover help around children that may already be interactive.
    <span
      className={`tooltip-wrap ${className}`}
      role="presentation"
      onMouseEnter={show}
      onMouseLeave={() => setOpen(false)}
      ref={rootRef}
    >
      {children}
      {open &&
        position &&
        createPortal(
          <span
            className={`tooltip-bubble floating-tooltip ${position.placement}`}
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
      {link && (
        <a href={link} target="_blank" rel="noreferrer" aria-label={label}>
          <ExternalLink size={14} />
        </a>
      )}
    </div>
  )
}
