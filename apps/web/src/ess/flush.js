/* global fetch, FormData */

/**
 * Sends one queued punch: presign, upload the blob, then sync the storage key.
 * The page and the service worker both call this. Neither stores the blob in Postgres.
 */
export async function sendOutboxEvent(event) {
  const presign = await postJson("/api/v1/mobile/attendance/selfie-upload-url", {
    contentType: event.selfie_type,
    contentLength: event.selfie_blob.size,
  });
  await uploadBlob(presign.upload, event.selfie_blob);
  await postJson("/api/v1/mobile/attendance/sync", {
    events: [
      {
        idempotencyKey: event.idempotency_key,
        employeeId: event.employee_id,
        punchType: event.punch_type,
        capturedAt: event.captured_at,
        syncSource: event.sync_source,
        lat: event.lat,
        lng: event.lng,
        accuracyMeters: event.accuracy,
        livenessOk: true,
        mockLocationFlag: event.mock_location_flags.mocked,
        selfieStorageKey: presign.storageKey,
      },
    ],
  });
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.error) {
    const message = payload && payload.error && payload.error.message ? payload.error.message : "Request failed.";
    throw new Error(message);
  }
  return payload.data;
}

async function uploadBlob(upload, blob) {
  if (!upload || (upload.method !== "PUT" && upload.method !== "POST")) {
    throw new Error("Selfie upload failed.");
  }
  if (upload.method === "POST" && upload.fields) {
    const form = new FormData();
    for (const [key, value] of Object.entries(upload.fields)) form.append(key, String(value));
    form.append("file", blob);
    const response = await fetch(upload.url, { method: "POST", body: form });
    if (!response.ok) throw new Error("Selfie upload failed.");
    return;
  }
  const response = await fetch(upload.url, {
    method: "PUT",
    headers: upload.headers ?? {},
    body: blob,
  });
  if (!response.ok) throw new Error("Selfie upload failed.");
}
