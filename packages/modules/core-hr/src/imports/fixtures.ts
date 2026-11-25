export const IMPORT_HEADER =
  "employee_code,full_name,nik,npwp,employment_status,join_date,ptkp_status,tax_method,pph21_subject_type";

/** Day 32 is not a real NIK date. Three rows in `badNikCsv` use it. */
export const BAD_NIK = "3273013208950001";

/** 1-based file lines. Line 1 is the header. */
export const BAD_NIK_LINES = [2, 6, 11] as const;

export function validNik(serial: number): string {
  return `327301150895${String(serial).padStart(4, "0")}`;
}

export function validEmployeeCsv(count: number): string {
  const lines = [IMPORT_HEADER];
  for (let serial = 1; serial <= count; serial += 1) {
    lines.push(employeeLine(serial, validNik(serial)));
  }
  return `${lines.join("\n")}\n`;
}

export function badNikCsv(): string {
  const bad = new Set<number>(BAD_NIK_LINES);
  const lines = [IMPORT_HEADER];
  for (let line = 2; line <= 12; line += 1) {
    const nik = bad.has(line) ? BAD_NIK : validNik(line);
    lines.push(employeeLine(line, nik));
  }
  return `${lines.join("\n")}\n`;
}

function employeeLine(serial: number, nik: string): string {
  const code = `E${String(serial).padStart(4, "0")}`;
  const npwp = `9${String(serial).padStart(14, "0")}`;
  return `${code},Karyawan ${code},${nik},${npwp},active,2024-03-01,TK/0,gross,permanent`;
}
