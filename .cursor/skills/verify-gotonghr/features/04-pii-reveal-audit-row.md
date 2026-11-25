# Reveal PII and see an audit row from a second read

The owner reveals an employee's NIK for a stated reason, sees the digits once, and a second read shows one audit row. The directory table still shows the mask.

## Sub-features

- `pii-reveal-open` opens the reason form from the employee row.
- `pii-reveal-show` shows the NIK after a reason is entered.
- `pii-audit-row` reads one `aud_pii_access_logs` row that does not contain the raw NIK.

## How to get to it (user POV)

- Open `Employees` after the employee exists.
- Choose `Reveal NIK` on that row.
- Enter `Reason`, then choose `Show NIK`.

There is no authenticator screen. The owner enrolls through the auth API the app already calls, using the signed-in cookie, before `Show NIK` can succeed.

## Driving it with Playwright

Preconditions:

- Feature 03 has left `Sari Wulandari` on the reloaded directory, with mask `3273********0001`.
- The owner session is the same browser context.
- `verify.sh doctor` still prints `doctor=ok`.

- **Enroll.** `page.request.post("/api/auth/two-factor/enable", { data: { password } })` returns a `totpURI`. Compute the current 6-digit code from that secret. `page.request.post("/api/auth/two-factor/verify-totp", { data: { code } })` returns 200. Both calls send the browser origin. This is the product auth API, not a test-only route.
- **Open the reason form.** Choose `Reveal NIK`. `page.getByRole("button", { name: "Reveal NIK" }).click()`. The `Reason` field is visible.
- **Show the NIK.** Fill `Reason` with `BPJS registration` and choose `Show NIK`. A status contains `NIK 3273011508950001`. A table cell still shows `3273********0001`.
- **List still masks.** `fetch("/api/v1/employees", { credentials: "include" })` returns the mask and does not return `3273011508950001`.
- **Second read.** Query `aud_pii_access_logs` where `reason = 'BPJS registration'`. Expect one row, `field_name` `nik`, `resource_type` `hr_employee_pii`, and `position` of the raw NIK in `row_to_json(aud_pii_access_logs)::text` equal to 0. Do not treat the reveal response as this read.
- **Proof.** Save a screenshot of the status and the masked table cell, the reveal response JSON, and the SQL row. The SQL file records the count and `plain_at=0`. It does not need the ciphertext.

## Gotchas

- `employee.pii.reveal` asks a privileged owner for an authenticator. Before enrollment, `Show NIK` shows `Set up an authenticator before using this route.` That alert writes no audit row. Do not call the alert a successful reveal.
- An empty reason does not reveal. The reason used above is `BPJS registration`.
- The reveal response contains the raw NIK. The list and the audit row must not.
- Enrollment is not in the SPA. Skipping `Reveal NIK` and calling only the reveal HTTP route does not prove this screen.
- A second reveal with the same reason adds another audit row. Assert the count this drive produced, on a fresh database that had none.
