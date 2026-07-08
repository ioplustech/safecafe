import { useCallback, useEffect, useRef, useState } from "react"
import type { AgentContext } from "../agent"
import type { TxPlan } from "../protocol"
import { AgentChatDialog } from "./AgentChatDialog"
import { AgentLogo } from "./AgentLogo"
import type { MessageBundle } from "./i18n"
import { appStorageKeys, readStorageJson, writeStorageJson } from "./persistence"
import { Tooltip } from "./ui"

const launcherSize = 56
const edge = 24
const dialogExitMs = 180
const draggable = readDraggableEnabled(import.meta.env.VITE_AGENT_LAUNCHER_DRAGGABLE)

export type AgentLauncherProps = {
  t: MessageBundle
  context: AgentContext
  isSubmitting: boolean
  rpcAuthToken: string | null
  onAuthenticateAgent: () => Promise<string | null>
  onConnectWallet: () => Promise<void>
  onOpen?: () => void
  onRefreshLiveData: () => Promise<AgentContext | null>
  onSimulatePlan: (plan: TxPlan) => Promise<TxPlan>
  onSubmitPlan: (plan: TxPlan) => Promise<void>
}

export function AgentLauncher(props: AgentLauncherProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [hasOpenedDialog, setHasOpenedDialog] = useState(false)
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
      writeStorageJson(appStorageKeys.agentLauncherPosition, clamped)
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
      setHasOpenedDialog(true)
      return
    }
    const timer = window.setTimeout(() => {
      if (wasOpenRef.current) buttonRef.current?.focus()
    }, dialogExitMs)
    return () => window.clearTimeout(timer)
  }, [isOpen])

  useEffect(() => {
    if (isOpen) props.onOpen?.()
  }, [isOpen, props.onOpen])

  function onPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (isOpen) return
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
    if (isOpen) return
    if (!draggable) return
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
    if (isOpen) return
    if (!drag || drag.pointerId !== event.pointerId) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (!drag.moved) {
      setIsOpen(true)
    }
  }

  return (
    <>
      <Tooltip label={isMobile || !draggable ? props.t.agentLauncherLabel : props.t.agentDragHint}>
        <button
          ref={buttonRef}
          type="button"
          className={`agent-launcher${draggable ? "" : " fixed"}${isOpen ? " open" : ""}`}
          style={draggable ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : undefined}
          aria-label={props.t.agentLauncherLabel}
          aria-expanded={isOpen}
          aria-hidden={isOpen}
          tabIndex={isOpen ? -1 : 0}
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
      </Tooltip>
      {hasOpenedDialog && (
        <AgentChatDialog
          t={props.t}
          isOpen={isOpen}
          isClosing={!isOpen}
          anchor={isMobile ? null : position}
          context={props.context}
          isSubmitting={props.isSubmitting}
          rpcAuthToken={props.rpcAuthToken}
          onAuthenticateAgent={props.onAuthenticateAgent}
          onClose={() => setIsOpen(false)}
          onConnectWallet={props.onConnectWallet}
          onRefreshLiveData={props.onRefreshLiveData}
          onSimulatePlan={props.onSimulatePlan}
          onSubmitPlan={props.onSubmitPlan}
        />
      )}
    </>
  )
}

function readPosition() {
  if (typeof window === "undefined") return defaultPosition()
  return (
    readStorageJson(appStorageKeys.agentLauncherPosition, (parsed) => {
      if (!parsed || typeof parsed !== "object") return null
      const record = parsed as { x?: unknown; y?: unknown }
      if (typeof record.x === "number" && typeof record.y === "number") {
        return clampPosition({ x: record.x, y: record.y })
      }
      return null
    }) ?? defaultPosition()
  )
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

function readDraggableEnabled(value: unknown) {
  if (typeof value !== "string") return false
  return value.trim().toLowerCase() === "true"
}
