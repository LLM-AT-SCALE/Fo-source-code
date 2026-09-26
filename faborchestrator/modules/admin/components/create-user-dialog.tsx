"use client";

import { useState } from "react";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/shared/components/ui/sheet";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/shared/components/ui/select";
import { toast } from "sonner";
import { Loader2, Mail, CheckCircle } from "lucide-react";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

interface RoleMeta { id: string; name: string }

interface CreateUserDialogProps {
  roles: RoleMeta[];
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateUserDialog({ roles, open, onClose, onCreated }: CreateUserDialogProps) {
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [acceptUrl, setAcceptUrl] = useState("");
  const [errors, setErrors] = useState<{ email?: string; role?: string }>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nextErrors: { email?: string; role?: string } = {};
    if (!email.trim()) nextErrors.email = "Email address is required.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) nextErrors.email = "Enter a valid email address.";
    if (!roleId) nextErrors.role = "Please select a role.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSubmitting(true);

    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    try {
      const res = await fetch("/api/admin/invitations", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email, roleId }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Failed to send invitation");
        setSubmitting(false);
        return;
      }

      setSent(true);
      setAcceptUrl(data.acceptUrl || "");
      toast.success(`Invitation sent to ${email}`);
      onCreated();
    } catch {
      toast.error("Failed to send invitation");
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setEmail("");
    setRoleId("");
    setSent(false);
    setAcceptUrl("");
    setErrors({});
    onClose();
  };

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <SheetContent className="admin-overlay overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Invite User</SheetTitle>
          <SheetDescription>
            Send an invitation email. The user will set their own password.
          </SheetDescription>
        </SheetHeader>

        {sent ? (
          <div className="mt-8 flex flex-col items-center gap-4 text-center">
            <CheckCircle className="h-12 w-12 text-green-500" aria-hidden="true" />
            <h3 className="text-lg font-semibold">Invitation Sent!</h3>
            <p className="text-sm text-muted-foreground">
              An invitation email has been sent to <strong>{email}</strong>.
              They will receive a link to create their account.
            </p>
            {acceptUrl && (
              <div className="mt-4 w-full space-y-2">
                <p className="text-xs text-muted-foreground">
                  Dev: If email is not configured, share this link directly:
                </p>
                <div className="rounded-lg border bg-muted/50 p-3">
                  <code className="break-all text-xs">{acceptUrl}</code>
                </div>
              </div>
            )}
            <Button onClick={handleClose} className="mt-4 w-full">Done</Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email Address <span className="text-destructive" aria-hidden="true">*</span></Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); if (errors.email) setErrors((p) => ({ ...p, email: undefined })); }}
                required
                aria-required="true"
                aria-invalid={!!errors.email}
                aria-describedby={errors.email ? "invite-email-error" : undefined}
                placeholder="user@company.com"
              />
              {errors.email && <p id="invite-email-error" className="text-sm text-destructive">{errors.email}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="invite-role">Role <span className="text-destructive" aria-hidden="true">*</span></Label>
              <Select value={roleId} onValueChange={(v) => { setRoleId(v); if (errors.role) setErrors((p) => ({ ...p, role: undefined })); }}>
                <SelectTrigger id="invite-role" className="h-10 w-full" aria-required="true" aria-invalid={!!errors.role} aria-describedby={errors.role ? "invite-role-error" : undefined}>
                  <SelectValue placeholder="Select a role..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {roles.map((r) => (
                      <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {errors.role && <p id="invite-role-error" className="text-sm text-destructive">{errors.role}</p>}
            </div>

            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">
                The user will receive an email with a link to set their password and create their account. The invitation expires in 7 days.
              </p>
            </div>

            <div className="flex flex-col-reverse gap-2 pt-4 sm:flex-row">
              <Button type="submit" disabled={submitting} className="flex-1">
                {submitting ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> Sending…</>
                ) : (
                  <>
                    <Mail className="mr-2 h-4 w-4" aria-hidden="true" /> Send Invitation
                  </>
                )}
              </Button>
              <Button type="button" variant="outline" onClick={handleClose}>Cancel</Button>
            </div>
          </form>
        )}
      </SheetContent>
    </Sheet>
  );
}
