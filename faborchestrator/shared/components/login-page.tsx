"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/shared/components/ui/button"

const AUTH_SESSION_KEY = "llmatscale_auth_session"
const AUTH_TOKEN_KEY = "llmatscale_auth_token"

// Plus Jakarta Sans — V2 design system.
const FONT_STACK =
    "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"

export function LoginPage() {
    const router = useRouter()
    const [error, setError] = React.useState<string | null>(null)
    const [isSubmitting, setIsSubmitting] = React.useState(false)
    const [loginSuccess, setLoginSuccess] = React.useState(false)
    const [showPassword, setShowPassword] = React.useState(false)
    const [keep, setKeep] = React.useState(false)

    React.useEffect(() => {
        if (typeof window === "undefined") return
        const sessionData = window.localStorage.getItem(AUTH_SESSION_KEY)
        const token = window.localStorage.getItem(AUTH_TOKEN_KEY)
        if (sessionData && token) {
            try {
                const session = JSON.parse(sessionData)
                if (session.expiresAt && new Date(session.expiresAt) > new Date()) {
                    router.replace("/home")
                } else {
                    window.localStorage.removeItem(AUTH_SESSION_KEY)
                    window.localStorage.removeItem(AUTH_TOKEN_KEY)
                }
            } catch {
                window.localStorage.removeItem(AUTH_SESSION_KEY)
                window.localStorage.removeItem(AUTH_TOKEN_KEY)
            }
        }
    }, [router])


    const normalizeEmail = (value: string) => value.trim().toLowerCase()

    const writeSession = (
        token: string,
        user: { id: string; email: string; name?: string | null; canCreateDashboards?: boolean },
        expiresAt: string
    ) => {
        window.localStorage.setItem(AUTH_TOKEN_KEY, token)
        window.localStorage.setItem(
            AUTH_SESSION_KEY,
            JSON.stringify({ user, signedInAt: new Date().toISOString(), expiresAt })
        )
    }

    const handleSignIn = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        setError(null)
        setIsSubmitting(true)

        const formData = new FormData(event.currentTarget)
        const email = normalizeEmail(String(formData.get("email") || ""))
        const password = String(formData.get("password") || "")

        if (!email || !password) {
            setError("Please enter your email and password.")
            setIsSubmitting(false)
            return
        }

        try {
            const response = await fetch("/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password }),
            })
            const data = await response.json()
            if (!response.ok) {
                setError(data.error || "Invalid email or password.")
                setIsSubmitting(false)
                return
            }
            writeSession(data.token, data.user, data.expiresAt)
            setLoginSuccess(true)
            setTimeout(() => router.push("/home"), 400)
        } catch (err) {
            console.error("Login error:", err)
            setError("Failed to sign in. Please try again.")
            setIsSubmitting(false)
        }
    }

    const signInLabel = loginSuccess ? "Success" : isSubmitting ? "Signing in…" : "Sign in"

    return (
        <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: "var(--page-surface)" }}>
        <div
            className="grid min-[881px]:grid-cols-[47.4fr_52.6fr]"
            style={{
                fontFamily: FONT_STACK, color: "var(--text-ink)", background: "var(--page-surface)", lineHeight: "normal",
                // Render at 90% but fill the viewport exactly: size the grid to
                // 1/0.9 = 111.11% of the viewport, then scale it back down. This
                // gives the "90% zoom" feel with no scrollbar and no bottom gap.
                width: "111.112%", height: "111.112%",
                transform: "scale(0.9)", transformOrigin: "top left",
            }}
        >
            {/* ── LEFT brand panel ──────────────────────────────────────────── */}
            <div
                className="relative hidden flex-col overflow-hidden text-white min-[881px]:flex"
                style={{
                    padding: "54px 56px",
                    background:
                        "radial-gradient(700px 420px at 80% -10%, rgba(125,130,255,.22), transparent 60%)," +
                        "radial-gradient(560px 520px at -10% 110%, rgba(91,84,232,.30), transparent 55%)," +
                        "linear-gradient(160deg,var(--login-navy-1),var(--login-navy-2) 45%,var(--login-navy-3))",
                }}
            >
                {/* decorative circle */}
                <div
                    className="pointer-events-none absolute"
                    style={{
                        right: -120, bottom: -120, width: 420, height: 420, borderRadius: "50%",
                        border: "1px solid rgba(255,255,255,.06)",
                        boxShadow: "0 0 0 60px rgba(255,255,255,.02), 0 0 0 130px rgba(255,255,255,.015)",
                    }}
                />
                <div className="relative z-10 flex h-full flex-col">
                    {/* brand */}
                    <div className="flex items-center gap-[14px]">
                        <div
                            className="flex h-12 w-12 items-center justify-center rounded-[13px]"
                            style={{ background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))", boxShadow: "0 8px 22px rgba(91,84,232,.4)" }}
                        >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="3" width="8" height="6" rx="1.5"/><rect x="3" y="15" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M12 9v3M12 12H6v3M12 12h6v3"/></svg>
                        </div>
                        <div>
                            <div className="text-[17px] font-extrabold tracking-[0.04em]">ATHENATEC</div>
                            <div className="mt-0.5 text-[10.5px] font-semibold tracking-[0.12em]" style={{ color: "var(--login-brand-label)" }}>FABORCHESTRATOR.AI</div>
                        </div>
                    </div>

                    <div className="mt-[30px] flex items-center gap-3 text-[12px] font-bold tracking-[0.18em]" style={{ color: "var(--login-brand-label)" }}>
                        <span className="h-px w-[34px]" style={{ background: "rgba(170,178,221,.5)" }} />
                        ORCHESTRATION PLATFORM
                    </div>

                    <h1 className="mt-6 text-[64px] font-extrabold leading-[1.04] tracking-[-1.4px]">
                        Your{" "}
                        <span style={{ background: "linear-gradient(110deg,var(--brand-indigo-soft),var(--brand-indigo-pale))", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                            orchestration
                        </span>
                        <br />
                        cockpit.
                    </h1>
                    <p className="mt-5 max-w-[440px] text-[18px] leading-[1.6]" style={{ color: "var(--login-brand-body)" }}>
                        Unify systems. Automate workflows. Transform the enterprise with agentic AI.
                    </p>

                    {/* props */}
                    <div className="mt-auto flex flex-col gap-4 pt-10">
                        {[
                            { svg: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="9 12 11 14 15 9"/></svg>, t: "Four AI agents working as one Nucleus" },
                            { svg: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>, t: "Real-time decisions across MES, ERP & quality" },
                            { svg: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9.2 12l2 2 3.6-3.6"/></svg>, t: "Enterprise-grade security & access control" },
                        ].map((p, i) => (
                            <div key={i} className="flex items-center gap-[15px]">
                                <span className="flex h-[42px] w-[42px] flex-shrink-0 items-center justify-center rounded-xl" style={{ background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.1)", color: "var(--brand-indigo-soft)" }}>{p.svg}</span>
                                <span className="text-[16px] font-semibold" style={{ color: "var(--login-brand-prop)" }}>{p.t}</span>
                            </div>
                        ))}

                        {/* trustbar */}
                        <div className="mt-[30px] flex flex-wrap gap-2.5">
                            {[
                                { svg: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/></svg>, t: "SOC 2 Type II" },
                                { svg: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>, t: "SSO & SAML" },
                                { svg: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>, t: "99.9% uptime" },
                            ].map((tb, i) => (
                                <span key={i} className="flex items-center gap-[7px] rounded-[9px] px-3 py-[7px] text-[12.5px] font-semibold" style={{ color: "var(--login-brand-label)", background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.09)" }}>{tb.svg}{tb.t}</span>
                            ))}
                        </div>
                    </div>

                    <div className="mt-[30px] text-[11.5px]" style={{ color: "var(--login-brand-copyright)" }}>© 2026 Athenatec · FabOrchestrator.AI Platform</div>
                </div>
            </div>

            {/* ── RIGHT form ────────────────────────────────────────────────── */}
            <div className="flex items-center justify-center p-10">
                <div className="w-full max-w-[440px] rounded-[22px] bg-white p-[40px_38px]" style={{ border: "1px solid var(--border-light)", boxShadow: "0 24px 60px rgba(16,21,58,.16)", padding: "40px 38px" }}>
                    <span className="inline-flex items-center gap-2 rounded-[20px] px-[13px] py-[7px] text-[11px] font-bold tracking-[0.05em]" style={{ color: "var(--cockpit-indigo)", background: "var(--brand-indigo-bg)" }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        SECURE SIGN-IN
                    </span>

                    <h2 className="mt-5 text-[31px] font-extrabold tracking-[-.6px]">Sign in to continue</h2>
                    <p className="mt-2 text-[15px] leading-[1.5]" style={{ color: "var(--text-muted-cool)" }}>
                        Welcome back. Enter your credentials to access the platform.
                    </p>

                    {/* SSO */}
                    <div className="mt-6 flex gap-[11px]">
                        <Button type="button" variant="ghost" className="flex h-auto flex-1 items-center justify-center gap-[9px] rounded-xl border bg-white py-[11px] text-[14.5px] font-semibold transition-colors hover:bg-[var(--login-sso-bg)] active:scale-100" style={{ borderColor: "var(--border-light)", color: "var(--text-ink)" }}>
                            <svg width="17" height="17" viewBox="0 0 24 24"><path fill="#f25022" d="M3 3h8v8H3z"/><path fill="#7fba00" d="M13 3h8v8h-8z"/><path fill="#00a4ef" d="M3 13h8v8H3z"/><path fill="#ffb900" d="M13 13h8v8h-8z"/></svg>
                            Microsoft
                        </Button>
                        <Button type="button" variant="ghost" className="flex h-auto flex-1 items-center justify-center gap-[9px] rounded-xl border bg-white py-[11px] text-[14.5px] font-semibold transition-colors hover:bg-[var(--login-sso-bg)] active:scale-100" style={{ borderColor: "var(--border-light)", color: "var(--text-ink)" }}>
                            <svg width="17" height="17" viewBox="0 0 24 24"><path fill="#4285F4" d="M21.6 12.2c0-.6-.1-1.2-.2-1.8H12v3.4h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.1z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.7-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"/><path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1A10 10 0 0 0 2 12c0 1.6.4 3.1 1.1 4.6L6.4 14z"/><path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.4 3-4.1 5.6-4.1z"/></svg>
                            Google
                        </Button>
                    </div>

                    <div className="my-[22px] mb-1 flex items-center gap-[14px] text-[13px] font-semibold" style={{ color: "var(--text-muted-login)" }}>
                        <span className="h-px flex-1" style={{ background: "var(--border-light)" }} />
                        or with work email
                        <span className="h-px flex-1" style={{ background: "var(--border-light)" }} />
                    </div>

                    {error && (
                        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-600">{error}</div>
                    )}

                    <form onSubmit={handleSignIn}>
                        {/* Work email */}
                        <div className="mt-[18px]">
                            <div className="mb-2 text-[14px] font-bold">Work email</div>
                            <div className="login-field flex items-center gap-[11px] rounded-xl px-[15px] py-[13px]" style={{ background: "var(--login-field-bg)", border: "1px solid transparent" }}>
                                <span className="flex flex-shrink-0" style={{ color: "var(--text-[var(--text-subtle)])" }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg></span>
                                <input name="email" type="email" placeholder="name@company.com" autoComplete="email" required className="flex-1 border-none bg-transparent text-[15.5px] outline-none placeholder:text-[var(--text-subtle)]" style={{ color: "var(--text-ink)" }} />
                            </div>
                        </div>

                        {/* Password */}
                        <div className="mt-[18px]">
                            <div className="mb-2 flex items-center justify-between">
                                <span className="text-[14px] font-bold">Password</span>
                                <a href="/forgot-password" className="text-[14px] font-semibold" style={{ color: "var(--brand-indigo)" }}>Forgot password?</a>
                            </div>
                            <div className="login-field flex items-center gap-[11px] rounded-xl px-[15px] py-[13px]" style={{ background: "var(--login-field-bg)", border: "1px solid transparent" }}>
                                <span className="flex flex-shrink-0" style={{ color: "var(--text-[var(--text-subtle)])" }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>
                                <input name="password" type={showPassword ? "text" : "password"} placeholder="••••••••••••" autoComplete="current-password" required className="flex-1 border-none bg-transparent text-[15.5px] outline-none placeholder:text-[var(--text-subtle)]" style={{ color: "var(--text-ink)" }} />
                                <Button type="button" variant="ghost" tabIndex={-1} onClick={() => setShowPassword(!showPassword)} className="flex h-auto w-auto rounded-none border-0 bg-transparent p-0 hover:bg-transparent active:scale-100 dark:hover:bg-transparent" style={{ color: "var(--text-[var(--text-subtle)])" }} aria-label={showPassword ? "Hide password" : "Show password"}>
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
                                </Button>
                            </div>
                        </div>

                        {/* Keep signed in */}
                        <Button type="button" variant="ghost" onClick={() => setKeep(!keep)} className="mt-4 flex h-auto w-fit items-center justify-start gap-2.5 rounded-none border-0 bg-transparent p-0 text-[14.5px] font-medium hover:bg-transparent active:scale-100 dark:hover:bg-transparent" style={{ color: "var(--text-muted-cool)" }}>
                            <span className="flex h-[18px] w-[18px] items-center justify-center rounded-[5px]" style={{ border: keep ? "1.6px solid var(--brand-indigo)" : "1.6px solid var(--border-light)", background: keep ? "var(--brand-indigo)" : "transparent" }}>
                                {keep && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="5 12 10 17 19 7"/></svg>}
                            </span>
                            Keep me signed in on this device
                        </Button>

                        {/* Sign in */}
                        <Button type="submit" variant="ghost" disabled={isSubmitting || loginSuccess} className="mt-[22px] flex h-auto w-full items-center justify-center gap-[9px] rounded-[13px] border-0 py-[15px] text-[16px] font-bold text-white transition-transform hover:-translate-y-px hover:bg-transparent active:scale-100 disabled:cursor-not-allowed disabled:opacity-80 dark:hover:bg-transparent" style={{ background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))", boxShadow: "0 8px 20px rgba(91,84,232,.34)" }}>
                            {signInLabel}
                            {!isSubmitting && !loginSuccess && (
                                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                            )}
                        </Button>
                    </form>

                    <div className="mt-[18px] flex items-center justify-center gap-[7px] text-[12px] font-medium" style={{ color: "var(--text-muted-login)" }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        Protected with enterprise-grade encryption
                    </div>

                    <div className="mt-[22px] text-center text-[14.5px]" style={{ color: "var(--text-muted-cool)" }}>
                        Need access? <span className="cursor-pointer font-bold" style={{ color: "var(--brand-indigo)" }}>Request an account</span>
                    </div>
                </div>
            </div>
        </div>
        </div>
    )
}
