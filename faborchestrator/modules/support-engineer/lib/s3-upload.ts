/**
 * S3 upload for user-attached files.
 *
 * Every file a user attaches in FabOrch is stored in the
 * `faborch-user-uploads` bucket (us-west-2) so the file is durable and so a
 * URL can be handed to MCP tools that need to fetch the file over HTTPS.
 *
 * URLs are **presigned GET URLs** (time-limited) — the bucket stays private,
 * no public-read policy is required, and any external client (including the
 * MCP Lambda/API-Gateway servers) can fetch the object until the URL expires.
 *
 * Credentials come from the default AWS provider chain:
 *   - locally:  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or shared config)
 *   - on EB:    the EC2 instance role (needs s3:PutObject on the bucket)
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { logger } from '@/shared/lib/logger';
import { withCapture } from '@/shared/lib/errors/capture';

const AWS_REGION = process.env.AWS_REGION || 'us-west-2';
const S3_UPLOAD_BUCKET = process.env.S3_UPLOAD_BUCKET || 'faborch-user-uploads';

// Lifetime of the presigned GET URL, in seconds. Default 24h; capped at the
// S3 SigV4 maximum of 7 days.
const PRESIGN_TTL_SECONDS = Math.min(
  Number(process.env.S3_PRESIGN_TTL_SECONDS) || 24 * 60 * 60,
  7 * 24 * 60 * 60
);

let _client: S3Client | null = null;
function getS3Client(): S3Client {
  if (!_client) {
    _client = new S3Client({ region: AWS_REGION });
  }
  return _client;
}

export interface UploadedFileRef {
  filename: string;
  mediaType: string;
  /** S3 object key inside the bucket. */
  key: string;
  /** Time-limited presigned GET URL (what MCP tools fetch). */
  url: string;
  sizeBytes: number;
}

/**
 * Generate a fresh presigned GET URL for an object that is already in the
 * bucket (by key). Used on later turns to re-expose a previously uploaded file
 * without re-uploading — presigned URLs expire, the underlying object doesn't.
 */
export async function presignKey(key: string): Promise<string> {
  return getSignedUrl(
    getS3Client(),
    new GetObjectCommand({ Bucket: S3_UPLOAD_BUCKET, Key: key }),
    { expiresIn: PRESIGN_TTL_SECONDS }
  );
}

/** Parse a `data:<mime>;base64,<payload>` URL into a buffer + mime type. */
function parseDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

/** Strip characters that are unsafe in an S3 key / Content-Disposition. */
function sanitizeFilename(name: string): string {
  return (name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

/**
 * Upload a single user-attached file (carried as a base64 data URL) to S3 and
 * return a presigned GET URL for it. Returns `null` if the input is not a
 * data URL. Throws on an actual S3/credential failure — callers should catch
 * so a storage hiccup never breaks the chat stream.
 */
export async function uploadUserFileToS3(params: {
  dataUrl: string;
  filename: string;
  mediaType?: string;
  userId: string;
  conversationId?: string | null;
}): Promise<UploadedFileRef | null> {
  const parsed = parseDataUrl(params.dataUrl);
  if (!parsed) {
    logger.warn('[S3] Skipping attachment without a base64 data URL', {
      toolName: 's3-upload',
      userId: params.userId,
    });
    return null;
  }

  const mediaType = params.mediaType || parsed.mimeType || 'application/octet-stream';
  const safeName = sanitizeFilename(params.filename);
  const key = `uploads/${params.userId}/${params.conversationId || 'no-conversation'}/${Date.now()}-${randomUUID()}-${safeName}`;

  const client = getS3Client();
  // An upload failure is usually a missing bucket, a wrong region or absent
  // credentials — all of which the AWS SDK error says plainly, and all of
  // which were previously lost behind a generic failure upstream.
  await withCapture(
    {
      system: 'File storage (S3)',
      operation: 'uploadUserFile',
      userId: params.userId,
      target: `s3://${S3_UPLOAD_BUCKET}/${key}`,
      extra: { filename: safeName, mediaType, bytes: parsed.buffer.length },
    },
    () =>
      client.send(
        new PutObjectCommand({
          Bucket: S3_UPLOAD_BUCKET,
          Key: key,
          Body: parsed.buffer,
          ContentType: mediaType,
          ContentDisposition: `inline; filename="${safeName}"`,
          Metadata: {
            'user-id': params.userId,
            'original-filename': safeName,
            ...(params.conversationId ? { 'conversation-id': params.conversationId } : {}),
          },
        })
      ),
  );

  const url = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: S3_UPLOAD_BUCKET, Key: key }),
    { expiresIn: PRESIGN_TTL_SECONDS }
  );

  logger.info('[S3] Stored user upload', {
    toolName: 's3-upload',
    userId: params.userId,
    route: key,
    durationMs: PRESIGN_TTL_SECONDS,
  });

  return { filename: safeName, mediaType, key, url, sizeBytes: parsed.buffer.length };
}
