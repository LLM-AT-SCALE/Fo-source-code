/**
 * Browser-side session helpers shared by the chat apps and the home/chat pages.
 *
 * The auth token and session blob live in localStorage under these keys
 * (written by the login page). Every helper is safe to call during SSR: it
 * returns an empty/false value when `window` is not defined.
 */

export const AUTH_SESSION_KEY = "llmatscale_auth_session"
export const AUTH_TOKEN_KEY = "llmatscale_auth_token"

/** JSON headers plus the bearer token (empty token still sends the header). */
export function getAuthHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_KEY) || "" : ""
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  }
}

export function getUserNameFromSession(): string {
  if (typeof window === 'undefined') return "User"
  try {
    const sessionData = localStorage.getItem(AUTH_SESSION_KEY)
    if (sessionData) {
      const session = JSON.parse(sessionData)
      return session.user?.name || session.user?.email?.split('@')[0] || "User"
    }
  } catch {
    // Ignore parse errors
  }
  return "User"
}

export function getUserEmailFromSession(): string {
  if (typeof window === 'undefined') return ""
  try {
    const sessionData = localStorage.getItem(AUTH_SESSION_KEY)
    if (sessionData) {
      const session = JSON.parse(sessionData)
      return session.user?.email || ""
    }
  } catch {
    // Ignore parse errors
  }
  return ""
}

/** True when both the session blob and the token are present locally. */
export function hasLocalToken(): boolean {
  if (typeof window === "undefined") return false
  return !!(localStorage.getItem(AUTH_SESSION_KEY) && localStorage.getItem(AUTH_TOKEN_KEY))
}

export function clearAuthStorage(): void {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY)
    localStorage.removeItem(AUTH_SESSION_KEY)
    localStorage.removeItem("llmatscale_user")
  } catch { /* ignore */ }
}
