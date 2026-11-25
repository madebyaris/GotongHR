export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export interface PresignPutInput {
  key: string;
  contentType: string;
  maxBytes: number;
  expiresInSeconds?: number;
}

export type PresignedPut =
  | {
      url: string;
      method: "PUT";
      headers: Record<string, string>;
    }
  | {
      url: string;
      method: "POST";
      headers: Record<string, string>;
      fields: Record<string, string>;
    };

export interface PresignedGet {
  url: string;
  method: "GET";
}

export interface ObjectStat {
  byteSize: number;
}

export interface ObjectStorage {
  presignPut(input: PresignPutInput): Promise<PresignedPut>;
  presignGet(input: { key: string; expiresInSeconds?: number }): Promise<PresignedGet>;
  /** Writes bytes the server generated. Presign is for a browser upload. */
  put(input: { key: string; body: Uint8Array; contentType: string }): Promise<void>;
  /** Byte stream for one object. Callers read it line by line and do not buffer the object. */
  openRead(input: { key: string }): Promise<AsyncIterable<Uint8Array | string>>;
  stat(input: { key: string }): Promise<ObjectStat | null>;
  delete(input: { key: string }): Promise<void>;
}
