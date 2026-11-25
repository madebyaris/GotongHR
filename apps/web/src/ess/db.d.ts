export interface MockLocationFlags {
  mocked: boolean;
  source: "gps" | "branch";
}

export interface OutboxClockEvent {
  idempotency_key: string;
  employee_id: string;
  punch_type: "clock_in" | "clock_out";
  captured_at: string;
  monotonic_elapsed_ms: number;
  lat: number;
  lng: number;
  accuracy: number | null;
  mock_location_flags: MockLocationFlags;
  selfie_blob: Blob;
  selfie_type: "image/webp" | "image/jpeg";
  sync_source: "online" | "offline_queue";
}

export interface StoredBootstrap {
  id: string;
  etag: string | null;
  savedAt: number;
  data: unknown;
}

export function openDb(): Promise<IDBDatabase>;
export function putOutbox(event: OutboxClockEvent): Promise<void>;
export function listOutbox(): Promise<OutboxClockEvent[]>;
export function deleteOutbox(key: string): Promise<void>;
export function writeOwnerBeat(): Promise<void>;
export function readOwnerBeat(): Promise<number | null>;
export function writeBootstrap(record: StoredBootstrap): Promise<void>;
export function readBootstrap(): Promise<StoredBootstrap | null>;
