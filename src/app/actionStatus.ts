import type { MessageBundle } from "./i18n"

type ChainActionStatusMessages = Pick<
  MessageBundle,
  "confirmingTx" | "preparingAction" | "safeExecDirect" | "simulationStatus" | "walletConfirmation"
>

export function chainActionBusyLabel(t: ChainActionStatusMessages, txProgress: string) {
  if (!txProgress) return t.preparingAction
  if (txProgress.startsWith(t.confirmingTx)) return t.confirmingTx
  if (txProgress.startsWith(t.simulationStatus)) return t.simulationStatus
  if (txProgress.startsWith(t.walletConfirmation) || txProgress.startsWith(t.safeExecDirect)) {
    return t.walletConfirmation
  }
  return t.walletConfirmation
}

export type ChainTxStepStatus = "current" | "done" | "pending"

export function chainTxStepStatuses(labels: string[], txProgress: string, isSubmitting: boolean): ChainTxStepStatus[] {
  if (!isSubmitting) return labels.map(() => "pending")
  const currentIndex = labels.findIndex((label) => txProgress.includes(label))
  const activeIndex = currentIndex >= 0 ? currentIndex : 0
  return labels.map((_, index) => {
    if (index < activeIndex) return "done"
    if (index === activeIndex) return "current"
    return "pending"
  })
}
