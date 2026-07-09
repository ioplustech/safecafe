import { ArrowUpRight, Copy, FileJson, GitCommit, Globe2, Link2, ShieldCheck, X } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import type { Address } from "viem"
import { CHAIN_ID, compactAddress, formatSafe } from "../protocol"
import { merkleLabel } from "./formatters"
import type { MessageBundle } from "./i18n"
import {
  compactCid,
  type EnsContenthashState,
  findReleaseFile,
  type ReleaseTrustState,
  safeStakingEnsName,
  safeStakingEthLimoUrl,
} from "./releaseTrust"
import type { DataStatus, DiscoveredSafe, Modal } from "./types"
import { ChecklistRow, CustomSelect, KeyValue, Tooltip } from "./ui"

export function DetailModal(props: {
  account: Address | null
  subjectAccount: Address | null
  subjectKind: "self" | "safe"
  discoveredSafes: DiscoveredSafe[]
  safeDiscoveryError: string
  safeDiscoveryStatus: "failed" | "idle" | "loading" | "ready"
  copyText: (value: string) => Promise<void>
  dataStatus: DataStatus
  disconnectWallet: () => void
  modal: NonNullable<Modal>
  onClose: () => void
  openExplorer: (address: Address) => void
  releaseTrust: ReleaseTrustState
  onRefreshSubject: (subject: string) => void
  onUseSignerAsSubject: () => void
  t: MessageBundle
}) {
  const { account, dataStatus, modal, onClose, releaseTrust, subjectAccount, subjectKind, t } = props
  const [subjectInput, setSubjectInput] = useState(subjectKind === "safe" ? (subjectAccount ?? "") : "")
  const dialogRef = useRef<HTMLDivElement>(null)
  const selectedDiscoveredSafe = findDiscoveredSafe(props.discoveredSafes, subjectAccount)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
      if (event.key === "Tab") trapFocus(event, dialogRef.current)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    setSubjectInput(subjectKind === "safe" ? (subjectAccount ?? "") : "")
  }, [subjectAccount, subjectKind])

  let title = t.viewReadiness
  let content: ReactNode = <p>{t.readinessDescription}</p>
  if (modal.type === "trust") {
    title = t.trustCenterTitle
    const releaseRecord = releaseTrust.record
    const hasIpfsRecord = Boolean(releaseRecord?.ipfs?.cid)
    const manifestFile = findReleaseFile(releaseRecord, "release-manifest.json")
    const indexFile = findReleaseFile(releaseRecord, "index.html")
    const currentHost = typeof window === "undefined" ? "" : window.location.hostname
    const sourceLabel = currentHost === "safe-staking.eth.limo" ? t.trustSourceEnsIpfs : t.trustSourceMirror
    const ensContenthashDetail = trustEnsDetail(releaseTrust.ens, t)
    const [statusLabel, statusDescription, statusTone] = trustStatusSummary(releaseTrust, t)
    const manifestUrl = hasIpfsRecord
      ? `${releaseRecord?.ipfs?.gateways.filebase ?? ""}release-manifest.json`
      : "/release-manifest.json"
    content = (
      <div className="trust-center">
        <section className={`trust-status-card ${statusTone}`}>
          <span className="trust-status-icon">
            <ShieldCheck size={18} />
          </span>
          <div>
            <strong>{statusLabel}</strong>
            <p>{statusDescription}</p>
          </div>
        </section>

        <section className="trust-evidence-chain" aria-label={t.trustEvidenceChain}>
          <TrustEvidenceStep
            icon={<Globe2 size={15} />}
            label={t.trustEnsName}
            value={safeStakingEnsName}
            detail={sourceLabel}
          />
          <TrustEvidenceStep
            icon={<Link2 size={15} />}
            label={t.trustContenthash}
            value={releaseTrust.ens.uri ?? t.notChecked}
            detail={ensContenthashDetail}
          />
          <TrustEvidenceStep
            icon={<FileJson size={15} />}
            label={t.trustReleaseManifest}
            value={manifestFile ? compactHash(manifestFile.sha256) : t.notChecked}
            detail={t.trustManifestDetail}
          />
          <TrustEvidenceStep
            icon={<GitCommit size={15} />}
            label={t.trustGitCommit}
            value={releaseRecord ? compactHash(releaseRecord.commit) : t.notChecked}
            detail={releaseRecord?.dirty ? t.trustDirtyBuild : t.trustCleanBuild}
          />
        </section>

        <section className="trust-key-values">
          <KeyValue
            label={t.trustCid}
            value={releaseRecord?.ipfs?.cid ? compactCid(releaseRecord.ipfs.cid) : t.notChecked}
          />
          <KeyValue label={t.version} value={releaseRecord?.version ?? t.notChecked} />
          <KeyValue label={t.trustBuildCommand} value={releaseRecord?.build.command ?? t.notChecked} />
          <KeyValue label={t.trustIndexHash} value={indexFile ? compactHash(indexFile.sha256) : t.notChecked} />
        </section>

        <div className="trust-actions">
          <a className="soft-button" href={safeStakingEthLimoUrl} target="_blank" rel="noreferrer">
            <ArrowUpRight size={15} />
            {t.trustOpenEns}
          </a>
          {releaseRecord?.ipfs?.gateways.dweb && (
            <a className="soft-button" href={releaseRecord.ipfs.gateways.dweb} target="_blank" rel="noreferrer">
              <ArrowUpRight size={15} />
              {t.trustOpenGateway}
            </a>
          )}
          <a className="soft-button" href={manifestUrl} target="_blank" rel="noreferrer">
            <FileJson size={15} />
            {t.trustOpenManifest}
          </a>
          {releaseRecord?.ipfs?.uri && (
            <button type="button" className="soft-button" onClick={() => props.copyText(releaseRecord.ipfs?.uri ?? "")}>
              <Copy size={15} />
              {t.trustCopyUri}
            </button>
          )}
        </div>

        <p className="trust-footnote">{t.trustFootnote}</p>
      </div>
    )
  }
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
          suffix={subjectKind === "safe" ? formatSafeSubjectBadge(selectedDiscoveredSafe, t) : "EOA"}
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
              value: safe.address,
              label: safe.address,
              badge: formatSafeMultisigBadge(safe, t) ?? undefined,
              detail: `${t.managedSafeAddress} ${index + 1}`,
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
      aria-label={title}
      tabIndex={-1}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className={`modal-card ${modal.type === "trust" ? "trust-modal-card" : ""}`}>
        <div className="panel-title">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t.closeDialog}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{content}</div>
      </div>
    </div>
  )
}

function findDiscoveredSafe(safes: DiscoveredSafe[], address: Address | null): DiscoveredSafe | null {
  if (!address) return null
  const normalizedAddress = address.toLowerCase()
  return safes.find((safe) => safe.address.toLowerCase() === normalizedAddress) ?? null
}

function formatSafeMultisigBadge(safe: DiscoveredSafe | null, t: MessageBundle): string | null {
  if (!safe || safe.threshold === null || safe.ownersCount === null) return null
  return `${safe.threshold}/${safe.ownersCount} ${t.safeMultisigBadge}`
}

function formatSafeSubjectBadge(safe: DiscoveredSafe | null, t: MessageBundle) {
  const badge = formatSafeMultisigBadge(safe, t)
  return badge ? t.safeSubjectBadge.replace("{badge}", badge) : t.safeWallet
}

function compactHash(value: string) {
  if (value.length <= 22) return value
  return `${value.slice(0, 12)}...${value.slice(-10)}`
}

function trustEnsDetail(ens: EnsContenthashState, t: MessageBundle) {
  switch (ens.status) {
    case "matched":
      return t.trustContenthashMatches
    case "mismatch":
      return t.trustContenthashMismatch
    case "missing":
      return t.trustContenthashMissing
    case "unsupported":
      return t.trustContenthashUnsupported
    case "error":
      return t.trustContenthashCheckFailed
    case "unchecked":
      return t.trustContenthashUnchecked
    case "loading":
      return t.reading
    default:
      return t.trustContenthashDetail
  }
}

function trustStatusSummary(
  releaseTrust: ReleaseTrustState,
  t: MessageBundle,
): [label: string, description: string, tone: "review" | "verified" | "warning"] {
  const releaseRecord = releaseTrust.record
  if (releaseTrust.kind === "loading" || releaseTrust.ens.status === "loading") {
    return [t.trustStatusReview, t.reading, "review"]
  }
  if (releaseTrust.kind !== "record") {
    return [t.trustStatusReview, t.trustFootnote, "review"]
  }
  if (releaseTrust.ens.status === "matched" && !releaseRecord?.dirty) {
    return [t.trustStatusVerified, t.trustEnsVerifiedNotice, "verified"]
  }
  if (releaseTrust.ens.status === "matched" && releaseRecord?.dirty) {
    return [t.trustStatusReview, t.trustDirtyBuildNotice, "review"]
  }
  if (releaseTrust.ens.status === "mismatch") {
    return [t.trustStatusMismatch, t.trustEnsMismatchNotice, "warning"]
  }
  if (releaseTrust.ens.status === "missing") {
    return [t.trustStatusMissing, t.trustEnsMissingNotice, "warning"]
  }
  if (releaseTrust.ens.status === "unsupported") {
    return [t.trustStatusReview, t.trustEnsUnsupportedNotice, "warning"]
  }
  if (releaseTrust.ens.status === "error") {
    return [t.trustStatusReview, t.trustEnsCheckFailedNotice, "review"]
  }
  return [t.trustStatusReview, t.trustVerifiedNotice, "review"]
}

function TrustEvidenceStep(props: { detail: string; icon: ReactNode; label: string; value: string }) {
  return (
    <div className="trust-evidence-step">
      <span className="trust-evidence-icon">{props.icon}</span>
      <div>
        <small>{props.label}</small>
        <strong>{props.value}</strong>
        <em>{props.detail}</em>
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
