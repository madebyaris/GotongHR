export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export interface PresignPutInput {
  key: string;
  contentType: string;
  maxBytes: number;
  expiresInSeconds?: number;
}

export interface PresignedPut {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
}

export interface PresignedGet {
  url: string;
  method: "GET";
}

export interface ObjectStorage {
  presignPut(input: PresignPutInput): Promise<PresignedPut>;
  presignGet(input: { key: string; expiresInSeconds?: number }): Promise<PresignedGet>;
  delete(input: { key: string }): Promise<void>;
}
