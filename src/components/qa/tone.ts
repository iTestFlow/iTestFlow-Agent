/**
 * Single source of truth for semantic "tone" → Tailwind class mappings used by
 * status chips, badges, callouts, and tinted surfaces across the app.
 *
 * Every tone resolves to design tokens (success/warning/destructive/primary/...)
 * so light and dark mode adapt automatically — no hardcoded hex, no `!important`
 * dark-mode overrides. Use `toneClass` for tinted pills/surfaces and
 * `toneSolidClass` where a stronger filled treatment is needed.
 */
export type Tone =
  | "neutral"
  | "primary"
  | "info"
  | "success"
  | "warning"
  | "error"
  | "draft"

/**
 * Tinted treatment: subtle background + matching border + readable foreground.
 * Works on both light and dark surfaces.
 *
 * `warning` uses the dark `warning-foreground` in light mode (the bright amber
 * token has poor contrast on a pale tint) and flips to the bright token in dark
 * mode. `draft` uses the violet chart-3 token via explicit alpha so the opacity
 * modifier is guaranteed on an arbitrary color.
 */
export const toneClass: Record<Tone, string> = {
  neutral: "border-border bg-muted text-muted-foreground",
  primary: "border-primary/30 bg-primary/10 text-primary",
  info: "border-primary/30 bg-primary/10 text-primary",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/40 bg-warning/15 text-warning-foreground dark:text-warning",
  error: "border-destructive/30 bg-destructive/10 text-destructive",
  draft:
    "border-[hsl(var(--chart-3)/0.4)] bg-[hsl(var(--chart-3)/0.12)] text-[hsl(var(--chart-3))]",
}

/** Bare foreground color per tone (for icons/text that sit on a neutral surface). */
export const toneTextClass: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  primary: "text-primary",
  info: "text-primary",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
  draft: "text-[hsl(var(--chart-3))]",
}

/**
 * Filled treatment: solid background + on-tone foreground + transparent border.
 * Use sparingly for the single most important item in a set (e.g. a `critical`
 * severity) so it stands apart from the tinted `toneClass` items around it.
 */
export const toneSolidClass: Record<Tone, string> = {
  neutral: "border-transparent bg-secondary text-secondary-foreground",
  primary: "border-transparent bg-primary text-primary-foreground",
  info: "border-transparent bg-primary text-primary-foreground",
  success: "border-transparent bg-success text-success-foreground",
  warning: "border-transparent bg-warning text-warning-foreground",
  error: "border-transparent bg-[hsl(var(--destructive-solid))] text-destructive-foreground",
  draft: "border-transparent bg-[hsl(var(--chart-3-solid))] text-white",
}
