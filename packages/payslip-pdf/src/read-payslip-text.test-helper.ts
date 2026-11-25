import { getDocument, PasswordResponses } from "pdfjs-dist/legacy/build/pdf.mjs";

export { PasswordResponses };

export interface DecryptedPayslip {
  text: string;
  pageCount: number;
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
  for (let pageNumber = 1; pageNumber <= opened.numPages; pageNumber += 1) {
    const page = await opened.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (item.str) {
        parts.push(item.str);
      }
    }
  }
  return { text: parts.join("\n"), pageCount: opened.numPages };
}

export function passwordRejectionCode(error: unknown): number | null {
  if (!(error instanceof Error) || error.name !== "PasswordException") {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}
