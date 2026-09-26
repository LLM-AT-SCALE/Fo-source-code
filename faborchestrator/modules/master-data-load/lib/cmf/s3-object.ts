import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { withCapture } from "@/shared/lib/errors/capture";

/**
 * Object storage for uploaded master-data files. Files live in S3 (private,
 * encrypted) instead of the database — keeps multi-MB blobs out of Postgres
 * and off the slow cross-region DB path. Credentials come from the standard
 * AWS chain (env / ~/.aws / IAM role); region + bucket from env.
 *
 * Every call is wrapped in `withCapture` and names the system as file storage.
 * Without it an S3 failure (rejected access key, missing bucket, no network)
 * surfaced as a CMF failure in the chat and as a blank "Upload failed" in the
 * loader wizard: the staging step is the first thing the wizard and the
 * generate/upload tools do, so the file store is what an admin must check.
 */

/** What the user is told failed — file storage, not CMF and not "the backend". */
export const FILE_STORAGE_SYSTEM = "File storage (S3)";

let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) client = new S3Client({ region: process.env.AWS_REGION || "us-west-2" });
  return client;
}

function bucket(): string {
  const b = process.env.S3_BUCKET;
  if (!b) throw new Error("S3_BUCKET is not configured.");
  return b;
}

const XLSX_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function putFile(key: string, body: Buffer, contentType = XLSX_CT): Promise<string> {
  const target = `s3://${process.env.S3_BUCKET ?? "(S3_BUCKET unset)"}/${key}`;
  await withCapture(
    { system: FILE_STORAGE_SYSTEM, operation: "putFile", target, extra: { bytes: body.byteLength } },
    () =>
      s3().send(
        new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }),
      ),
  );
  return key;
}

export async function getFile(key: string): Promise<Buffer> {
  const target = `s3://${process.env.S3_BUCKET ?? "(S3_BUCKET unset)"}/${key}`;
  return withCapture({ system: FILE_STORAGE_SYSTEM, operation: "getFile", target }, async () => {
    const res = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  });
}
