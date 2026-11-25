# Create an employee and see the masked NIK after reload

The owner adds an employee on the Employees page, sees a masked NIK, reloads, and still sees the mask. The 16-digit NIK is not on the page, not in the list JSON, and not stored as plaintext.

## Sub-features

- `employee-open` opens the directory after the company exists.
- `employee-create` saves Sari Wulandari from the form.
- `employee-mask-reload` shows `3273********0001` after reload and hides `3273011508950001`.
- `employee-hidden-fields` reads the employment fields from `GET /api/v1/employees` and the row from SQL.

## How to get to it (user POV)

- Sign in, save the company, then choose `Employees` in the `Admin` navigation.
- The heading is `Employees`. The form heading is `Add employee`.

## Driving it with Playwright

Preconditions:

- `verify.sh doctor` printed `doctor=ok`.
- A legal entity and a branch exist. When the status says `No legal entity yet.`, save them with the feature 02 form first. Do not insert those rows with SQL.
- No employee is already coded `E001`.

Run the scripted proof:

```bash
.cursor/skills/verify-gotonghr/scripts/verify.sh drive "$RUN_ID"
```

The script does the following, and a hand drive uses the same locators.

- **Open Employees.** `page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Employees" }).click()`. The headings `Employees` and `Add employee` are visible.
- **Create.** Fill `Full name` with `Sari Wulandari`, `Employee code` with `E001`, and `NIK` with `3273011508950001`. Leave `Status`, `PTKP`, `Tax method`, and `PPh 21 subject` on their defaults (`active`, `TK/0`, `Gross`, `Permanent`). Choose `Add employee`. The status contains `Saved. Sari Wulandari.` The text `3273********0001` is visible. `page.getByText("3273011508950001")` has count 0.
- **Reload.** `page.reload()`. The heading `Employees` is visible. `3273********0001` is visible. The raw NIK count is still 0. The page shows `GotongHR`.
- **Hidden fields.** `fetch("/api/v1/employees", { credentials: "include" })` returns 200. The `E001` object has `nikMask` `3273********0001`, `employmentStatus` `active`, `ptkpStatus` `TK/0`, `taxMethod` `gross`, `pph21SubjectType` `permanent`, a `joinDate`, a `legalEntityId`, and a `branchId`. The body does not contain `3273011508950001`, `nik_enc`, or `nikEnc`.
- **SQL.** Read `hr_employees` joined to `hr_employee_pii` for `employee_code = 'E001'`. Expect one row, `full_name` `Sari Wulandari`, `nik_mask` `3273********0001`, and `position(nik in nik_enc) = 0`. Do not write `nik_enc` into the evidence file.
- **Proof.** Save `03-employee-reload.png`, `03-employee-reload.aria.txt`, `03-employees.json`, and `03-employee-row.txt` under the run's `evidence` directory.

## Gotchas

- Without a company, the page says `Set up the company before adding an employee` and the form is absent. Saving through the API with a guessed id is not this feature.
- The table does not show join date, status, PTKP, tax method, or PPh 21 subject. A screenshot cannot prove those fields. Read the JSON.
- The NIK box is cleared after a successful save. Assert the table mask, not the empty input.
- `nik_enc` is ciphertext. A row that exists is not proof that the screen masks the NIK.
- `E001` is unique per tenant. A second create on the same database returns a conflict. Use a fresh database.
- Join date defaults to today in `Asia/Jakarta` and is on the form. The table does not repeat it. The JSON `joinDate` is that date.
