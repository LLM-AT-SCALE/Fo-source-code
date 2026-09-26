/**
 * THE BACK-END AGENT'S TOOLS.
 *
 * Four of them, and the division of labour between them and the model is the
 * whole design: the MODEL reads the requirement document, asks what it does not
 * know and writes the specification; OUR CODE turns that specification into CMF
 * artifacts deterministically — `$id` numbering, XML escaping, the envelope, the
 * queries, the master-data unit — and then validates the result. The model never
 * writes XML.
 *
 * The descriptions below are load-bearing and are carried over from the
 * standalone app verbatim. Each paragraph is there because something went wrong
 * without it: `revise_page` attempting query changes it structurally cannot
 * make, `write_prd` inventing a requirement from the sample artifacts when no
 * document was attached. They are covered by the prompt-contract gates in the
 * standalone repository; changing them here without changing those is how the
 * two would drift.
 *
 * WHAT CHANGED IN THE MOVE
 *   Only the plumbing. The standalone app spoke the raw Anthropic tool protocol
 *   and kept state in a `sessions` Map; here the tools are declared in the AI
 *   SDK's shape, like every other agent in this application, and state is read
 *   off disk by `state.ts`. The pipeline calls underneath are identical.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

import type { PipelineConfig } from "@/lib/po-ui/generate/config";
import { run, runModify, runPrd } from "@/lib/po-ui/generate/pipeline";
import { SpecDescriptorSchema, parseDescriptor, type SpecDescriptor } from "@/lib/po-ui/descriptor";
import { ensureRunDir } from "./runs";
import { readState, specIsNewerThanArtifact } from "./state";
import { recordBackendAudit } from "./audit";

export interface AgentContext {
  conversationId: string;
  /** who is running this, for the audit trail */
  userId?: string;
  /** their address, for the audit trail */
  ip?: string | null;
  cfg: PipelineConfig;
  client: Anthropic;
  /** progress lines, surfaced to the engineer while a long step runs */
  onProgress?: (line: string) => void;
  /**
   * The page definition as the model writes it.
   *
   * A generation runs for minutes. Watching the artifact build is the clearest
   * evidence it is working, and it is what the standalone app showed.
   */
  onCode?: (page: string, delta: string, attempt: number) => void;
  /** a finished file, once it is on disk */
  onFile?: (name: string, content: string) => void;
  /**
   * Client evidence that is NOT installed on this machine, one sentence each
   * (see `evidence.ts`). Generation runs without it — from the stock baseline,
   * with named queries reported as gaps — and both the engineer and the model
   * are told so, rather than the run failing deep inside the pipeline or the
   * result being presented as if it had the client's pages behind it.
   */
  evidenceNotices?: readonly string[];
}

/** A tool result is text the MODEL reads; it is not shown to the engineer as-is. */
const say = (text: string): string => text;

export function buildBackendAgentTools(ctx: AgentContext): ToolSet {
  const log = (line: string): void => ctx.onProgress?.(line);

  return {
    write_prd: tool({
      description:
        "Write the PRD — the brainstorming document the engineer reads BEFORE anything " +
        "is built. It restates the requirement document so it can be argued with: what " +
        "the screen should do, a rough outline of what it should look like, and the list " +
        "of backend customization needed. Call this FIRST, as soon as you have read a " +
        "requirement document and resolved the blocking unknowns — before generate_artifact. " +
        "Call it again with `feedback` when the engineer reacts to a draft. You supply the " +
        "descriptor; our code derives every table and the backend list from it.\n\n" +

        "ALSO CALL IT AFTER GENERATION when the engineer asks for something " +
        "`revise_page` cannot reach: a query added, dropped or renamed, a query " +
        "parameter made optional or mandatory, a change to which artifacts are in " +
        "the deployment unit, or another page. Those are specification changes, " +
        "not page edits. Revise the descriptor here and generate again, so the " +
        "page, the queries and the unit are rebuilt from one consistent spec.",
      inputSchema: z.object({
        descriptor: SpecDescriptorSchema,
        feedback: z.string().optional()
          .describe("What the engineer said about the previous draft. Omit on the first call."),
      }),
      execute: async ({ descriptor, feedback }) => {
        const state = readState(ctx.conversationId);

        /*
         * NO REQUIREMENT DOCUMENT, NO PRD.
         *
         * Observed in use: asked to "load the sample user story and write the
         * PRD" with nothing attached, the model reconstructed a story from the
         * delivered artifacts in its own samples block and wrote a PRD from
         * that. It said so, which is the honest behaviour — but a PRD is the
         * document the engineer agrees the scope against, and one derived from
         * artifacts states a scope nobody asked for wearing the costume of one
         * they did.
         */
        if (!state.storyText) {
          return say(
            "There is no requirement document in this conversation, so there is " +
            "nothing to write a PRD from. Do NOT reconstruct one from the sample " +
            "artifacts in your context: those are reference material, and a PRD " +
            "built from them would state a scope nobody asked for. Ask the " +
            "engineer to attach the requirement document.");
        }

        const dir = ensureRunDir(ctx.conversationId);
        const startedAt = Date.now();
        log("drafting the PRD");
        const r = await runPrd({
          cfg: ctx.cfg,
          client: ctx.client,
          descriptor: descriptor as SpecDescriptor,
          // The narrative is written from the requirement document, not from the
          // descriptor — the descriptor deliberately strips the intent out.
          story: state.storyText,
          outDir: dir,
          sourceName: state.storyName ?? "the requirement document",
          ...(feedback ? { feedback } : {}),
          log,
        });

        /* THE PRD IS NOT REPORTED AS A FILE.
           It was, briefly, so that the PRD step left something in the transcript
           the way generation does. But the PRD is a DOCUMENT, not a deployable
           artifact: it opens in the panel beside the conversation, it is
           downloaded as Word, and it is not part of the deployment unit. Listing
           `PRD.md` among the generated files put a specification in a list of
           things that get imported into CMF, which is the one place it must
           never appear. The panel is where the PRD lives. */

        /* One row PER DRAFT. Five rows means the specification was argued
           with five times, which is a fact about the requirement document worth
           being able to see afterwards. */
        void recordBackendAudit("PRD", {
          userId: ctx.userId ?? null,
          conversationId: ctx.conversationId,
          ip: ctx.ip ?? null,
          metadata: {
            document: state.storyName ?? null,
            pages: r.descriptor.pages.map((p) => p.name),
            revised: Boolean(feedback),
            durationMs: Date.now() - startedAt,
          },
        });

        const stale = specIsNewerThanArtifact(readState(ctx.conversationId));
        return say(
          "The PRD is written and is on screen for the engineer to read.\n\n" +
          `Page: ${r.descriptor.pages.map((p) => p.name).join(", ")}\n\n` +
          "Summarise what it says and what it left open, and ask them to confirm " +
          "or tell you what to change. Do not restate the whole document." +
          (stale
            ? "\n\nNOTE: a page was already generated in this conversation and the " +
              "specification has now moved past it. Say plainly that the artifact " +
              "on disk no longer matches, and that it needs regenerating."
            : ""));
      },
    }),

    revise_page: tool({
      description:
        "Edit the PAGE FILE of an already-generated artifact. It applies a " +
        "targeted change and leaves everything else byte-identical, so nothing " +
        "the engineer was happy with moves. Pass their words as `request`.\n\n" +

        "IT EDITS THE PAGE AND NOTHING ELSE. It cannot add, remove or alter a " +
        "query; it cannot change a query parameter (including whether a " +
        "parameter is optional or mandatory); it cannot change the master data; " +
        "and it cannot change which artifacts are in the deployment unit. Those " +
        "live in other files that this tool never opens.\n\n" +

        "So decide FIRST what kind of change was asked for:\n" +
        "- It changes how the page LOOKS or is WIRED INTERNALLY — move a widget, " +
        "rename a caption, reorder or retype a column, change selection mode, " +
        "add or remove a link between things already on the page. Use this tool.\n" +
        "- It changes WHAT GETS BUILT — a query added, dropped or renamed, a " +
        "query parameter made optional, an artifact added to or removed from the " +
        "unit, a new page. Call `write_prd` with their words as `feedback` " +
        "instead, then `generate_artifact`. That regenerates the page, the " +
        "queries and the unit together and consistently.\n\n" +

        "If a request mixes the two, it is the second kind: take the whole thing " +
        "back to `write_prd`. Doing the page half here would leave a page wired " +
        "to queries that were never changed, and a unit still shipping an " +
        "artifact nobody asked for — and you would not find out from the " +
        "validation count, because a revision does not run the specification " +
        "checks at all (see the tool result).\n\n" +

        "Say which of the two it is before you call anything. If it is the second " +
        "kind, say so plainly rather than attempting a partial change.",
      inputSchema: z.object({
        request: z.string().describe(
          "What the engineer wants changed, in their own words. Be faithful " +
          "to what they asked; do not expand it. If what they asked for " +
          "includes anything outside the page file — a query, a query " +
          "parameter, the contents of the deployment unit — do not call this " +
          "tool at all; call `write_prd` with their words as `feedback`."),
      }),
      execute: async ({ request }) => {
        const state = readState(ctx.conversationId);
        if (!state.primary) {
          return say("There is no generated page to revise yet — call generate_artifact first.");
        }
        const startedAt = Date.now();
        log(`revising ${state.primary.name}`);
        const r = await runModify({
          cfg: ctx.cfg,
          client: ctx.client,
          sourcePath: state.primary.xmlPath,
          pageName: state.primary.name,
          changeRequest: request,
          /* The edit is written back over the page it edited, which is what makes
             it an edit rather than a second artifact. */
          outDir: state.primary.dir,
          objectId: String(Date.now()).padEnd(19, "0").slice(0, 19),
          log,
        });

        void recordBackendAudit("REVISE", {
          userId: ctx.userId ?? null,
          conversationId: ctx.conversationId,
          ip: ctx.ip ?? null,
          metadata: {
            page: state.primary.name,
            request,
            changes: r.changes.map((c) => `${c.op} ${c.target}`),
            unknowns: r.unknowns,
            unexpected: r.unexpected,
            pass: r.report.counts.PASS,
            warn: r.report.counts.WARN,
            fail: r.report.counts.FAIL,
            durationMs: Date.now() - startedAt,
          },
        });

        const applied = r.changes.length
          ? r.changes.map((c) => `- ${c.op} ${c.target}`).join("\n")
          : "- (the edit produced no change to the file)";

        /*
         * `$(UNKNOWN_*)` captions this edit introduced, surfaced rather than left
         * to the model's own summary. A revision once emitted `$(UNKNOWN_SN)` and
         * reported that it had written plain text and that plain text was fine —
         * two false claims in one sentence, either of which would have sent the
         * page to import with a message still uncreated.
         */
        const unknowns = r.unknowns.length
          ? `\n\nUNRESOLVED CAPTION(S): ${r.unknowns.join(", ")} — say so plainly; ` +
            "each renders as a raw key until a real message name is supplied."
          : "";
        const unexpected = r.unexpected.length
          ? `\n\nUNEXPECTED CHANGES (nothing claimed these): ${r.unexpected.join(", ")} — ` +
            "report them; they mean the edit moved something nobody asked for."
          : "";

        const c = r.report.counts;
        return say(
          `The page was edited and is on screen.\n\n${applied}\n\n` +
          `Re-checked: ${c.PASS} passed, ${c.WARN} warnings, ${c.FAIL} failed.` +
          unknowns + unexpected + "\n\n" +
          "That figure is NOT comparable to a generation: a revision re-checks the " +
          "FILE, not the specification, so do not present it as if the page had " +
          "been re-validated against the requirement.");
      },
    }),

    generate_artifact: tool({
      description:
        "Build the CMF UI Page export from a completed spec descriptor. Call this " +
        "once you have enough to build a correct page. Our code applies $id " +
        "numbering, XML escaping and the envelope, then validates the result — you " +
        "do not do any of that. Returns the validation outcome and anything the " +
        "generator could not resolve.",
      inputSchema: SpecDescriptorSchema,
      execute: async (descriptor) => {
        const spec = parseDescriptor(descriptor, "<tool input>");
        const root = ensureRunDir(ctx.conversationId);
        const startedAt = Date.now();

        /* Said BEFORE the run, where the engineer is watching, not buried in a
           gap report afterwards. */
        const notices = ctx.evidenceNotices ?? [];
        for (const n of notices) log(n);

        /* Distinct per page: two artifacts sharing a CMF object id is a broken
           deployment unit. The index keeps them apart within one millisecond. */
        const stamp = String(Date.now());
        const results = await Promise.allSettled(spec.pages.map((page, i) => {
          const dir = join(root, page.name);
          mkdirSync(dir, { recursive: true });
          return run({
            cfg: ctx.cfg,
            client: ctx.client,
            descriptor: spec,
            pageName: page.name,
            outDir: dir,
            objectId: (stamp + String(i)).padEnd(19, "0").slice(0, 19),
            log: (line) => log(`[${page.name}] ${line}`),
            /* Tagged by page: pages build CONCURRENTLY, so without the tag two
               artifacts would stream into one box interleaved. */
            ...(ctx.onCode
              ? { onCode: (delta: string, attempt: number) => ctx.onCode!(page.name, delta, attempt) }
              : {}),
            ...(ctx.onFile ? { onFile: ctx.onFile } : {}),
          });
        }));

        const built = results.flatMap((r, i) =>
          r.status === "fulfilled" ? [{ page: spec.pages[i]!.name, r: r.value }] : []);
        const failed = results.flatMap((r, i) =>
          r.status === "rejected"
            ? [{ page: spec.pages[i]!.name, why: String((r as PromiseRejectedResult).reason) }]
            : []);

        /* THE VALIDATOR'S VERDICT, WRITTEN BESIDE THE PAGE IT JUDGED.
           The panel shows PASS/WARN/FAIL beside the artifact, and everything else
           this app knows about a run it reads back off disk — so a verdict held
           only in this closure would vanish on the next request and leave the
           badge blank on a reopened conversation. Same source as the sentence the
           model reports, so the two can never disagree. */
        for (const { page, r } of built) {
          try {
            writeFileSync(
              join(root, page, "verdict.json"),
              JSON.stringify(r.report.counts),
              "utf-8",
            );
          } catch {
            /* the verdict is a label on work that already succeeded; failing to
               record it must never fail the generation that produced it */
          }
        }

        // One page failing must not discard the pages that succeeded.
        if (built.length === 0) {
          return say(
            "Generation failed for every page.\n" +
            failed.map((f) => `- ${f.page}: ${f.why}`).join("\n") +
            "\nTell the engineer plainly; do not retry blindly.");
        }

        void recordBackendAudit("GENERATE", {
          userId: ctx.userId ?? null,
          conversationId: ctx.conversationId,
          ip: ctx.ip ?? null,
          metadata: {
            durationMs: Date.now() - startedAt,
            /* The validation counts are the claim this tool makes about its own
               output. A claim nobody can audit later is worth very little. */
            pages: built.map(({ page, r }) => ({
              page,
              attempts: r.attempts,
              pass: r.report.counts.PASS,
              warn: r.report.counts.WARN,
              fail: r.report.counts.FAIL,
              queries: r.queries.map((q) => ({ name: q.name, built: q.built })),
            })),
            failed: failed.map((f) => ({ page: f.page, why: f.why })),
          },
        });

        const lines = built.map(({ page, r }) => {
          const c = r.report.counts;
          return `- ${page}: ${c.PASS} passed, ${c.WARN} warnings, ${c.FAIL} failed`;
        });
        const trouble = failed.length
          ? `\n\nNOT BUILT: ${failed.map((f) => `${f.page} (${f.why})`).join("; ")}`
          : "";
        /* The model must not present a baseline-only page as one built from the
           client's delivered pages. It is told exactly what was absent. */
        const degraded = notices.length
          ? "\n\nCLIENT EVIDENCE NOT INSTALLED ON THIS SERVER — tell the engineer this " +
            "plainly, in these terms, before the validation outcome:\n" +
            notices.map((n) => `- ${n}`).join("\n")
          : "";

        return say(
          `The deployment unit is built and on screen.\n\n${lines.join("\n")}${trouble}${degraded}\n\n` +
          "Report the validation outcome honestly — a warning is a warning, not a " +
          "pass. Name anything the generator could not resolve, and say what would " +
          "close it. The unit is available to download.");
      },
    }),

    show_preview: tool({
      description:
        "Show the engineer the screen, rendered the way the CMF client renders it. " +
        "Call this whenever they ask to see, render or preview the page. " +
        "It does NOT require a generated artifact: once a PRD exists the screen is " +
        "drawn from the requirement itself, so use it to show the layout while the " +
        "PRD is still being discussed, and again after the page is generated. " +
        "Never call generate_artifact merely to satisfy a request to see the screen.",
      inputSchema: z.object({}),
      execute: async () => {
        const state = readState(ctx.conversationId);
        const hasArtifact = Boolean(state.primary);
        const specNewer = specIsNewerThanArtifact(state);
        const fromArtifact = hasArtifact && !specNewer;

        if (!hasArtifact && !state.descriptorPath) {
          return say(
            "There is nothing to draw yet — no requirement has been turned into a " +
            "specification. Ask the engineer to attach the requirement document.");
        }
        if (fromArtifact) {
          return say(
            "The mock screen is now displayed to the engineer, rendered from the generated page.");
        }
        /* Two different situations reach here, and telling them apart matters:
           nothing has been built yet, or something has and the specification has
           since moved past it. Saying "no code has been generated" in the second
           case would be false. */
        return say(hasArtifact
          ? "The mock screen is now displayed, rendered FROM THE UPDATED REQUIREMENT — the " +
            "specification has changed since the page was generated, so this shows what the " +
            "PRD now describes, NOT the artifact on disk. Say so plainly, and that the page " +
            "has to be regenerated for the artifact to match."
          : "The mock screen is now displayed, rendered FROM THE REQUIREMENT — no code has " +
            "been generated. Tell them it shows the structure the PRD describes, and that " +
            "it will update as they change the PRD.");
      },
    }),
  };
}

/** Store the attached requirement document beside the run it will produce. */
export function saveStory(conversationId: string, text: string, name: string): void {
  const dir = ensureRunDir(conversationId);
  writeFileSync(join(dir, "story.txt"), text, "utf-8");
  writeFileSync(join(dir, "story-name.txt"), name, "utf-8");
}
