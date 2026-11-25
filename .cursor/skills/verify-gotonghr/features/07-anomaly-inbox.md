# Review a flagged punch in the anomaly inbox

A manager opens Anomalies, sees a punch that failed the geofence, marks it reviewed, and the punch leaves the pending list. The clock row stays.

## Sub-features

- `anomaly-list` shows a `needs_review` punch and hides an unflagged punch.
- `anomaly-review` sets the punch to reviewed from `Mark reviewed`.
- `anomaly-empty` shows `No punches need review.` after reload.
- `anomaly-stays-stored` keeps the `att_clock_events` row.

## How to get to it (user POV)

- Sign in as the owner.
- Open `Anomalies` in the admin nav, or go to `/admin/anomalies`.
- The list shows the employee, the flag, the distance, and `Mark reviewed`.

The owner can approve attendance. An employee membership cannot open this list.

## Driving it with Playwright

Preconditions:

- `verify.sh doctor` prints `doctor=ok`, or the API is already on port 3000 with `BETTER_AUTH_URL` set to the web origin.
- The owner session is the browser context.
- The company has a branch geofence. The drive sets one when the branch has none.

- **Employee.** Create `Raka Putra` with code `AN001` through `POST /api/v1/employees` when that code is missing. Do not insert the employee with SQL.
- **Clear.** Delete `att_clock_events` for that tenant so an older punch does not sit in the inbox.
- **Sync.** `POST /api/v1/mobile/attendance/sync` twice for `Raka Putra`. One punch is inside the geofence, one second ago, with `livenessOk: true` and `mockLocationFlag: false`. The other is about a kilometre away, so the server sets `review_status` to `needs_review`.
- **Open the inbox.** Choose `Anomalies`. The heading is `Anomalies`. The row shows `Raka Putra` and `Geofence`. One `Mark reviewed` button is visible.
- **Same list.** `GET /api/v1/attendance/anomalies` and `GET /api/v1/mobile/approvals/pending` return the same JSON, and that JSON includes the flagged punch id and not the inside punch id.
- **Review.** Choose `Mark reviewed`. The status becomes `No punches need review.`
- **Reload.** Reload `/admin/anomalies`. The status is still `No punches need review.`
- **SQL.** Read `att_clock_events` for the flagged id. `review_status` is `reviewed`, `reviewed_at` is set, and the row count for that id is 1.

## Gotchas

- An unflagged punch is not in the inbox. Do not treat a sync `200` as proof that the row is pending.
- `Mark reviewed` needs `attendance.approve`. A membership without it gets `403` and the punch stays pending.
- Liveness in this slice is the stored `liveness_ok` boolean and `mock_location_flag`. There is no face model to drive.
- Review does not delete the punch. A missing `att_clock_events` row is a failure.
- The phone route and the admin route must match. Checking only one of them does not prove the shared query.
- Clearing punches is fixture setup. Skipping the sync and inserting only SQL does not prove the screen.
