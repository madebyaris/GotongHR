# Sign in as the bootstrapped owner

The bootstrapped owner opens the sign-in form, enters the bootstrap email and password, and lands on company setup. A wrong password stays on the form and shows an error.

## Sub-features

- `sign-in-open` shows the sign-in form.
- `sign-in-reject` keeps a wrong password off the company screen.
- `sign-in-owner` opens company setup for `owner@gotonghr.local`.

## How to get to it (user POV)

- Open `BASE_URL/sign-in`.
- The page heading is `Sign in`. The product name `GotongHR` is on the page.

## Driving it with Playwright

Preconditions:

- `verify.sh doctor` printed `doctor=ok` for this `RUN_ID`.
- The browser origin is `BASE_URL` from `stack.env`.
- The password is `GOTONG_BOOTSTRAP_PASSWORD` from `verify.env`.

- **Open the form.** Go to `/sign-in`. `page.goto("/sign-in")`. The heading `Sign in` is visible. The `Email` and `Password` fields are visible.
- **Reject a wrong password.** Fill `Email` with `owner@gotonghr.local` and `Password` with `not-the-owner-password`. Choose `Sign in`. `page.getByLabel("Email").fill("owner@gotonghr.local")`, `page.getByLabel("Password").fill("not-the-owner-password")`, and `page.getByRole("button", { name: "Sign in" }).click()`. An alert contains `Email or password is wrong.` The heading `Set up the company` is absent.
- **Sign in as the owner.** Fill `Password` with the bootstrap password and choose `Sign in` again. The heading `Set up the company` is visible. The page shows `owner@gotonghr.local`.
- **Proof.** `page.locator("body").ariaSnapshot()` and a full-page screenshot. Both show `GotongHR` and `Set up the company`.

## Gotchas

- The session cookie is `Secure`. Use `http://127.0.0.1`, not a LAN host. Chromium keeps that cookie. A non-loopback HTTP origin does not.
- Ten sign-in attempts on one address in one minute return `Too many attempts. Wait a minute.` A rejected password counts. Do not retry the reject step in a loop.
- `GET /api/v1/me/context` without the cookie returns 401. That is not a signed-in owner.
- A second bootstrap with a different email fails. Doctor checks the existing owner. Do not create another tenant to make sign-in pass.
