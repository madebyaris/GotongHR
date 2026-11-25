import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
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

function lifetime(expiresInSeconds: number | undefined): number {
  return tokenExpiry(expiresInSeconds) - Math.floor(Date.now() / 1000);
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
    async delete(input) {
      assertObjectKey(input.key);
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: input.key }));
    },
  };
}
