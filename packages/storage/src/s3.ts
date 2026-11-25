import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assertObjectKey, tokenExpiry } from "./keys.ts";
import { MAX_UPLOAD_BYTES, type ObjectStorage, type PresignPutInput } from "./types.ts";

export interface S3StorageOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}

export interface S3ObjectStorage extends ObjectStorage {
  kind: "s3";
}

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  if (name === "NotFound" || name === "NoSuchKey") return true;
  const meta = "$metadata" in error ? error.$metadata : undefined;
  return Boolean(
    meta &&
      typeof meta === "object" &&
      "httpStatusCode" in meta &&
      (meta as { httpStatusCode?: unknown }).httpStatusCode === 404,
  );
}

function lifetime(expiresInSeconds: number | undefined): number {
  const now = Date.now();
  return tokenExpiry(expiresInSeconds, now) - Math.floor(now / 1000);
}

export function createS3Storage(options: S3StorageOptions): S3ObjectStorage {
  const client = new S3Client({
    region: options.region,
    forcePathStyle: options.forcePathStyle ?? false,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
  });

  return {
    kind: "s3",
    async presignPut(input: PresignPutInput) {
      if (input.maxBytes < 1 || input.maxBytes > MAX_UPLOAD_BYTES) {
        throw new Error("Upload cap cannot exceed 2 MB.");
      }
      assertObjectKey(input.key);
      const posted = await createPresignedPost(client, {
        Bucket: options.bucket,
        Key: input.key,
        Expires: lifetime(input.expiresInSeconds),
        Fields: { "Content-Type": input.contentType },
        Conditions: [
          ["content-length-range", 0, input.maxBytes],
          ["eq", "$Content-Type", input.contentType],
        ],
      });
      return {
        url: posted.url,
        method: "POST",
        headers: {},
        fields: posted.fields,
      };
    },
    async presignGet(input) {
      assertObjectKey(input.key);
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: options.bucket, Key: input.key }),
        { expiresIn: lifetime(input.expiresInSeconds) },
      );
      return { url, method: "GET" };
    },
    async openRead(input) {
      assertObjectKey(input.key);
      const response = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: input.key }));
      const body = response.Body;
      if (!body || typeof body !== "object" || !(Symbol.asyncIterator in body)) {
        throw new Error("Object body is not a stream.");
      }
      return body as AsyncIterable<Uint8Array>;
    },
    async stat(input) {
      assertObjectKey(input.key);
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: options.bucket, Key: input.key }));
        return { byteSize: head.ContentLength ?? 0 };
      } catch (error) {
        if (isMissingObject(error)) return null;
        throw error;
      }
    },
    async delete(input) {
      assertObjectKey(input.key);
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: input.key }));
    },
  };
}
