/**
 * WHERE A CONVERSATION'S GENERATED FILES LIVE.
 *
 * The generation core writes a RUN DIRECTORY, not a single file: the page
 * export, each query it consumes, the master-data unit that imports them in
 * dependency order, and three reports. They are produced together and are only
 * meaningful together (F-98), so they are kept together, one directory per
 * conversation.
 *
 * KEYED ON FO'S CONVERSATION ID, which is the change from the standalone app.
 * There, a `sessions` Map in the server process held which directory belonged to
 * which chat — so a restart lost the association even though the files were
 * still on disk, and a second instance behind a load balancer never had it. Here
 * the conversation id IS the directory name, so the association survives both.
 * `state.ts` reads the rest back off disk for the same reason.
 *
 * The root is configurable because the deployment shape is not ours to assume:
 * a container wants a mounted volume, a developer wants something inside the
 * repository they can open.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** Where every run directory is written. */
const RUNS_ROOT: string = process.env["PO_UI_RUNS_DIR"]
  ? resolve(process.env["PO_UI_RUNS_DIR"])
  : resolve(process.cwd(), ".po-ui-runs");

/**
 * A conversation id is a UUID from our own database, but it reaches this module
 * through an HTTP route, and a value that names a directory is never taken on
 * trust: `../` in an id would write outside the runs root.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

class RunPathError extends Error {}

export function runDir(conversationId: string): string {
  if (!SAFE_ID.test(conversationId)) {
    throw new RunPathError(`refusing to build a run path from ${JSON.stringify(conversationId)}`);
  }
  return join(RUNS_ROOT, conversationId);
}

export function ensureRunDir(conversationId: string): string {
  const dir = runDir(conversationId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
