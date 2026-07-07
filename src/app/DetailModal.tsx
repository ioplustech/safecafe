import { ArrowUpRight, Copy, X } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import type { Address } from "viem"
import { CHAIN_ID, compactAddress, formatSafe } from "../protocol"
import { merkleLabel } from "./formatters"
import type { MessageBundle } from "./i18n"
import type { DataStatus, Modal } from "./types"
import { ChecklistRow, CustomSelect, KeyValue, Tooltip } from "./ui"

export function DetailModal(props: {
  account: Address | null
  subjectAccount: Address | null
  subjectKind: "self" | "safe"
  discoveredSafes: Address[]
  safeDiscoveryError: string
  safeDiscoveryStatus: "failed" | "idle" | "loading" | "ready"
  copyText: (value: string) => Promise<void>
  dataStatus: DataStatus
  disconnectWallet: () => void
  modal: NonNullable<Modal>
  onClose: () => void
  openExplorer: (address: Address) => void
  onRefreshSubject: (subject: string) => void
  onUseSignerAsSubject: () => void
  t: MessageBundle
}) {
  const { account, dataStatus, modal, onClose, subjectAccount, subjectKind, t } = props
  const [subjectInput, setSubjectInput] = useState(subjectKind === "safe" ? (subjectAccount ?? "") : "")
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
      if (event.key === "Tab") trapFocus(event, dialogRef.current)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    setSubjectInput(subjectKind === "safe" ? (subjectAccount ?? "") : "")
  }, [subjectAccount, subjectKind])

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
        <AddressRow
          label={t.signerWallet}
          address={account}
          copyLabel={t.copy}
          openLabel={t.openExplorer}
          copyText={props.copyText}
          openExplorer={props.openExplorer}
        />
        <AddressRow
          label={t.stakingSubject}
          address={subjectAccount}
          suffix={subjectKind === "safe" ? "Safe" : "EOA"}
          fallback={t.notChecked}
          copyLabel={t.copy}
          openLabel={t.openExplorer}
          copyText={props.copyText}
          openExplorer={props.openExplorer}
        />
        <div className="modal-field">
          <span>{t.managedSafeAddress}</span>
          <CustomSelect
            disabled={props.safeDiscoveryStatus === "loading" || props.discoveredSafes.length === 0}
            label={t.managedSafeAddress}
            value={subjectKind === "safe" ? (subjectAccount ?? "") : ""}
            onChange={(value) => {
              setSubjectInput(value)
              props.onRefreshSubject(value)
            }}
            options={props.discoveredSafes.map((safe, index) => ({
              value: safe,
              label: `${t.managedSafeAddress} ${index + 1}`,
              detail: compactAddress(safe, 10, 8),
            }))}
          />
          <small className="modal-field-note">
            {props.safeDiscoveryStatus === "loading"
              ? t.safeDiscoveryLoading
              : props.safeDiscoveryStatus === "failed"
                ? props.safeDiscoveryError || t.safeDiscoveryFailed
                : props.discoveredSafes.length
                  ? t.safeDiscoveryReady
                  : t.safeDiscoveryEmpty}
          </small>
        </div>
        <label className="modal-field">
          <span>{t.safeManualAddress}</span>
          <input
            value={subjectInput}
            spellCheck={false}
            placeholder="0x..."
            onChange={(event) => setSubjectInput(event.target.value)}
          />
        </label>
        <p className="modal-help">{t.managedSafeHint}</p>
        <div className="modal-actions">
          <button type="button" className="soft-button" onClick={() => props.onRefreshSubject(subjectInput)}>
            {t.useManagedSafe}
          </button>
          <button type="button" className="soft-button" onClick={props.onUseSignerAsSubject}>
            {t.useConnectedWallet}
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
      ref={dialogRef}
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
          <Tooltip label={t.closeNotification}>
            <button
              ref={closeButtonRef}
              type="button"
              className="icon-button"
              onClick={onClose}
              aria-label={t.closeNotification}
            >
              <X size={16} />
            </button>
          </Tooltip>
        </div>
        <div className="modal-body">{content}</div>
      </div>
    </div>
  )
}

function AddressRow(props: {
  address: Address | null
  copyLabel: string
  copyText: (value: string) => Promise<void>
  fallback?: string
  label: string
  openExplorer: (address: Address) => void
  openLabel: string
  suffix?: string
}) {
  const address = props.address
  return (
    <div className="address-row">
      <span>{props.label}</span>
      {address ? (
        <>
          <strong>
            {compactAddress(address, 10, 8)}
            {props.suffix ? <em>{props.suffix}</em> : null}
          </strong>
          <div className="address-row-actions">
            <Tooltip label={props.copyLabel}>
              <button
                type="button"
                className="icon-button"
                onClick={() => props.copyText(address)}
                aria-label={`${props.copyLabel} ${props.label}`}
              >
                <Copy size={15} />
              </button>
            </Tooltip>
            <Tooltip label={props.openLabel}>
              <button
                type="button"
                className="icon-button"
                onClick={() => props.openExplorer(address)}
                aria-label={`${props.openLabel} ${props.label}`}
              >
                <ArrowUpRight size={15} />
              </button>
            </Tooltip>
          </div>
        </>
      ) : (
        <strong>{props.fallback ?? ""}</strong>
      )}
    </div>
  )
}

function trapFocus(event: KeyboardEvent, dialog: HTMLElement | null) {
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
