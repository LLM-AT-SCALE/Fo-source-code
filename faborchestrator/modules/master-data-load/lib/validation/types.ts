export type ParsedSheet = {
  /** Object type the sheet maps to (sheet name with any `<XX>` prefix stripped). */
  objectType: string;
  headers: string[];
  /** One object per data row: header -> cell string value. */
  rows: Record<string, string>[];
};

export type Severity = "error" | "warning" | "info";

/**
 * Optional category tag used by the cross-check layer (and surfaced in the UI
 * for grouped messages). Free-form: validators may emit categories not listed
 * here and the UI must fall back to the message text.
 */
type ValidationCategory =
  | "required"
  | "required-summary"
  | "exists"
  | "update"
  | "noop"
  | "dependent-sheet"
  | "parent-fk"
  | "parent-fk-in-cmf"
  // Cross-sheet integrity (PK uniqueness + FK/key consistency across sheets).
  | "pk-duplicate"
  | "cross-sheet-fk";

export type ValidationError = {
  objectType: string;
  /** 1-based data-row number, or null for sheet-level issues. */
  row: number | null;
  column: string | null;
  severity: Severity;
  message: string;
  /** Optional tag for grouping/styling in the UI; never load-bearing. */
  category?: ValidationCategory;
};

export type ValidationResult = {
  ok: boolean;
  errorsByType: Record<string, ValidationError[]>;
  errorCount: number;
  warningCount: number;
  /** Severity=info findings: matches, no-ops, "exists in CMF" notes. Never gates. */
  infoCount: number;
};
