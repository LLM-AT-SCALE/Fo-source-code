"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Loader2, CheckCircle, XCircle, Eye, EyeOff } from "lucide-react";
import { AuthBrandingPanel } from "@/modules/admin/components/auth-branding-panel";
import { AUTH_SESSION_KEY, AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

export default function RegisterPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [loading, setLoading] = useState(true);
  const [valid, setValid] = useState(false);
  const [inviteInfo, setInviteInfo] = useState<{ email: string; roleName: string } | null>(null);
  const [validationError, setValidationError] = useState("");

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  // Validate token on mount
  useEffect(() => {
    if (!token) {
      setValidationError("No invitation token provided.");
      setLoading(false);
      return;
    }

    fetch(`/api/auth/validate-invitation?token=${token}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.valid) {
          setValid(true);
          setInviteInfo({ email: data.email, roleName: data.roleName });
        } else {
          setValidationError(data.error || "Invalid invitation.");
        }
      })
      .catch(() => setValidationError("Failed to validate invitation."))
      .finally(() => setLoading(false));
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/accept-invitation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to create account");
        setSubmitting(false);
        return;
      }

      setSuccess(true);

      // Store the session exactly as the login page does (same keys, same blob shape)
      window.localStorage.setItem(AUTH_TOKEN_KEY, data.token);
      window.localStorage.setItem(
        AUTH_SESSION_KEY,
        JSON.stringify({
          user: data.user,
          signedInAt: new Date().toISOString(),
          expiresAt: data.expiresAt,
        })
      );

      // Open the chat after a moment (same origin, in-app navigation)
      setTimeout(() => router.push("/chat"), 2000);
    } catch {
      setError("Network error. Please try again.");
      setSubmitting(false);
    }
  };

  // Password requirements check
  const hasMinLength = password.length >= 8;
  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const passwordsMatch = password === confirmPassword && password.length > 0;

  return (
    <div className="flex h-full min-h-screen">
      <AuthBrandingPanel />

      {/* Right Panel */}
      <div className="flex flex-1 items-center justify-center bg-background px-6">
        <div className="w-full max-w-md space-y-6">
          {loading ? (
            <div className="flex flex-col items-center gap-4 py-16">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-muted-foreground">Validating invitation...</p>
            </div>
          ) : !valid ? (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
              <XCircle className="h-12 w-12 text-red-500" />
              <h2 className="text-xl font-semibold">Invalid Invitation</h2>
              <p className="text-muted-foreground">{validationError}</p>
            </div>
          ) : success ? (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
              <CheckCircle className="h-12 w-12 text-green-500" />
              <h2 className="text-xl font-semibold">Account Created!</h2>
              <p className="text-muted-foreground">
                Redirecting you to the platform...
              </p>
            </div>
          ) : (
            <>
              <div>
                <h2 className="text-3xl font-semibold">Create your account</h2>
                <p className="mt-2 text-muted-foreground">
                  You&apos;ve been invited as <strong>{inviteInfo?.roleName}</strong>
                </p>
              </div>

              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Email (readonly) */}
                <div className="space-y-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Email</Label>
                  <Input value={inviteInfo?.email || ""} disabled className="h-11 bg-muted/50" />
                </div>

                {/* Name */}
                <div className="space-y-2">
                  <Label htmlFor="reg-name" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Full Name</Label>
                  <Input
                    id="reg-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    placeholder="Your full name"
                    className="h-11"
                    autoFocus
                  />
                </div>

                {/* Password */}
                <div className="space-y-2">
                  <Label htmlFor="reg-password" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Password</Label>
                  <div className="relative">
                    <Input
                      id="reg-password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      placeholder="Min. 8 characters"
                      className="h-11 pr-10"
                    />
                    <Button
                      type="button"
                      variant="link"
                      size="icon"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 h-auto w-auto -translate-y-1/2 text-muted-foreground hover:text-muted-foreground"
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>

                {/* Confirm Password */}
                <div className="space-y-2">
                  <Label htmlFor="reg-confirm" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Confirm Password</Label>
                  <Input
                    id="reg-confirm"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    placeholder="Re-enter password"
                    className="h-11"
                  />
                </div>

                {/* Requirements */}
                {password.length > 0 && (
                  <div className="space-y-1 rounded-lg border bg-muted/30 p-3">
                    <Requirement met={hasMinLength}>At least 8 characters</Requirement>
                    <Requirement met={hasUppercase}>One uppercase letter</Requirement>
                    <Requirement met={hasLowercase}>One lowercase letter</Requirement>
                    <Requirement met={hasNumber}>One number</Requirement>
                    {confirmPassword.length > 0 && (
                      <Requirement met={passwordsMatch}>Passwords match</Requirement>
                    )}
                  </div>
                )}

                <Button
                  type="submit"
                  disabled={submitting || !hasMinLength || !passwordsMatch}
                  className="h-11 w-full rounded-lg bg-gradient-to-r from-auth-grad-from via-auth-grad-via to-auth-grad-to text-base text-white shadow-lg shadow-purple-800/30 hover:from-auth-grad-from-2 hover:via-auth-grad-via-2 hover:to-auth-grad-to-2"
                >
                  {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : "Create Account"}
                </Button>
              </form>

              <p className="text-center text-sm text-muted-foreground">
                Powered by <span className="font-medium text-foreground">LLMatscale.ai</span>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Requirement({ met, children }: { met: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {met ? (
        <CheckCircle className="h-3.5 w-3.5 text-green-500" />
      ) : (
        <XCircle className="h-3.5 w-3.5 text-muted-foreground/50" />
      )}
      <span className={met ? "text-green-700 dark:text-green-400" : "text-muted-foreground"}>
        {children}
      </span>
    </div>
  );
}
