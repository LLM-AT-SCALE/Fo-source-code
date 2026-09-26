import { Prisma } from "@/lib/generated/prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/shared/lib/db";
import { putFile, getFile } from "@/modules/master-data-load/lib/cmf/s3-object";

/** Wizard step a flow stopped at; doubles as the "status" shown in Recent. */
export type FlowStatus = "UPLOADED" | "VALIDATED" | "REGISTERED" | "LOADED";

/** Store an uploaded file in S3 BEFORE any CMF call (for template validation). */
export async function createStagedUpload(input: {
  userId: string;
  filename: string;
  bytes: Buffer;
  packageName?: string;
}) {
  const s3Key = `staged/${randomUUID()}.xlsx`;
  await putFile(s3Key, input.bytes);
  return prisma.stagedUpload.create({
    data: {
      userId: input.userId,
      filename: input.filename,
      s3Key,
      status: "UPLOADED",
      packageName: input.packageName ?? null,
    },
  });
}

export async function getStagedUpload(id: string, userId: string) {
  const row = await prisma.stagedUpload.findUnique({ where: { id } });
  if (!row || row.userId !== userId) return null;
  const bytes = await getFile(row.s3Key);
  return { id: row.id, filename: row.filename, bytes };
}

/** Flow-draft metadata (no file bytes) — used to resume an interrupted flow. */
export async function getStagedMeta(id: string, userId: string) {
  const row = await prisma.stagedUpload.findUnique({ where: { id } });
  if (!row || row.userId !== userId) return null;
  return {
    id: row.id,
    filename: row.filename,
    status: row.status as FlowStatus,
    packageName: row.packageName,
    packageCmfId: row.packageCmfId,
    packageCmfDbKey: row.packageCmfDbKey,
    selectedTypes: (row.selectedTypes as string[] | null) ?? [],
  };
}

/** Advance / annotate a flow draft as the wizard progresses. */
export async function updateStagedUpload(
  id: string,
  userId: string,
  patch: {
    status?: FlowStatus;
    packageName?: string;
    packageCmfId?: string;
    packageCmfDbKey?: string;
    selectedTypes?: string[];
  },
): Promise<void> {
  await prisma.stagedUpload.updateMany({
    where: { id, userId },
    data: {
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.packageName !== undefined ? { packageName: patch.packageName } : {}),
      ...(patch.packageCmfId !== undefined ? { packageCmfId: patch.packageCmfId } : {}),
      ...(patch.packageCmfDbKey !== undefined ? { packageCmfDbKey: patch.packageCmfDbKey } : {}),
      ...(patch.selectedTypes !== undefined
        ? { selectedTypes: patch.selectedTypes as unknown as Prisma.InputJsonValue }
        : {}),
    },
  });
}

/** Mark a flow done once its load succeeds (so it drops out of "in progress"). */
export async function markFlowLoaded(packageCmfId: string): Promise<void> {
  await prisma.stagedUpload
    .updateMany({ where: { packageCmfId }, data: { status: "LOADED" } })
    .catch(() => {});
}

/** Store (or replace) the uploaded file in S3 for a package, for re-validation. */
export async function storePackageFile(packageId: string, filename: string, bytes: Buffer) {
  const s3Key = `packages/${packageId}.xlsx`;
  await putFile(s3Key, bytes);
  return prisma.packageFile.upsert({
    where: { packageId },
    create: { packageId, filename, s3Key },
    update: { filename, s3Key },
  });
}

export async function getPackageFileBytes(packageId: string): Promise<Buffer | null> {
  const row = await prisma.packageFile.findUnique({ where: { packageId } });
  if (!row) return null;
  return getFile(row.s3Key);
}
