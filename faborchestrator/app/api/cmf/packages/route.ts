import { NextRequest, NextResponse } from "next/server";

import { getMesToken } from "@/modules/master-data-load/lib/cmf/cmf-auth";
import { friendlyErrorPayload } from "@/modules/master-data-load/lib/cmf/cmf-errors";
import { CMF_TYPES, type MasterDataPackage } from "@/modules/master-data-load/lib/cmf/types";
import { requireAuth } from "@/shared/lib/auth-middleware";
import { runWithCmfDb, currentDbKey } from "@/modules/master-data-load/lib/cmf/db-context";
import { profileFor } from "@/modules/master-data-load/lib/cmf/db-registry";
import { resolveCmfDbKey, noCmfDatabaseResponse } from "@/modules/master-data-load/lib/cmf/request-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DEVIATION FROM REFERENCE DOC: CMF_API_Complete_Reference.md does not cover a
 * "list recent MasterDataPackages" endpoint. CMF exposes
 * `GenericService/GetObjectsByFilter` (used elsewhere in the portal); we issue
 * a best-effort POST against it with a filter for Type=MasterDataPackage. If
 * the server rejects the payload shape we return an empty list with a
 * `notImplemented` flag so the UI can render gracefully instead of erroring.
 * Replace with the verified shape once we capture a live request.
 */

const FILTER_INPUT_TYPE =
  "Cmf.Foundation.BusinessOrchestration.GenericServiceManagement.InputObjects.GetObjectsByFilterInput, Cmf.Foundation.BusinessOrchestration";

type GetObjectsByFilterResponse = {
  Instances?: MasterDataPackage[];
  TotalRows?: number;
};

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const dbKey = await resolveCmfDbKey(request, auth.user.id);
  if (!dbKey) return noCmfDatabaseResponse();
  try {
    return await runWithCmfDb(dbKey, async () => {
    // Base URL and token both follow the selected database, so the Recent list
    // shows packages from whichever CMF the loader toggle points at.
    const base = (profileFor(currentDbKey()).baseUrl ?? "").replace(/\/+$/, "");
    if (!base) {
      return NextResponse.json(
        { error: "CMF_BASE_URL not configured" },
        { status: 500 },
      );
    }
    const token = await getMesToken();

    const body = {
      $id: "1",
      $type: FILTER_INPUT_TYPE,
      Type: CMF_TYPES.MasterDataPackage,
      MaxResults: 20,
      OrderBy: "CreatedOn DESC",
    };

    const res = await fetch(`${base}/api/GenericService/GetObjectsByFilter`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[api/cmf/packages] GetObjectsByFilter returned ${res.status}; degrading to empty list. body=${text.slice(0, 200)}`,
      );
      return NextResponse.json({
        packages: [],
        notImplemented: true,
        upstreamStatus: res.status,
      });
    }

    const data = (await res.json()) as GetObjectsByFilterResponse;
    return NextResponse.json({ packages: data.Instances ?? [] });
    });
  } catch (err) {
    console.error("[api/cmf/packages] failed", err);
    const { status, body } = friendlyErrorPayload(err);
    return NextResponse.json(body, { status });
  }
}
