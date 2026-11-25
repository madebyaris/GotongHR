# Find an employee and open the contract profile

An HR admin searches the directory, opens one employee, and reads the contract end date. A PKWT row names the end date and says when it falls inside 90 days.

## Sub-features

- `directory-search` filters the table by name or code, status, department, and contract.
- `directory-profile` opens the employee from the name in the table.
- `directory-contract-end` shows the PKWT end date on the directory row and in the profile.
- `directory-pay` appends a pay profile and shows it with `formatIdr`. The row cannot be edited in place.

## How to get to it (user POV)

- Open `Employees` after at least one employee exists.
- The heading is `Employees`. The primary button is `Add employee`.
- Type in `Name or code`, or choose `Filter by status`, `Filter by department`, or `Contract`.
- Choose the employee name. The profile heading is that name. `Back to directory` returns to the table.
- `Reveal NIK` stays on the directory row until the profile is open. The reason form is on the profile.

## Driving it with Playwright

Preconditions:

- `verify.sh doctor` printed `doctor=ok`.
- Feature 03 has left `Sari Wulandari` (`E001`) on the directory.
- The owner can add employees.

- **Search.** `page.getByLabel("Name or code").fill("Widyaningrum")`. The long-name employee stays. `Sari Wulandari` is not visible. Clear the field and both names are visible again.
- **Open.** `page.getByRole("button", { name: "Anastasia Putri Widyaningrum Kartikasari" }).click()`. The profile heading with that name is visible. The legal entity and branch names are visible.
- **Assignment.** Fill `New department` and `Department code`, choose `Add department`, then fill `New position` and `Position code` and choose `Add position`. `Save assignment` puts the department and position on the directory row.
- **Contract.** On the profile, set `Contract type` to `PKWT`, fill `Start date` and `End date`, and choose `Add contract`. The profile and the directory row show `PKWT` and the end date. A date inside 90 days includes `ends in`.
- **Pay.** Fill `Base salary` with `8.500.000` and choose `Add pay`. The profile shows `Rp8.500.000`. There is no button that edits that row.
- **Proof.** Save a wide screenshot and a 390px screenshot of the directory with the long name and the end date visible. The page does not scroll sideways at 390px.

## Gotchas

- `@reui/c-data-grid-1` does not ask for `REUI_LICENSE_KEY`. Its grid scrolls sideways, so this screen uses the stock table and wraps rows at 390px.
- A PKWT without an end date shows `A PKWT contract needs an end date.` A PKWTT has no end date field. A department needs a code. A position needs a title and a code.
- The directory end date is the active contract, then a future contract, then the latest ended contract.
- Pay history is append-only. A second profile on the same `Effective date` is rejected. `PATCH` on that route is not registered.
- The masked NIK stays in a table cell. The revealed digits are the profile status `NIK …`, not a second copy in the table.
- `Name or code` matches either field. `Filter by department` uses the department id, not a substring of the name.
