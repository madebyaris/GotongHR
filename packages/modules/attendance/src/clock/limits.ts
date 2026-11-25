/** A later punch faster than this needs review. The clock test asserts the number. */
export const MAX_PLAUSIBLE_TRAVEL_SPEED_KMH = 1000;

/** Drift above this many seconds needs review unless the punch was queued offline. */
export const DRIFT_REVIEW_SECONDS = 600;

/** Presigned selfie PUT cap. 100 KB. */
export const SELFIE_MAX_BYTES = 102_400;

export const MAX_SYNC_BATCH = 100;

export const SELFIE_CONTENT_TYPES = ["image/webp", "image/jpeg"] as const;

export type SelfieContentType = (typeof SELFIE_CONTENT_TYPES)[number];
