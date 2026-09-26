import { prisma } from "@/shared/lib/db";
import type { MasterDataPackage } from "@/modules/master-data-load/lib/cmf/types";

export function getPackageByCmfId(cmfId: string) {
  return prisma.package.findUnique({ where: { cmfId } });
}

/**
 * Insert or update our local mirror of a CMF MasterDataPackage. Keyed on
 * cmfId. On update we refresh display fields but never reassign the original
 * owner.
 */
export function upsertPackageFromCmf(
  instance: MasterDataPackage,
  userId: string,
) {
  const file = instance.Package;
  const sizeStr = String(file?.Size ?? "0");
  const sizeBytes = BigInt(Number.parseInt(sizeStr, 10) || 0);

  return prisma.package.upsert({
    where: { cmfId: instance.Id },
    create: {
      cmfId: instance.Id,
      name: instance.Name,
      filename: file?.Filename ?? "",
      checksum: file?.Checksum ?? "",
      sizeBytes,
      contentType: file?.ContentType ?? "application/octet-stream",
      createdByUserId: userId,
    },
    update: {
      name: instance.Name,
      filename: file?.Filename ?? "",
      checksum: file?.Checksum ?? "",
      sizeBytes,
      contentType: file?.ContentType ?? "application/octet-stream",
    },
  });
}
