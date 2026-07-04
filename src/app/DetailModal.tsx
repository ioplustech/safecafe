import { ArrowUpRight, Copy, X } from "lucide-react"
import { type ReactNode, useEffect } from "react"
import type { Address } from "viem"
import { CHAIN_ID, compactAddress, formatSafe } from "../protocol"
import { merkleLabel } from "./formatters"
import type { MessageBundle } from "./i18n"
import type { DataStatus, Modal } from "./types"
import { ChecklistRow, KeyValue } from "./ui"

export function DetailModal(props: {
  account: Address | null
  copyText: (value: string) => Promise<void>
  dataStatus: DataStatus
  disconnectWallet: () => void
  modal: NonNullable<Modal>
  onClose: () => void
  openExplorer: (address: Address) => void
  t: MessageBundle
}) {
  const { account, dataStatus, modal, onClose, t } = props
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  let title = t.viewReadiness
  let content: ReactNode = <p>{t.readinessDescription}</p>
  if (modal.type === "validator") {
    title = modal.validator.label
    content = (
      <>
        <KeyValue label={t.address} value={compactAddress(modal.validator.address, 10, 8)} />
        <KeyValue label={t.status} value={modal.validator.status === "active" ? t.active : t.inactive} />
        <KeyValue label={t.participation14d} value={`${modal.validator.participationRate.toFixed(2)}%`} />
        <KeyValue label={t.commission} value={`${modal.validator.commission}%`} />
        <KeyValue label={t.totalSafeStaked} value={`${formatSafe(modal.validator.totalStake)} SAFE`} />
        <KeyValue label={t.yourStake} value={`${formatSafe(modal.validator.userStake)} SAFE`} />
        <div className="modal-actions">
          <button type="button" className="soft-button" onClick={() => props.copyText(modal.validator.address)}>
            <Copy size={15} />
            {t.copy}
          </button>
          <button type="button" className="soft-button" onClick={() => props.openExplorer(modal.validator.address)}>
            <ArrowUpRight size={15} />
            {t.openExplorer}
          </button>
        </div>
      </>
    )
  }
  if (modal.type === "data") {
    title = t.dataHealth
    content = (
      <>
        <ChecklistRow
          label={t.rpc}
          value={dataStatus.liveBlock ? `${t.block} ${dataStatus.liveBlock}` : t.notChecked}
          ok={Boolean(dataStatus.liveBlock) && !dataStatus.liveError}
        />
        <ChecklistRow
          label={t.correctNetwork}
          value={
            dataStatus.chainId === null
              ? t.notChecked
              : dataStatus.chainId === CHAIN_ID
                ? t.ethereumMainnet
                : t.wrongNetwork
          }
          ok={dataStatus.chainId === CHAIN_ID}
        />
        <ChecklistRow
          label={t.validatorInfo}
          value={`${dataStatus.validatorCount} ${t.validators}`}
          ok={dataStatus.validatorCount > 0}
        />
        <ChecklistRow
          label={t.validatorStake}
          value={dataStatus.validatorStakeStatus}
          ok={dataStatus.validatorStakeOk}
        />
        <ChecklistRow
          label={t.rewardsProofSource}
          value={dataStatus.rewardsSource}
          ok={dataStatus.proofFound || dataStatus.isLive}
        />
        <ChecklistRow
          label={t.merkleRoot}
          value={merkleLabel(t, dataStatus.merkleRootMatched)}
          ok={dataStatus.merkleRootMatched !== false}
        />
        {dataStatus.liveError && <p className="warning">{dataStatus.liveError}</p>}
      </>
    )
  }
  if (modal.type === "network") {
    title = t.correctNetwork
    content = (
      <>
        <p>{t.networkDescription}</p>
        <KeyValue label={t.correctNetwork} value={t.ethereumMainnet} />
      </>
    )
  }
  if (modal.type === "wallet") {
    title = t.wallet
    content = account ? (
      <>
        <KeyValue label={t.walletConnected} value={compactAddress(account, 10, 8)} />
        <div className="modal-actions">
          <button type="button" className="soft-button" onClick={() => props.copyText(account)}>
            <Copy size={15} />
            {t.copy}
          </button>
          <button type="button" className="soft-button" onClick={() => props.openExplorer(account)}>
            <ArrowUpRight size={15} />
            {t.openExplorer}
          </button>
          <button
            type="button"
            className="soft-button"
            onClick={() => {
              props.disconnectWallet()
              onClose()
            }}
          >
            {t.disconnect}
          </button>
        </div>
      </>
    ) : (
      <p>{t.noAccount}</p>
    )
  }
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal-card">
        <div className="panel-title">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{content}</div>
      </div>
    </div>
  )
}
