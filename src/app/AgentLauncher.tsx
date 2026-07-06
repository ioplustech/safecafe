import { useCallback, useEffect, useRef, useState } from "react"
import type { AgentContext } from "../agent"
import type { TxPlan } from "../protocol"
import { AgentChatDialog } from "./AgentChatDialog"
import { AgentLogo } from "./AgentLogo"
import type { MessageBundle } from "./i18n"

const storageKey = "safecafe:agent-launcher-position"
const launcherSize = 56
const edge = 24

export type AgentLauncherProps = {
  t: MessageBundle
  context: AgentContext
  isSubmitting: boolean
  onApplyPlan: (plan: TxPlan) => void
  onConnectWallet: () => Promise<void>
  onExportPlan: (plan: TxPlan) => void
  onSimulatePlan: (plan: TxPlan) => Promise<TxPlan>
  onSubmitPlan: (plan: TxPlan) => Promise<void>
}

export function AgentLauncher(props: AgentLauncherProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [position, setPosition] = useState(() => readPosition())
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.innerWidth < 720)
  const wasOpenRef = useRef(false)
  const dragRef = useRef<{
    moved: boolean
    offsetX: number
    offsetY: number
    pointerId: number
    startX: number
    startY: number
  } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const clampAndSetPosition = useCallback((next: { x: number; y: number }, persist = true) => {
    const clamped = clampPosition(next)
    setPosition(clamped)
    if (persist) {
      window.localStorage.setItem(storageKey, JSON.stringify(clamped))
    }
  }, [])

  useEffect(() => {
    const onResize = () => {
      setIsMobile(window.innerWidth < 720)
      clampAndSetPosition(position)
    }
    window.addEventListener("resize", onResize)
    window.addEventListener("orientationchange", onResize)
    return () => {
      window.removeEventListener("resize", onResize)
      window.removeEventListener("orientationchange", onResize)
    }
  }, [clampAndSetPosition, position])

  useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true
      return
    }
    if (wasOpenRef.current) buttonRef.current?.focus()
  }, [isOpen])

  function onPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    dragRef.current = {
      moved: false,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY)
    if (distance > 6) drag.moved = true
    if (!drag.moved) return
    clampAndSetPosition({ x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY })
  }

  function onPointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag || drag.pointerId !== event.pointerId) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (!drag.moved) setIsOpen((value) => !value)
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`agent-launcher ${isOpen ? "open" : ""}`}
        style={{ left: position.x, top: position.y, right: "auto", bottom: "auto" }}
        aria-label={props.t.agentLauncherLabel}
        aria-expanded={isOpen}
        title={isMobile ? props.t.agentLauncherLabel : props.t.agentDragHint}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            setIsOpen(true)
          }
        }}
      >
        <AgentLogo size="lg" />
        <span className="agent-launcher-dot" />
      </button>
      <AgentChatDialog
        t={props.t}
        isOpen={isOpen}
        anchor={isMobile ? null : position}
        context={props.context}
        isSubmitting={props.isSubmitting}
        onClose={() => setIsOpen(false)}
        onConnectWallet={props.onConnectWallet}
        onApplyPlan={props.onApplyPlan}
        onExportPlan={props.onExportPlan}
        onSimulatePlan={props.onSimulatePlan}
        onSubmitPlan={async (plan) => {
          setIsOpen(false)
          await props.onSubmitPlan(plan)
        }}
      />
    </>
  )
}

function readPosition() {
  if (typeof window === "undefined") return defaultPosition()
  const raw = window.localStorage.getItem(storageKey)
  if (!raw) return defaultPosition()
  try {
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown }
    if (typeof parsed.x === "number" && typeof parsed.y === "number") return clampPosition({ x: parsed.x, y: parsed.y })
  } catch {
    return defaultPosition()
  }
  return defaultPosition()
}

function defaultPosition() {
  if (typeof window === "undefined") return { x: 0, y: 0 }
  return {
    x: window.innerWidth - launcherSize - edge,
    y: window.innerHeight - launcherSize - edge,
  }
}

function clampPosition(position: { x: number; y: number }) {
  if (typeof window === "undefined") return position
  const leftEdge = getLauncherLeftEdge()
  return {
    x: Math.min(window.innerWidth - launcherSize - edge, Math.max(leftEdge, position.x)),
    y: Math.min(window.innerHeight - launcherSize - edge, Math.max(edge, position.y)),
  }
}

function getLauncherLeftEdge() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width").trim()
  const sidebarWidth = Number.parseFloat(raw)
  return Number.isFinite(sidebarWidth) && window.innerWidth > 820 ? sidebarWidth + edge : edge
}
