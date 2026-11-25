# Open the ESS bootstrap

The signed-in employee opens `/ess` and sees today's shift on one screen. The phone loads one small document, and a repeat load with the same ETag returns 304.

## Sub-features

- `ess-open` shows the employee name, today's shift, and Clock in.
- `ess-etag` returns the bootstrap under 5 KB and answers 304 when the tag matches.

## How to get to it (user POV)

- Sign in as `owner@gotonghr.local`.
- Open `BASE_URL/ess`.
- The page shows `GotongHR`, the employee name, the shift, and one Clock in button.

## Driving it with Playwright

Preconditions:

- `verify.sh doctor` printed `doctor=ok` for this `RUN_ID`, or the API is already on port 3000 with `BETTER_AUTH_URL` set to the browser origin.
- The browser origin is `http://127.0.0.1:5173`.
- An employee `ESS01` named `Sari Wulandari` exists, is linked to the owner, and has a Pagi shift for today.

- **Open the clock.** `page.setViewportSize({ width: 390, height: 844 })`. Go to `/ess`. The heading is `Sari Wulandari`. The page shows `GotongHR`, `Not clocked in`, `Pagi, 08:00 to 17:00`, and a button named `Clock in`.
- **Read the document.** `page.request.get("/api/v1/mobile/bootstrap")` returns 200. The body is under 5120 bytes. The `etag` header is present.
- **Revalidate.** Send the same request with `if-none-match` set to that tag. The status is 304 and the body is empty.
- **Proof.** Screenshot the 390px screen. It shows `GotongHR` and `Clock in`.

## Gotchas

- The session cookie is `Secure`. Use `http://127.0.0.1`, not a LAN host.
- There is no screen that links a sign-in to an employee. The drive sets `hr_employees.user_id` with SQL after the employee exists. Do not insert the employee with SQL.
- `/ess` is its own HTML entry. Do not open it as a route inside the admin SPA.
- Payslip download is not on this screen. Slice 4.5 owns that route.
- Leave balances are in the document. The clock screen does not show them.
