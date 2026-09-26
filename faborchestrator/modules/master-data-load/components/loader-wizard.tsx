"use client";

import { cmfFetch } from "@/modules/master-data-load/lib/cmf/client-auth";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ShieldCheck,
  Database,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Lightbulb,
  FileSpreadsheet,
  Upload,
  ListChecks,
  RotateCw,
  FileText,
  MinusCircle,
} from "lucide-react";
import { StepProgress, type WizardStep } from "@/modules/master-data-load/components/step-progress";
import { CmfStatusIndicator } from "@/modules/master-data-load/components/cmf-status-indicator";
import { CmfDatabaseToggle } from "@/modules/master-data-load/components/cmf-database-toggle";
import { FileDropZone } from "@/modules/master-data-load/components/file-drop-zone";
import { ObjectTypeSelector } from "@/modules/master-data-load/components/object-type-selector";
import { ExecutionLogViewer } from "@/modules/master-data-load/components/execution-log-viewer";
import { PackageMetaCard } from "@/modules/master-data-load/components/package-meta-card";
import { PreExecutionDialog } from "@/modules/master-data-load/components/pre-execution-dialog";
import { ResultBadge, StatusBadge } from "@/modules/master-data-load/components/status-badge";
import { useExecutionRun } from "@/modules/master-data-load/hooks/use-execution-run";
import { Button } from "@/shared/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/shared/components/ui/alert";
import { Badge } from "@/shared/components/ui/badge";
import { Spinner } from "@/shared/components/ui/spinner";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Checkbox } from "@/shared/components/ui/checkbox";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { Separator } from "@/shared/components/ui/separator";
import type { ExecutionLogEntry, ExecutionResult, MasterDataPackage, UserFriendlyObjectType } from "@/modules/master-data-load/lib/cmf/types";
import { cn } from "@/shared/lib/utils";

const STEPS: WizardStep[] = [
  { key: "upload", label: "Upload", icon: Upload, hint: "Name the package and choose the .xlsx file to load." },
  { key: "validate", label: "Validate", icon: ShieldCheck, hint: "We check the file against the template and CMF — no data is written yet." },
  { key: "select", label: "Select", icon: ListChecks, hint: "Choose which object types from the file should be written to CMF." },
  { key: "load", label: "Load to MES", icon: Database, hint: "Commit the selected object types to the live CMF database." },
];

/** Sort errors first, warnings next, info last — so blockers float to the top. */
function sevRank(s: string): number {
  return s === "error" ? 0 : s === "warning" ? 1 : 2;
}

/** Tailwind text colour per severity. */
function sevClass(s: string): string {
  if (s === "error") return "text-destructive";
  if (s === "warning") return "text-amber-700 dark:text-amber-300";
  return "text-emerald-700 dark:text-emerald-300";
}

function formatBytes(size?: string | number | null): string {
  if (size == null) return "";
  const n = typeof size === "string" ? Number(size) : size;
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Ticks elapsed milliseconds while `active`, resets to 0 when it restarts. */
function useElapsed(active: boolean): number {
  const [ms, setMs] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active) {
      startRef.current = null;
      return;
    }
    startRef.current = Date.now();
    setMs(0);
    const id = setInterval(() => {
      if (startRef.current != null) setMs(Date.now() - startRef.current);
    }, 250);
    return () => clearInterval(id);
  }, [active]);
  return ms;
}

function fmtClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type CheckError = {
  objectType: string;
  row: number | null;
  column: string | null;
  severity: string;
  message: string;
  category?: string;
};
type ErrorExplanation = {
  objectType: string;
  row: number | null;
  column: string | null;
  problem: string;
  expected?: string | null;
  found?: string | null;
  why: string;
  howToFix: string;
  steps?: string[];
};
/**
 * The reason shown under an error toast. Routes answer `{ error: { title,
 * description, errorId } }`; the description is the real cause (CMF's own
 * message, the driver's text, the file store's rejection) and the id is the
 * error-log record an administrator can open. Both belong on the toast.
 */
function failureText(
  data: { error?: { description?: string; errorId?: string } } | undefined,
  status: number,
): string {
  const d = data?.error?.description ?? `HTTP ${status}`;
  const id = data?.error?.errorId;
  return id ? `${d} (error id ${id})` : d;
}

type ValidationData = {
  ok: boolean;
  errorCount: number;
  warningCount: number;
  infoCount?: number;
  errorsByType: Record<string, CheckError[]>;
  explanations?: ErrorExplanation[];
};

export function LoaderWizard({
  initialPackageId,
  resumeDraftId,
}: {
  initialPackageId?: string;
  resumeDraftId?: string;
}) {
  const router = useRouter();
  // Hydrated (re-run from history) jumps straight to Select; a fresh flow starts at Upload.
  const [packageId, setPackageId] = useState<string | null>(initialPackageId ?? null);
  const [stagingId, setStagingId] = useState<string | null>(null);
  const [pkgName, setPkgName] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [step, setStep] = useState<number>(initialPackageId ? 2 : 0);
  const [maxReachable, setMaxReachable] = useState<number>(initialPackageId ? 2 : 0);
  const [objectTypes, setObjectTypes] = useState<UserFriendlyObjectType[]>([]);
  const [selected, setSelected] = useState<UserFriendlyObjectType[]>([]);
  const [hydrating, setHydrating] = useState(!!initialPackageId || !!resumeDraftId);
  const [loadDialogOpen, setLoadDialogOpen] = useState(false);
  // True once a load has been submitted in THIS session — gates the receipt so
  // a re-run from history (whose package already carries a prior result) doesn't
  // render "Load complete" before the user has loaded anything.
  const [loadSubmitted, setLoadSubmitted] = useState(false);

  const [validation, setValidation] = useState<ValidationData | null>(null);
  const [validating, setValidating] = useState(false);
  const [registering, setRegistering] = useState(false);
  // The local template check is optional (user can skip it on the Validate step).
  // CMF's own dry-run validation below always runs — it is never skippable — so a
  // file is never loaded unverified. Default: template check ON.
  const [skipTemplate, setSkipTemplate] = useState(false);
  // Validation is manual: nothing runs until the user clicks "Start validation"
  // on the Validate step (the CMF dry-run is a slow, VPN-dependent call, so we
  // don't fire it automatically on arrival).
  const [validationStarted, setValidationStarted] = useState(false);
  // CMF's own validation (op=1, no write) — runs after register, before Select.
  const [cmfValidating, setCmfValidating] = useState(false);
  const [cmfErrors, setCmfErrors] = useState<{ name: string; message: string }[] | null>(null);
  const [cmfExplanations, setCmfExplanations] = useState<ErrorExplanation[]>([]);
  const [cmfTimedOut, setCmfTimedOut] = useState(false);

  const run = useExecutionRun(packageId);
  const { pkg, setPkg, runningOp, submitting, log, result, attempts } = run;

  // A committed load: freeze navigation and switch the Load step to its receipt.
  const loaded = loadSubmitted && step === 3 && !runningOp && !submitting && result != null;

  // Guards: prevent double-invoking the register+CMF-validate sequence, and
  // ensure it auto-starts at most once per staged file.
  const cmfInFlightRef = useRef(false);
  const autoCmfRef = useRef<string | null>(null);

  // Hydrate an existing package (re-run from Recent/summary).
  useEffect(() => {
    if (!initialPackageId) return;
    let cancelled = false;
    run
      .fetchDetail()
      .then((d) => {
        if (cancelled) return;
        setPkg(d.instance);
        setObjectTypes(d.objectTypes);
        setPkgName(d.instance?.Name ?? "");
        setFileName(d.instance?.Package?.Filename ?? null);
        setFileSize(d.instance?.Package?.Size != null ? Number(d.instance.Package.Size) : null);
        setHydrating(false);
      })
      .catch((e) => {
        if (cancelled) return;
        toast.error("Couldn't open package", { description: String(e) });
        setHydrating(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPackageId]);

  // Resume an interrupted (pre-register) flow from Recent: drop the user at the
  // Validate step with the staged file restored. (Registered flows are resumed
  // via /packages/[cmfId], the initialPackageId path above.)
  useEffect(() => {
    if (!resumeDraftId) return;
    let cancelled = false;
    cmfFetch(`/api/cmf/packages/stage/${encodeURIComponent(resumeDraftId)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.error?.description ?? `HTTP ${r.status}`);
        return d as { packageName?: string | null; packageCmfId?: string | null; fileName?: string | null; fileSize?: number | null; status?: string };
      })
      .then((d) => {
        if (cancelled) return;
        if (d.packageCmfId) {
          // Already registered — send to the package flow (Select step).
          router.replace(`/modeling-agent/loader/${encodeURIComponent(d.packageCmfId)}`);
          return;
        }
        setStagingId(resumeDraftId);
        setPkgName(d.packageName ?? "");
        setFileName(d.fileName ?? null);
        setFileSize(d.fileSize ?? null);
        setStep(1);
        setMaxReachable((m) => Math.max(m, 1));
        setHydrating(false);
      })
      .catch((e) => {
        if (cancelled) return;
        toast.error("Couldn't resume this flow", { description: String(e) });
        setHydrating(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeDraftId]);

  const goto = useCallback(
    (i: number) => setStep((s) => (!loaded && i <= maxReachable ? i : s)),
    [maxReachable, loaded],
  );
  const advanceTo = useCallback((i: number) => {
    setStep(i);
    setMaxReachable((m) => Math.max(m, i));
  }, []);

  const runValidate = useCallback(async () => {
    if (!stagingId) return;
    setValidating(true);
    setValidation(null);
    setCmfErrors(null);
    setCmfExplanations([]);
    setCmfTimedOut(false);
    try {
      const res = await cmfFetch(`/api/cmf/packages/stage/${encodeURIComponent(stagingId)}/validate`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as ValidationData & {
        error?: { title?: string; description?: string; errorId?: string };
      };
      if (!res.ok) {
        toast.error(data.error?.title ?? "Validation failed", {
          description: failureText(data, res.status),
        });
        return;
      }
      setValidation(data);
      if (data.ok && (data.warningCount ?? 0) === 0) {
        toast.success("Pre-flight check passed");
      } else if (data.ok) {
        toast.info(
          `Pre-flight passed with ${data.warningCount} warning${data.warningCount === 1 ? "" : "s"} — review before continuing`,
        );
      } else {
        toast.error(`Found ${data.errorCount} pre-flight error${data.errorCount === 1 ? "" : "s"}`);
      }
    } catch (err) {
      toast.error("Validation failed", { description: String(err) });
    } finally {
      setValidating(false);
    }
  }, [stagingId]);

  // Run the template check once the user starts validation — unless they chose to
  // skip it (then we go straight to CMF's compulsory dry-run). Nothing runs until
  // `validationStarted` is set by the Start button.
  useEffect(() => {
    if (step === 1 && validationStarted && stagingId && !skipTemplate && !validation && !validating)
      void runValidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, stagingId, skipTemplate, validationStarted]);

  // Poll CMF for a given package until its execution completes; classify the
  // result. Shared by the initial register-and-validate and the "Check again"
  // retry (which must NOT re-register — that would create a duplicate package).
  const pollCmfValidation = useCallback(
    async (cmfId: string, types: UserFriendlyObjectType[]): Promise<void> => {
      if (!types || types.length === 0) {
        // Nothing CMF-detectable to validate — go straight to Select.
        router.replace(`/modeling-agent/loader/${encodeURIComponent(cmfId)}`);
        advanceTo(2);
        return;
      }
      setCmfValidating(true);
      setCmfErrors(null);
      setCmfExplanations([]);
      setCmfTimedOut(false);
      try {
        const vRes = await cmfFetch(`/api/cmf/packages/${encodeURIComponent(cmfId)}/validate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ selectedTypes: types }),
        });
        if (!vRes.ok && vRes.status !== 202) {
          const vd = (await vRes.json().catch(() => ({}))) as {
            error?: { title?: string; description?: string; errorId?: string };
          };
          toast.error(vd.error?.title ?? "CMF validation couldn't start", {
            description: failureText(vd, vRes.status),
          });
          setCmfTimedOut(true);
          return;
        }

        // Poll until the run completes (LastExecutionEndDate is set). Generous
        // cap for slow VPN links — on exhaustion we offer "Check again" rather
        // than dead-ending.
        let logEntries: ExecutionLogEntry[] = [];
        let resultCode: number | undefined;
        let completed = false;
        for (let i = 0; i < 80; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          const dRes = await cmfFetch(`/api/cmf/packages/${encodeURIComponent(cmfId)}`, { cache: "no-store" });
          const dd = (await dRes.json().catch(() => ({}))) as {
            instance?: MasterDataPackage;
            error?: { title?: string; description?: string; errorId?: string };
          };
          if (!dRes.ok) {
            // CMF stopped answering mid-poll (token, VPN). Say so now rather
            // than polling for two minutes and reporting "taking longer".
            toast.error(dd.error?.title ?? "Couldn't check the CMF run", {
              description: failureText(dd, dRes.status),
            });
            setCmfTimedOut(true);
            return;
          }
          const inst = dd.instance;
          if (inst?.LastExecutionEndDate) {
            try {
              logEntries = JSON.parse(inst.LastExecutionLog ?? "[]") as ExecutionLogEntry[];
            } catch {
              logEntries = [];
            }
            resultCode = inst.LastExecutionResult as number | undefined;
            completed = true;
            break;
          }
        }

        if (!completed) {
          setCmfTimedOut(true);
          toast.warning("CMF is taking longer than expected", {
            description: "It may still be running. Click “Check again” to re-check.",
          });
          return;
        }

        // State===3 entries are CMF failures (it stops at the first one).
        const errs = logEntries
          .filter((e) => (e as { State?: number }).State === 3)
          .map((e) => ({
            name: e.Name,
            message:
              (e.Messages ?? []).find((m) => /error/i.test(m)) ??
              (e.Messages ?? []).join(" ") ??
              "Validation failed.",
          }));

        if (resultCode === 0 && errs.length === 0) {
          toast.success("CMF validation passed");
          router.replace(`/modeling-agent/loader/${encodeURIComponent(cmfId)}`);
          advanceTo(2);
        } else if (errs.length > 0) {
          setCmfErrors(errs);
          toast.error(`CMF validation found ${errs.length} error${errs.length === 1 ? "" : "s"}`);
          try {
            const exRes = await cmfFetch(
              `/api/cmf/packages/${encodeURIComponent(cmfId)}/validate/explain`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  errors: errs.map((e) => ({ objectType: e.name, message: e.message })),
                }),
              },
            );
            const exData = (await exRes.json().catch(() => ({}))) as {
              explanations?: ErrorExplanation[];
            };
            setCmfExplanations(exData.explanations ?? []);
          } catch {
            /* enrichment is best-effort; the raw CMF error is still shown */
          }
        } else {
          setCmfTimedOut(true);
          toast.error("CMF validation didn't complete", { description: "Click “Check again” to retry." });
        }
      } finally {
        setCmfValidating(false);
      }
    },
    [router, advanceTo],
  );

  // After the template check passes: register the file in CMF (once), then run
  // CMF's OWN dry-run validation. If already registered, skip straight to the
  // validation poll so retries never create a duplicate package.
  const registerAndValidate = useCallback(async () => {
    // Gate to proceed to CMF: either the template check passed, or the user chose
    // to skip it. CMF's dry-run (below) is compulsory either way.
    if (!skipTemplate && !validation?.ok) return;
    if (cmfInFlightRef.current) return;
    cmfInFlightRef.current = true;
    try {
      let cmfId = packageId;
      // Types must travel as an explicit argument — reading them back from
      // state here would see the pre-setObjectTypes value (React batches the
      // update), sending an empty selectedTypes and tripping CMF's
      // "choose at least one object type" guard.
      let types = objectTypes;

      if (!cmfId) {
        if (!stagingId) return;
        setRegistering(true);
        try {
          const res = await cmfFetch(`/api/cmf/packages/stage/${encodeURIComponent(stagingId)}/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: pkgName, skipTemplateCheck: skipTemplate }),
          });
          const data = (await res.json().catch(() => ({}))) as {
            packageId?: string;
            objectTypes?: UserFriendlyObjectType[];
            error?: { title?: string; description?: string; errorId?: string };
          };
          if (!res.ok || !data.packageId) {
            toast.error(data.error?.title ?? "Couldn't register the package", {
              description: failureText(data, res.status),
            });
            return;
          }
          cmfId = data.packageId;
          types = data.objectTypes ?? [];
          setPackageId(cmfId);
          setObjectTypes(types);
        } finally {
          setRegistering(false);
        }
      }

      await pollCmfValidation(cmfId, types);
    } catch (err) {
      toast.error("CMF validation failed", { description: String(err) });
    } finally {
      cmfInFlightRef.current = false;
    }
  }, [skipTemplate, validation, packageId, stagingId, pkgName, objectTypes, pollCmfValidation]);

  // Chain the two checks automatically: as soon as the template check passes,
  // register + run CMF's dry-run without waiting for a button. Warnings no
  // longer gate this — they're still shown, but the flow keeps moving (on a
  // clean CMF result it advances straight to Select).
  useEffect(() => {
    if (
      step === 1 &&
      validationStarted &&
      (validation?.ok || skipTemplate) &&
      stagingId &&
      !packageId &&
      autoCmfRef.current !== stagingId
    ) {
      autoCmfRef.current = stagingId;
      void registerAndValidate();
    }
  }, [step, validationStarted, validation, skipTemplate, stagingId, packageId, registerAndValidate]);

  const doLoad = useCallback(() => {
    setLoadDialogOpen(false);
    setLoadSubmitted(true);
    void run.start("load", selected);
  }, [run, selected]);

  const currentStatus =
    runningOp != null ? (
      <StatusBadge status="running" label="Loading" code={`POLL-${attempts}`} />
    ) : loaded ? (
      <ResultBadge result={result} />
    ) : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-heading text-2xl font-semibold tracking-tight">Master Data Loader</h1>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              Upload a package, validate it against the template and CMF (nothing is written yet),
              choose object types, then load them into the MES.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              {/* Same CMF database toggle as the chat — chooses which CMF the
                  loader validates against and loads into (via the x-cmf-db-key
                  header cmfFetch sends). onChange is unused here; the routes read
                  the header/preference server-side. */}
              <CmfDatabaseToggle onChange={() => {}} />
              <CmfStatusIndicator />
            </div>
            {currentStatus}
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card px-4 py-4 shadow-sm">
          {/* Display-only: steps don't navigate. Forward is via each step's
              action button; backward is via the Back button below. */}
          <StepProgress steps={STEPS} current={step} maxReachable={maxReachable} locked={loaded} />
        </div>
      </header>

      {step > 0 && (
        <ContextHeader
          pkgName={pkgName}
          fileName={fileName}
          fileSize={fileSize}
          typeCount={objectTypes.length}
          selectedCount={selected.length}
          step={step}
        />
      )}

      {hydrating ? (
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="flex flex-col gap-4">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-40 w-full" />
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          {step === 0 && (
            <UploadStep
              onStaged={(id, name, fName, fSize) => {
                setStagingId(id);
                setPkgName(name);
                setFileName(fName);
                setFileSize(fSize);
                setValidation(null);
                setValidationStarted(false);
                advanceTo(1);
              }}
            />
          )}

          {step === 1 && (
            <ValidateStep
              loading={validating}
              data={validation}
              onRerun={runValidate}
              onNext={registerAndValidate}
              nextBusy={registering || cmfValidating}
              registering={registering}
              cmfValidating={cmfValidating}
              cmfErrors={cmfErrors}
              cmfExplanations={cmfExplanations}
              cmfTimedOut={cmfTimedOut}
              onCheckAgain={() => packageId && void pollCmfValidation(packageId, objectTypes)}
              skipTemplate={skipTemplate}
              onToggleSkip={setSkipTemplate}
              skipToggleLocked={validationStarted || !!packageId || registering || cmfValidating}
              validationStarted={validationStarted}
              onStart={() => setValidationStarted(true)}
            />
          )}

          {step === 2 && (
            <div className="flex flex-col gap-5">
              <ObjectTypeSelector objectTypes={objectTypes} selected={selected} onChange={setSelected} />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {selected.length === 0
                    ? "Select at least one object type to continue."
                    : `${selected.length} object type${selected.length === 1 ? "" : "s"} selected.`}
                </p>
                <Button disabled={selected.length === 0} onClick={() => advanceTo(3)}>
                  Next: Load to MES
                  <ArrowRight data-icon="inline-end" aria-hidden />
                </Button>
              </div>
              {pkg && (
                <details className="group rounded-lg border border-border">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground">
                    <FileText className="size-4" aria-hidden />
                    Package details
                    <ArrowRight className="ml-auto size-4 transition-transform group-open:rotate-90" aria-hidden />
                  </summary>
                  <div className="border-t border-border p-4">
                    <PackageMetaCard pkg={pkg} className="border-0 shadow-none" />
                  </div>
                </details>
              )}
            </div>
          )}

          {step === 3 && (
            <LoadStep
              busy={runningOp === "load" || submitting}
              done={loaded}
              result={result}
              log={log}
              selected={selected}
              onRequestLoad={() => setLoadDialogOpen(true)}
              onReset={() => router.push("/modeling-agent")}
            />
          )}
        </div>
      )}

      {step > 0 && !loaded && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => goto(step - 1)}>
            <ArrowLeft data-icon="inline-start" aria-hidden /> Back
          </Button>
        </div>
      )}

      <PreExecutionDialog
        open={loadDialogOpen}
        onOpenChange={setLoadDialogOpen}
        op="load"
        packageName={pkgName}
        fileName={fileName ?? undefined}
        fileSizeBytes={fileSize ?? undefined}
        checksum={pkg?.Package?.Checksum}
        selected={selected}
        totalAvailable={objectTypes.length}
        onConfirm={doLoad}
        requireTypedConfirm="LOAD"
      />
    </div>
  );
}

/** Sticky summary of what's being loaded — visible on every step after Upload. */
function ContextHeader({
  pkgName,
  fileName,
  fileSize,
  typeCount,
  selectedCount,
  step,
}: {
  pkgName: string;
  fileName: string | null;
  fileSize: number | null;
  typeCount: number;
  selectedCount: number;
  step: number;
}) {
  const sizeText = formatBytes(fileSize);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-muted/30 px-4 py-3">
      <span className="flex items-center gap-2 text-sm font-medium">
        <FileSpreadsheet className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="truncate">{pkgName || "Untitled package"}</span>
      </span>
      {fileName && (
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">{fileName}</span>
          {sizeText && <span className="shrink-0 font-mono">· {sizeText}</span>}
        </span>
      )}
      <div className="ml-auto flex items-center gap-2">
        {typeCount > 0 && (
          <Badge variant="secondary" className="text-[11px]">
            {typeCount} object type{typeCount === 1 ? "" : "s"}
          </Badge>
        )}
        {step >= 2 && selectedCount > 0 && (
          <Badge className="text-[11px]">{selectedCount} selected</Badge>
        )}
      </div>
    </div>
  );
}

/** Assistant-enriched, location-pinpointed explanations (used for both our
 * template errors and CMF's validation errors). */
function ExplanationsPanel({
  explanations,
  heading,
}: {
  explanations: ErrorExplanation[];
  heading: string;
}) {
  if (!explanations || explanations.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-primary/25 bg-primary/5">
      <div className="flex items-center gap-2 border-b border-primary/15 px-4 py-2.5 text-sm font-medium text-primary">
        <Lightbulb className="size-4" aria-hidden />
        {heading}
        <span className="font-normal text-muted-foreground">— assistant guidance</span>
      </div>
      <ul className="divide-y divide-primary/10">
        {explanations.map((ex, i) => (
          <li key={i} className="flex flex-col gap-1.5 px-4 py-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="font-mono">
                {ex.objectType}
                {ex.row != null ? ` · row ${ex.row}` : ""}
                {ex.column ? ` · ${ex.column}` : ""}
              </Badge>
              <span className="font-medium text-foreground">{ex.problem}</span>
            </div>
            {(ex.expected || ex.found) && (
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px]">
                {ex.expected && (
                  <span className="text-emerald-700 dark:text-emerald-400">Expected: {ex.expected}</span>
                )}
                {ex.found && <span className="text-destructive">Found: {ex.found}</span>}
              </div>
            )}
            <p className="text-muted-foreground">{ex.why}</p>
            {ex.steps && ex.steps.length > 0 ? (
              <div className="text-foreground">
                <span className="font-medium">How to fix:</span>
                <ol className="ml-4 mt-0.5 list-decimal text-muted-foreground marker:text-muted-foreground/70">
                  {ex.steps.map((s, j) => (
                    <li key={j} className="py-0.5">{s}</li>
                  ))}
                </ol>
              </div>
            ) : (
              <p className="text-emerald-700 dark:text-emerald-400">
                <span className="font-medium">Fix:</span> {ex.howToFix}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Five animated equalizer bars — the CMF (server-side) running indicator. */
function EqBars() {
  return (
    <span className="validate-eq" role="img" aria-label="working">
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

/**
 * A compact pass / running / fail row for one of the two validation stages.
 * `runKind` picks a distinct running animation: "slide" (indeterminate bar,
 * for the local template check) or "eq" (equalizer bars, for CMF's dry-run).
 */
function CheckRow({
  label,
  state,
  okText,
  runningText,
  failText,
  skippedText = "Skipped — not run.",
  trailing,
  runKind = "slide",
}: {
  label: string;
  state: "pending" | "running" | "ok" | "fail" | "skipped";
  okText: string;
  runningText: string;
  failText: string;
  skippedText?: string;
  trailing?: React.ReactNode;
  runKind?: "slide" | "eq";
}) {
  const running = state === "running";
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="flex size-5 shrink-0 items-center justify-center">
          {state === "ok" && <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" aria-hidden />}
          {state === "fail" && <XCircle className="size-5 text-destructive" aria-hidden />}
          {state === "skipped" && <MinusCircle className="size-5 text-muted-foreground" aria-hidden />}
          {running && runKind === "eq" && <EqBars />}
          {running && runKind === "slide" && <Spinner className="size-5 text-primary" />}
          {state === "pending" && (
            <span className="block size-5 rounded-full border-2 border-dashed border-muted-foreground/40" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{label}</p>
          <p
            className={cn(
              "text-xs",
              state === "ok" && "text-emerald-700 dark:text-emerald-400",
              state === "fail" && "text-destructive",
              (running || state === "pending" || state === "skipped") && "text-muted-foreground",
            )}
          >
            {state === "ok" && okText}
            {state === "fail" && failText}
            {state === "skipped" && skippedText}
            {running && runningText}
            {state === "pending" && "Waiting…"}
          </p>
        </div>
        {trailing && <div className="shrink-0">{trailing}</div>}
      </div>
      {running && runKind === "slide" && (
        <div className="validate-track ml-8" aria-hidden>
          <span />
        </div>
      )}
    </div>
  );
}

function ValidateStep({
  loading,
  data,
  onRerun,
  onNext,
  nextBusy,
  registering,
  cmfValidating,
  cmfErrors,
  cmfExplanations,
  cmfTimedOut,
  onCheckAgain,
  skipTemplate,
  onToggleSkip,
  skipToggleLocked,
  validationStarted,
  onStart,
}: {
  loading: boolean;
  data: ValidationData | null;
  onRerun: () => void;
  onNext: () => void;
  nextBusy: boolean;
  registering: boolean;
  cmfValidating: boolean;
  cmfErrors: { name: string; message: string }[] | null;
  cmfExplanations: ErrorExplanation[];
  cmfTimedOut: boolean;
  onCheckAgain: () => void;
  skipTemplate: boolean;
  onToggleSkip: (v: boolean) => void;
  skipToggleLocked: boolean;
  validationStarted: boolean;
  onStart: () => void;
}) {
  // --- Derived validation state (single source of truth for the gate). ---
  const templateOk = !!data?.ok;
  // When the template check is skipped its errors are ignored entirely; only
  // CMF's compulsory dry-run gates the load.
  const hasTemplateErrors = !skipTemplate && !!data && !data.ok;
  const hasCmfErrors = !!(cmfErrors && cmfErrors.length > 0);
  const hasAnyError = hasTemplateErrors || hasCmfErrors;
  const busy = loading || nextBusy || cmfValidating || registering;
  // The template gate passes when the check passed OR the user skipped it.
  const templateGateOk = skipTemplate || templateOk;
  // Continue is allowed only when the (optional) template gate is satisfied, CMF
  // has no errors, and nothing is in flight.
  const canContinue = templateGateOk && !hasAnyError && !busy;

  const cmfActive = cmfValidating || registering;
  const elapsed = useElapsed(cmfActive);

  const templateState: "pending" | "running" | "ok" | "fail" | "skipped" = skipTemplate
    ? "skipped"
    : loading
      ? "running"
      : !data
        ? "pending"
        : data.ok
          ? "ok"
          : "fail";
  const cmfState: "pending" | "running" | "ok" | "fail" = !templateGateOk
    ? "pending"
    : cmfActive
      ? "running"
      : hasCmfErrors
        ? "fail"
        : "pending";

  const warningCount = data?.warningCount ?? 0;
  const blockedReason = hasTemplateErrors
    ? "Fix the template errors below, then re-validate."
    : hasCmfErrors
      ? "CMF rejected the file — fix it and re-upload, then validate again."
      : cmfTimedOut
        ? "CMF didn't respond in time — it may still be running. Click “Check again”."
        : busy
          ? "Validation is still running…"
          : templateOk && warningCount > 0 && !hasCmfErrors
            ? `Pre-flight passed with ${warningCount} warning${warningCount === 1 ? "" : "s"} — worth a glance above; CMF validation continues automatically.`
            : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-heading text-base font-medium">Validation</h2>
          <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
            A local mandatory-field check (every object&apos;s required <span className="font-mono">Name</span>) —
            optional — then CMF&apos;s own dry-run validation, which is always required. The load is
            gated on CMF passing.
          </p>
        </div>
        {!validationStarted ? (
          <Button size="sm" onClick={onStart}>
            <ShieldCheck data-icon="inline-start" aria-hidden />
            Start validation
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={onRerun} disabled={loading || nextBusy || skipTemplate}>
            {loading ? <Spinner data-icon="inline-start" /> : <ShieldCheck data-icon="inline-start" aria-hidden />}
            {loading ? "Validating…" : "Re-validate"}
          </Button>
        )}
      </div>

      {/* Skip the (optional) local template check. CMF's dry-run below is never
          skippable, so a file is never loaded unverified. */}
      <label
        htmlFor="skip-template-check"
        className={cn(
          "flex items-start gap-2.5 rounded-lg border border-border bg-muted/20 px-3 py-2.5",
          skipToggleLocked ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        )}
      >
        <Checkbox
          id="skip-template-check"
          checked={skipTemplate}
          onCheckedChange={(v) => onToggleSkip(v === true)}
          disabled={skipToggleLocked}
          className="mt-0.5"
        />
        <span className="flex flex-col gap-0.5 text-xs">
          <span className="text-sm font-medium">Skip the mandatory-field check</span>
          <span className="text-muted-foreground">
            Bypass the local mandatory-field (Name) check and go straight to CMF&apos;s validation.
            CMF&apos;s dry-run still runs and must pass — nothing is loaded unverified.
          </span>
        </span>
      </label>

      {/* Two-stage check summary */}
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background">
        <CheckRow
          label="1 · Mandatory fields (Name)"
          state={templateState}
          runKind="slide"
          runningText="Checking mandatory Name fields…"
          okText="All required Name fields are filled."
          failText={
            data
              ? `${data.errorCount} error${data.errorCount === 1 ? "" : "s"} found — see details below.`
              : "Template errors found."
          }
        />
        <CheckRow
          label="2 · CMF validation (dry-run, no write)"
          state={cmfState}
          runKind="eq"
          runningText={registering ? "Registering the package in CMF…" : "CMF is validating the rows…"}
          okText="CMF accepted the file."
          failText={
            cmfErrors
              ? `${cmfErrors.length} error${cmfErrors.length === 1 ? "" : "s"} reported by CMF.`
              : "CMF reported errors."
          }
          trailing={
            cmfActive ? (
              <span className="font-mono text-xs tabular-nums text-muted-foreground">{fmtClock(elapsed)}</span>
            ) : cmfTimedOut ? (
              <Button variant="outline" size="sm" onClick={onCheckAgain}>
                <RotateCw data-icon="inline-start" aria-hidden /> Check again
              </Button>
            ) : undefined
          }
        />
      </div>

      {!validationStarted && (
        <p className="text-xs text-muted-foreground">
          Click <span className="font-medium text-foreground">Start validation</span> to begin.
          {skipTemplate
            ? " The template check is skipped; CMF's dry-run will run — this needs the corporate VPN."
            : " Both checks will run — the CMF step needs the corporate VPN."}
        </p>
      )}

      {loading && <Skeleton className="h-20 w-full" />}

      {validationStarted && !loading && (data || skipTemplate) && (
        <>
          {hasTemplateErrors && (
            <ExplanationsPanel explanations={data?.explanations ?? []} heading="How to fix these errors" />
          )}

          {!skipTemplate && data && Object.entries(data.errorsByType).map(([type, errs]) => {
            const errorCount = errs.filter((e) => e.severity === "error").length;
            const warnCount = errs.filter((e) => e.severity === "warning").length;
            const infoCount = errs.filter((e) => e.severity === "info").length;
            const sorted = [...errs].sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
            return (
              <div key={type} className="overflow-hidden rounded-lg border border-border">
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-sm font-medium">
                  {type}
                  {errorCount > 0 && (
                    <Badge variant="destructive">{errorCount} error{errorCount === 1 ? "" : "s"}</Badge>
                  )}
                  {warnCount > 0 && (
                    <Badge className="bg-amber-100 text-amber-900 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-200">
                      {warnCount} warning{warnCount === 1 ? "" : "s"}
                    </Badge>
                  )}
                  {infoCount > 0 && (
                    <Badge className="bg-emerald-100 text-emerald-900 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-200">
                      {infoCount} note{infoCount === 1 ? "" : "s"}
                    </Badge>
                  )}
                </div>
                <ul className="divide-y divide-border text-xs">
                  {sorted.slice(0, 100).map((e, i) => (
                    <li key={i} className="flex gap-3 px-3 py-1.5">
                      <span className="shrink-0 font-mono text-muted-foreground">
                        {e.row != null ? `row ${e.row}` : "sheet"}
                        {e.column ? ` · ${e.column}` : ""}
                      </span>
                      <span className={sevClass(e.severity)}>{e.message}</span>
                    </li>
                  ))}
                  {sorted.length > 100 && (
                    <li className="px-3 py-1.5 text-muted-foreground">… +{sorted.length - 100} more</li>
                  )}
                </ul>
              </div>
            );
          })}

          {templateGateOk && cmfExplanations.length > 0 && (
            <ExplanationsPanel explanations={cmfExplanations} heading="How to fix the CMF error" />
          )}

          {hasCmfErrors && (
            <Alert variant="destructive">
              <XCircle aria-hidden />
              <AlertTitle>
                CMF validation failed — {cmfErrors!.length} error{cmfErrors!.length === 1 ? "" : "s"}
              </AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                <ul className="flex flex-col gap-1.5 text-xs">
                  {cmfErrors!.map((e, i) => (
                    <li key={i}>
                      <span className="font-mono font-medium text-destructive">{e.name}</span>
                      <span className="ml-2 text-foreground">{e.message}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-[11px]">
                  CMF validates one type at a time and stops at the first failure — fix this in the file
                  and re-upload, then validate again. (More may surface after this is resolved.)
                </p>
              </AlertDescription>
            </Alert>
          )}

          <Separator />

          <div className="flex flex-wrap items-center justify-end gap-3">
            {blockedReason && (
              <p className="mr-auto text-xs text-muted-foreground">{blockedReason}</p>
            )}
            <Button disabled={!canContinue} onClick={onNext}>
              {busy && <Spinner data-icon="inline-start" />}
              {cmfValidating
                ? "Validating in CMF…"
                : registering
                  ? "Registering in CMF…"
                  : "Continue to Select"}
              {!busy && <ArrowRight data-icon="inline-end" aria-hidden />}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function UploadStep({
  onStaged,
}: {
  onStaged: (stagingId: string, name: string, fileName: string, fileSize: number) => void;
}) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!file || !name.trim()) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      fd.append("name", name.trim());
      const res = await cmfFetch("/api/cmf/packages/stage", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as {
        stagingId?: string;
        error?: { title?: string; description?: string; errorId?: string };
      };
      if (!res.ok || !data.stagingId) {
        toast.error(data.error?.title ?? "Upload failed", {
          description: failureText(data, res.status),
        });
        return;
      }
      toast.success("File uploaded — validating against template");
      onStaged(data.stagingId, name.trim(), file.name, file.size);
    } catch (err) {
      toast.error("Upload failed", { description: String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="font-heading text-base font-medium">Upload a package</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Give the package a recognisable name and choose the master-data .xlsx file to load.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="pkg-name">Package name</Label>
        <Input
          id="pkg-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. ENT_MasterData_2026Q2"
          disabled={busy}
        />
        <p className="text-xs text-muted-foreground">
          This is how the package appears in CMF and in Recent.
        </p>
      </div>
      <FileDropZone disabled={busy} onFile={(f) => setFile(f)} onClear={() => setFile(null)} />
      <div className="flex justify-end">
        <Button disabled={busy || !file || !name.trim()} onClick={submit}>
          {busy ? <Spinner data-icon="inline-start" /> : <FileSpreadsheet data-icon="inline-start" aria-hidden />}
          {busy ? "Uploading…" : "Upload & validate"}
        </Button>
      </div>
    </div>
  );
}

function LoadStep({
  busy,
  done,
  result,
  log,
  selected,
  onRequestLoad,
  onReset,
}: {
  busy: boolean;
  done: boolean;
  result: ExecutionResult | undefined;
  log: ExecutionLogEntry[];
  selected: UserFriendlyObjectType[];
  onRequestLoad: () => void;
  onReset: () => void;
}) {
  const failed = log.filter((e) => (e as { State?: number }).State === 3);
  const succeeded = Math.max(0, selected.length - failed.length);
  const success = done && result === 0 && failed.length === 0;

  return (
    <div className="flex flex-col gap-5">
      {!done && (
        <>
          <div>
            <h2 className="font-heading text-base font-medium">Load to MES</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Final step. This writes to the live CMF database.
            </p>
          </div>
          <Alert variant="destructive">
            <Database aria-hidden />
            <AlertTitle>This commits data to production CMF</AlertTitle>
            <AlertDescription>
              {selected.length} object type{selected.length === 1 ? "" : "s"} will be created or updated.
              This action cannot be undone from here — you&apos;ll be asked to confirm.
            </AlertDescription>
          </Alert>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">
              {busy ? "Loading…" : `Ready to load ${selected.length} object type${selected.length === 1 ? "" : "s"}.`}
            </span>
            <Button variant="destructive" disabled={busy} onClick={onRequestLoad}>
              {busy ? <Spinner data-icon="inline-start" /> : <Database data-icon="inline-start" aria-hidden />}
              {busy ? "Loading…" : "Load to MES"}
            </Button>
          </div>
        </>
      )}

      {done && (
        <div
          className={cn(
            "flex flex-col gap-3 rounded-lg border p-5",
            success
              ? "border-emerald-500/30 bg-emerald-500/5"
              : "border-destructive/40 bg-destructive/5",
          )}
        >
          <div className="flex items-center gap-3">
            {success ? (
              <CheckCircle2 className="size-6 text-emerald-600 dark:text-emerald-400" aria-hidden />
            ) : (
              <XCircle className="size-6 text-destructive" aria-hidden />
            )}
            <div>
              <p className="text-sm font-semibold">
                {success ? "Load complete" : "Load finished with errors"}
              </p>
              <p className="text-xs text-muted-foreground">
                {success
                  ? `${succeeded} of ${selected.length} object type${selected.length === 1 ? "" : "s"} written to CMF.`
                  : `${failed.length} of ${selected.length} object type${selected.length === 1 ? "" : "s"} failed — see the log below.`}
              </p>
            </div>
            <div className="ml-auto">
              <ResultBadge result={result} />
            </div>
          </div>
        </div>
      )}

      {/* Only the LOAD's own log — never the earlier CMF dry-run preview, which
          would otherwise show created/updated/skipped counts before any load. */}
      {done && (
        <>
          <Separator />
          <ExecutionLogViewer entries={log} />
        </>
      )}

      {done && (
        <div className="flex justify-end">
          <Button variant="outline" onClick={onReset}>
            <RotateCw data-icon="inline-start" aria-hidden /> Load another package
          </Button>
        </div>
      )}
    </div>
  );
}
