import "./LoadingSpinner.css";

interface LoadingSpinnerProps {
  /** Already-translated text shown beside the spinner (omit for icon-only). */
  label?: string;
  /** Icon size in px. Defaults to 14 to match inline loading text. */
  size?: number;
  /** Extra class on the wrapper, e.g. to slot into a section's layout. */
  className?: string;
}

/**
 * Shared loading indicator: an animated spinner plus optional label.
 *
 * Most loading states across the dashboard historically rendered bare
 * "Loading…" text with no spinner, so nothing actually spun. Drop this inside
 * the existing loading container (keeping its class for layout) and pass the
 * translated label to get a consistent animated spinner everywhere.
 *
 * The icon is a self-contained inline SVG (visually identical to lucide's
 * Loader2) rather than a `lucide-react` import, so it renders in component
 * tests that stub `lucide-react` with a partial mock. It spins via the global
 * `.animate-spin` keyframe in styles.css.
 */
export const LoadingSpinner = ({ label, size = 14, className }: LoadingSpinnerProps) => (
  <span
    className={className ? `loading-spinner ${className}` : "loading-spinner"}
    role="status"
    aria-live="polite"
  >
    <svg
      className="animate-spin"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
    {label ? <span className="loading-spinner__label">{label}</span> : null}
  </span>
);
