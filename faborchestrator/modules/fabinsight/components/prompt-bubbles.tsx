"use client"

/**
 * Prompt chips that sit ABOVE the composer — the role's chips from the shared
 * library (admin-managed; auto-selected defaults when Dashboard Scheduling is on).
 *
 * Hover/focus opens a detail card carrying the full prompt. That card is
 * rendered in a portal on `document.body` at fixed coordinates, which is what
 * guarantees the stated requirement: it can never be clipped by the composer's
 * stacking context, and it can never overlap a neighbouring bubble, because it
 * is positioned off the trigger's own rect and flipped/clamped against the
 * viewport rather than laid out among its siblings.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { AnimatePresence, motion } from "motion/react"

import { cn } from "@/shared/lib/utils"

export type BubblePrompt = {
  id: string
  label: string
  blurb: string
  prompt: string
  /** Icon key from the chip library (see ICONS); unknown keys fall back to a dot. */
  icon?: string
}

/** Small line icons by key — identity, never the only cue. */
const ICONS: Record<string, React.ReactNode> = {
  gauge: (
    <>
      <path d="M4 15a8 8 0 0 1 16 0" />
      <path d="M12 15l3.5-4" />
      <path d="M3 19h18" />
    </>
  ),
  table: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M3.5 10h17M9 4.5v15" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
    </>
  ),
  chart: (
    <>
      <path d="M12 4v8l6 3.5" />
      <circle cx="12" cy="12" r="8" />
    </>
  ),
  spark: (
    <>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    </>
  ),
  factory: (
    <>
      <path d="M3 20V10l5 3V10l5 3V9l6 4v7z" />
      <path d="M3 20h18" />
    </>
  ),
  clock: (
    <>
      <path d="M12 8v4l2.5 2.5" />
      <circle cx="12" cy="12" r="8" />
    </>
  ),
  trend: (
    <>
      <path d="M4 18l5-6 4 3 6-8" />
      <path d="M4 20h16" />
    </>
  ),
  wrench: (
    <>
      <path d="M14.5 6.5a3.5 3.5 0 0 0 4.7 4.6l-7.6 7.6a2 2 0 0 1-2.9-2.8l7.6-7.6a3.5 3.5 0 0 0-1.8-1.8z" />
    </>
  ),
  funnel: (
    <>
      <path d="M5 4h14l-5.5 7v6L10.5 19v-8z" />
    </>
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.4" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.4" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.4" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.4" />
    </>
  ),
  bars: (
    <>
      <path d="M4 19V6" />
      <path d="M4 19h16" />
      <rect x="7" y="11" width="3" height="5" rx="0.8" />
      <rect x="12" y="8" width="3" height="8" rx="0.8" />
      <rect x="17" y="13" width="3" height="3" rx="0.8" />
    </>
  ),
}

function Icon({ id }: { id: string | undefined }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {(id && ICONS[id]) ?? <circle cx="12" cy="12" r="8" />}
    </svg>
  )
}

const CARD_W = 340
const GAP = 12

type Anchor = { left: number; top: number; placement: "above" | "below" }

/**
 * Position the detail card off the trigger's viewport rect. Prefers opening
 * upward (the bubbles sit above the composer, so there is room there); flips
 * below only when the card would clip the top of the viewport, and clamps
 * horizontally so it never runs off either edge.
 */
function anchorFor(el: HTMLElement, cardH: number): Anchor {
  const r = el.getBoundingClientRect()
  const centre = r.left + r.width / 2
  const left = Math.min(
    Math.max(GAP, centre - CARD_W / 2),
    window.innerWidth - CARD_W - GAP
  )
  const fitsAbove = r.top - cardH - GAP >= GAP
  return fitsAbove
    ? { left, top: r.top - cardH - GAP, placement: "above" }
    : { left, top: r.bottom + GAP, placement: "below" }
}

function DetailCard({
  item,
  anchor,
  onMeasure,
}: {
  item: BubblePrompt
  anchor: Anchor | null
  onMeasure: (h: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (ref.current) onMeasure(ref.current.offsetHeight)
  }, [item.id, onMeasure])

  return (
    <motion.div
      ref={ref}
      role="tooltip"
      id={`fab-bubble-${item.id}`}
      initial={{ opacity: 0, y: anchor?.placement === "below" ? -6 : 6, scale: 0.98 }}
      animate={{ opacity: anchor ? 1 : 0, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: anchor?.placement === "below" ? -4 : 4, scale: 0.98 }}
      transition={{ duration: 0.16, ease: [0.25, 0.1, 0.25, 1] }}
      className="pointer-events-none fixed z-[9999] rounded-2xl border p-3.5 shadow-[0_18px_44px_-12px_rgba(20,26,55,0.28)]"
      style={{
        left: anchor?.left ?? -9999,
        top: anchor?.top ?? -9999,
        width: CARD_W,
        background: "var(--fabviz-surface, #fff)",
        borderColor: "var(--fabviz-border, #e6e9f4)",
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="flex h-6 w-6 items-center justify-center rounded-lg"
          style={{ background: "var(--fabviz-track)", color: "var(--fabviz-s1)" }}
        >
          <Icon id={item.icon} />
        </span>
        <p
          className="text-[12.5px] font-extrabold tracking-[-0.1px]"
          style={{ color: "var(--fabviz-ink)" }}
        >
          {item.label}
        </p>
      </div>

      {/* The prompt itself is the whole point of the card — requirement tags
          and a call-to-action just crowded it. */}
      <p
        className="mt-2 text-[12px] font-medium leading-[1.5]"
        style={{ color: "var(--fabviz-secondary)" }}
      >
        “{item.prompt}”
      </p>
    </motion.div>
  )
}

export function PromptBubbles({
  items,
  onSelect,
  className,
}: {
  items: BubblePrompt[]
  onSelect: (item: BubblePrompt) => void
  className?: string
}) {
  const [active, setActive] = useState<BubblePrompt | null>(null)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [mounted, setMounted] = useState(false)
  const triggerRef = useRef<HTMLElement | null>(null)
  const groupId = useId()

  useEffect(() => setMounted(true), [])

  const open = useCallback((item: BubblePrompt, el: HTMLElement) => {
    triggerRef.current = el
    setActive(item)
    // Height is unknown until the card renders; anchor with an estimate, then
    // the measure callback corrects it in the same frame the user sees.
    setAnchor(anchorFor(el, 150))
  }, [])

  const close = useCallback(() => {
    triggerRef.current = null
    setActive(null)
    setAnchor(null)
  }, [])

  const remeasure = useCallback((h: number) => {
    if (triggerRef.current) setAnchor(anchorFor(triggerRef.current, h))
  }, [])

  // The card is fixed-positioned off a live rect, so it must follow scroll and
  // resize — or simply close, which is the calmer behaviour mid-scroll.
  useEffect(() => {
    if (!active) return
    const onScroll = () => close()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
    }
    window.addEventListener("scroll", onScroll, true)
    window.addEventListener("resize", onScroll)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("scroll", onScroll, true)
      window.removeEventListener("resize", onScroll)
      window.removeEventListener("keydown", onKey)
    }
  }, [active, close])

  return (
    <>
      <div
        className={cn("flex flex-wrap items-center justify-center gap-2.5", className)}
        role="group"
        aria-label="Suggested dashboards"
      >
        {items.map((item, i) => {
          const isActive = active?.id === item.id
          return (
            <motion.button
              key={item.id}
              type="button"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.04 * i, duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
              onMouseEnter={(e) => open(item, e.currentTarget)}
              onMouseLeave={close}
              onFocus={(e) => open(item, e.currentTarget)}
              onBlur={close}
              onClick={() => {
                close()
                onSelect(item)
              }}
              aria-describedby={isActive ? `fab-bubble-${item.id}` : undefined}
              // `login-chip` carries the platform's hover treatment (indigo text
              // + border), so these read identically to the landing-page chips.
              className={cn(
                "login-chip group inline-flex h-auto items-center gap-2 rounded-[22px]",
                "bg-white px-4 py-[9px] text-[13.5px] font-bold transition-all",
                "hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
                isActive && "-translate-y-px"
              )}
              style={{
                color: "var(--chat-ink)",
                border: "1px solid var(--chat-chip-border)",
                boxShadow: "0 2px 10px rgba(26,34,64,.05)",
              }}
            >
              <span className="flex transition-colors"
                style={{ color: "var(--brand-indigo)" }}
              >
                <Icon id={item.icon} />
              </span>
              {item.label}
            </motion.button>
          )
        })}
      </div>

      {mounted &&
        createPortal(
          <AnimatePresence>
            {active && (
              <DetailCard
                key={`${groupId}-${active.id}`}
                item={active}
                anchor={anchor}
                onMeasure={remeasure}
              />
            )}
          </AnimatePresence>,
          document.body
        )}
    </>
  )
}
