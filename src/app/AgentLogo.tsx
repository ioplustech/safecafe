export function AgentLogo(props: { size?: "md" | "lg" }) {
  return (
    <span className={`agent-logo ${props.size === "lg" ? "large" : ""}`} aria-hidden="true">
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative mark is hidden from assistive technologies by the wrapper. */}
      <svg viewBox="0 0 40 40" focusable="false">
        <rect className="agent-logo-head" x="8" y="12" width="24" height="21" rx="8" />
        <path className="agent-logo-antenna" d="M20 12V6.8" />
        <circle className="agent-logo-antenna-dot" cx="20" cy="5.6" r="2.4" />
        <circle className="agent-logo-eye" cx="15.4" cy="22.4" r="2.1" />
        <circle className="agent-logo-eye" cx="24.6" cy="22.4" r="2.1" />
        <path className="agent-logo-mouth" d="M15.5 28h9" />
      </svg>
    </span>
  )
}
