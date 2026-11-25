# Create a legal entity and a branch

The owner saves one legal entity and one branch on the company screen, sees the saved line, and sees the same values after reload.

## Sub-features

- `company-open` shows an empty setup for a new tenant.
- `company-field-error` shows a field error and does not save a short NPWP or NITKU.
- `company-save` saves the entity and the branch together.
- `company-reload` shows the saved values after a reload.

## How to get to it (user POV)

- Sign in. The app opens `Set up the company`.
- Choose `Company` in the `Admin` navigation when you are already on another admin page.

## Driving it with Playwright

Preconditions:

- `verify.sh doctor` printed `doctor=ok`.
- The owner is signed in.
- The status says `No legal entity yet.`

- **Empty setup.** Read the status. `page.getByRole("status")` contains `No legal entity yet.` The button is `Save company setup`.
- **Field error.** Fill `Company name` with `PT Surya Nusantara`, `NPWP (16 digits)` with `123456789012345`, `Branch name` with `Jakarta Pusat`, `NITKU (22 digits)` with `123456789012345678901`, and `Timezone` with `Asia/Jakarta`. Choose `Save company setup`. An alert contains `Check the highlighted fields.` The text `NPWP must be 16 digits.` and `NITKU must be 22 digits.` is visible.
- **Save.** Fill `NPWP (16 digits)` with `0123456789012345`, `NITKU (22 digits)` with `0123456789012345678901`, `UMP/UMK (rupiah)` with `5.396.761`, `Latitude` with `-6.175392`, `Longitude` with `106.827153`, and `Radius (m)` with `150`. Choose `Save company setup`. The status contains `Saved. PT Surya Nusantara · Jakarta Pusat.`
- **Reload.** `page.reload()`. `Company name` is `PT Surya Nusantara`, `Branch name` is `Jakarta Pusat`, and the status still contains `Saved.`
- **Hidden ids.** In the signed-in page, `fetch("/api/v1/me/context", { credentials: "include" })`. The JSON `data.legalEntities[0].id` and `data.branches[0].id` are present. The screen does not show those ids.
- **Proof.** Save an ARIA snapshot and a full-page screenshot after reload. Both show `PT Surya Nusantara` and `Jakarta Pusat`.

## Gotchas

- One save writes the entity and the branch. Do not stop after the entity response and call the branch unverified.
- A 15-digit NPWP can be typed. The field label asks for 16 digits. Assert the error, then send 16 digits.
- The wage on screen is formatted rupiah. The JSON field `umpUmkIdr` is an integer-rupiah string. Do not expect the JSON to contain `Rp`.
- Geofence latitude, longitude, and radius are stored together. Filling one of them and leaving the others blank is a field error.
