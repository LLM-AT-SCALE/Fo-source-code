/**
 * Compact "how long ago" for activity rows: "just now", "2 min", "1 hr", "3 d", "2 mo".
 * Callers append " ago" when the text sits in a sentence. Returns "" for an unreadable date.
 */
export function relativeTimeShort(when: string | Date | null | undefined, now: number = Date.now()): string {
  if (!when) return ""
  const t = typeof when === "string" ? Date.parse(when) : when.getTime()
  if (Number.isNaN(t)) return ""
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hr`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} d`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo} mo`
  return `${Math.round(mo / 12)} yr`
}
