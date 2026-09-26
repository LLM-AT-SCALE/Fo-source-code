/**
 * Shortform → meaning map, so the assistant understands fab shorthand.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS TABLE IS PROVISIONAL. The client is supplying their own alias list; when
 * it arrives, replace the `ALIASES` array below and nothing else. Every consumer
 * reads through the three exported functions, so the shape of an entry is the
 * only contract that matters:
 *
 *     { short: [...what the user types], expands: '...', inData: '...' }
 *
 * Keep `short` in the order you want them displayed — the first entry is used as
 * the label in the glossary handed to the model.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two deliberate design choices, both about not doing harm:
 *
 * 1. Aliases NEVER rewrite the user's text. They only widen what the matcher
 *    understands and add a glossary to the model's context. Rewriting would risk
 *    mangling a lot id or product code somebody typed on purpose.
 * 2. Only the shortforms actually present in a message are injected, so the
 *    context cost is a few lines rather than the whole table.
 *
 * Client-safe: pure data and string work, no DB or server imports.
 */

type AliasEntry = {
  /** Every spelling the user might type. First one is the display label. */
  short: string[];
  /** What it stands for, in words. */
  expands: string;
  /** How it lands in this environment's data. */
  inData: string;
};

// ===========================================================================
// The alias table — replace wholesale when the client's list lands.
// ===========================================================================

const ALIASES: AliasEntry[] = [
  { short: ['MES'], expands: 'Manufacturing Execution System', inData: 'Opcenter SemiDemo, SemiDemoOLTP2504, schema cammes' },
  { short: ['WIP'], expands: 'Work In Progress / Work In Process', inData: 'Active lot count — Container rows' },
  { short: ['CT'], expands: 'Cycle Time', inData: 'Per-step duration from LEAD(TxnDate)' },
  { short: ['TAT'], expands: 'Turnaround Time', inData: 'Same as cycle time' },
  { short: ['OTD'], expands: 'On-Time Delivery', inData: 'Proxy from ExpirationDate' },
  { short: ['PM'], expands: 'Preventive Maintenance', inData: 'Maintenance dashboard' },
  { short: ['UOM'], expands: 'Unit of Measure', inData: 'WAFER, DIE, CHIP, UNIT, PANEL, BAR, BANCHI' },
  { short: ['PN', 'P/N'], expands: 'Part Number', inData: 'ProductName' },
  { short: ['EQP', 'EQ'], expands: 'Equipment', inData: 'ResourceDef.ResourceName' },
  { short: ['OP'], expands: 'Operation / Step', inData: 'SpecName' },
  { short: ['FE', 'FEOL'], expands: 'Front End (of Line)', inData: 'Operation group FE, route Wafer-FrontEnd-Workflow' },
  { short: ['BE', 'EOL'], expands: 'Back End / End of Line', inData: 'Operation group BE, route Chip-Back-EndWorkFlow' },
  { short: ['FOL'], expands: 'Front of Line', inData: 'Operation group FOL' },
  { short: ['IQC'], expands: 'Incoming Quality Control', inData: 'Wafer Incoming Inspection 001' },
  { short: ['QA'], expands: 'Quality Assurance', inData: 'Shipping QA_' },
  { short: ['MOCVD', 'MO-CVD'], expands: 'Metal-Organic Chemical Vapour Deposition', inData: 'EA MQW epi_MO-CVD' },
  { short: ['PL'], expands: 'Photoluminescence', inData: 'EA MQW epi_PL' },
  { short: ['XRD'], expands: 'X-Ray Diffraction', inData: 'EA MQW epi_XRD' },
  { short: ['SEM'], expands: 'Scanning Electron Microscope', inData: 'EA MQW epi_SEM' },
  { short: ['AFM'], expands: 'Atomic Force Microscope', inData: 'SI-regrowth_AFM' },
  { short: ['DIC'], expands: 'Differential Interference Contrast microscope', inData: 'EA MQW epi_DIC Microscope' },
  { short: ['ICP'], expands: 'Inductively Coupled Plasma dry etch', inData: 'Mesa etch_ICP dry' },
  { short: ['UVO3'], expands: 'UV-Ozone treatment', inData: 'Mesa etch_UVO3' },
  { short: ['CVD', 'T-CVD'], expands: 'Thermal Chemical Vapour Deposition', inData: 'T-CVD for BJ1 Photo' },
  { short: ['BGD'], expands: 'Back Grind', inData: 'BGD001–BGD010' },
  { short: ['DAT'], expands: 'Die Attach', inData: 'DAT001–DAT010' },
  { short: ['BRN'], expands: 'Burn-In', inData: 'BRN001–BRN010' },
  { short: ['MNT'], expands: 'Wafer Mount', inData: 'MNT001–MNT010' },
  { short: ['WBD'], expands: 'Wire Bonding', inData: 'WBD* equipment' },
  { short: ['TGV'], expands: 'Through-Glass Via', inData: 'TGV001, HL13B5-TGV' },
  { short: ['NG'], expands: 'No Good (reject)', inData: 'Back-end NG, Banchi NG' },
  { short: ['CMF'], expands: 'Critical Manufacturing', inData: '10.10.1.145 — NOT the source of these dashboards' },
];

// ===========================================================================
// Matching
// ===========================================================================

/**
 * Shortforms whose lowercase form is an ordinary English word or a common
 * non-fab abbreviation. These match only when the user wrote them in capitals,
 * so "be", "op" and "3 pm" in a normal sentence do not trigger a fab reading.
 * Everything else matches case-insensitively.
 */
const CASE_SENSITIVE = new Set(['BE', 'OP', 'PM', 'PN', 'EQ', 'CT', 'QA', 'NG', 'PL']);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

type Compiled = { entry: AliasEntry; re: RegExp };

/** Built once at module load; the table is static. */
const COMPILED: Compiled[] = ALIASES.flatMap((entry) =>
  entry.short.map((s) => ({
    entry,
    // Hyphen and slash count as part of a token, not as boundaries — otherwise
    // "CVD" matches inside "MO-CVD" and "N" inside "P/N", and one shortform
    // silently reports another.
    re: new RegExp(
      `(?<![A-Za-z0-9/-])${escape(s)}(?![A-Za-z0-9/-])`,
      CASE_SENSITIVE.has(s) ? '' : 'i',
    ),
  })),
);

/** Which shortforms this message actually uses, in table order, deduplicated. */
function findAliases(text: string): AliasEntry[] {
  if (!text) return [];
  const hit = new Set<AliasEntry>();
  for (const c of COMPILED) if (c.re.test(text)) hit.add(c.entry);
  return ALIASES.filter((e) => hit.has(e));
}

/**
 * NOTE: aliases deliberately do NOT feed the dashboard matcher.
 *
 * An earlier version added each shortform's expansion to the matcher's
 * vocabulary. It backfired: "Which EQP has PM scheduled in the next two weeks?"
 * picked up "equipment" and "maintenance" — the Maintenance deck prompt's own
 * words — and produced a dashboard for what was a plain question. Only the seven
 * prompts, and edits of them, may produce a dashboard. Aliases explain shorthand
 * to the model; they never decide routing.
 */

/**
 * A compact glossary for the model, covering only the shortforms in this
 * message. Empty string when the user used none, so nothing is spent.
 */
export function glossaryBlock(text: string): string {
  const used = findAliases(text);
  if (!used.length) return '';
  return [
    '<glossary>',
    "The user's wording uses the shorthand below. Read it as the expansion, and answer in",
    'their terms — do not lecture them on what the abbreviation means.',
    ...used.map((e) => `- ${e.short[0]} = ${e.expands} → ${e.inData}`),
    '</glossary>',
  ].join('\n');
}
