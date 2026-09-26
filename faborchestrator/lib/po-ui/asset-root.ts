/**
 * WHERE THE PIPELINE'S DATA LIVES.
 *
 * The generation core is data-driven: prompts, skeletons, the harvested CMF
 * dictionary, the sample pages and the delivered `.xml` exports all sit on disk
 * under `po-ui-assets/`. Every one of those paths resolves against this root.
 *
 * WHY IT IS NOT `import.meta.dirname`
 *   The standalone app resolved paths from each module's own location, which is
 *   exact when Node executes the TypeScript directly. Next.js bundles server
 *   code, so at runtime a module's location is a build artifact inside `.next/`
 *   and every asset path would resolve to nothing. The failure would not be a
 *   clean "asset missing" either — it surfaces deep inside a generation, minutes
 *   in, as a confusing error about a prompt section.
 *
 * WHY IT IS ITS OWN MODULE
 *   `descriptor.ts` states that it must not depend on a platform module, so that
 *   its target-neutrality is real rather than nominal, and `generate/config.ts`
 *   needs the same root. A leaf both can import keeps that promise without
 *   duplicating the rule in two places where they could quietly diverge.
 *
 * `PO_UI_ASSETS_DIR` overrides it — a container image that mounts the assets
 * somewhere other than the working directory needs exactly that.
 */
import { resolve } from "node:path";

export const ASSET_ROOT: string = process.env["PO_UI_ASSETS_DIR"]
  ? resolve(process.env["PO_UI_ASSETS_DIR"])
  : resolve(process.cwd(), "po-ui-assets");
