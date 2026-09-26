/** The signed-in user as the cockpit and reports pages render them (from GET /api/auth/me). */
export interface AuthedUser {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
  /** Admins get the Admin Console entry; /admin re-checks server-side. */
  isAdmin?: boolean
  role: { id: string; name: string; permissions?: string[] } | null
}
