import { getDocument, PasswordResponses } from "pdfjs-dist/legacy/build/pdf.mjs";

export { PasswordResponses };

export interface PayslipTextRun {
  str: string;
  x: number;
  y: number;
  width: number;
}

export interface DecryptedPayslip {
  text: string;
  pageCount: number;
  runs: PayslipTextRun[];
}

/** Opens a PDF with pdf.js. A missing or wrong password rejects. */
export async function readPayslipText(
  pdf: Uint8Array,
  password?: string,
): Promise<DecryptedPayslip> {
  const params: {
    data: Uint8Array;
    verbosity: number;
    password?: string;
  } = {
    data: new Uint8Array(pdf),
    verbosity: 0,
  };
  if (password !== undefined) {
    params.password = password;
  }
  const opened = await getDocument(params).promise;
  const parts: string[] = [];
  const runs: PayslipTextRun[] = [];
  for (let pageNumber = 1; pageNumber <= opened.numPages; pageNumber += 1) {
    const page = await opened.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const item of content.items) {
      const run = textRun(item);
      if (!run) {
        continue;
      }
      parts.push(run.str);
      runs.push(run);
    }
  }
  return { text: parts.join("\n"), pageCount: opened.numPages, runs };
}

function textRun(item: unknown): PayslipTextRun | null {
  if (item === null || typeof item !== "object") {
    return null;
  }
  if (!("str" in item) || typeof item.str !== "string" || item.str === "") {
    return null;
  }
  if (!("transform" in item) || !Array.isArray(item.transform)) {
    return null;
  }
  if (!("width" in item) || typeof item.width !== "number") {
    return null;
  }
  const x = item.transform[4];
  const y = item.transform[5];
  return {
    str: item.str,
    x: typeof x === "number" ? x : 0,
    y: typeof y === "number" ? y : 0,
    width: item.width,
  };
}

export function passwordRejectionCode(error: unknown): number | null {
  if (!(error instanceof Error) || error.name !== "PasswordException") {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}
