declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export const PasswordResponses: {
    NEED_PASSWORD: number;
    INCORRECT_PASSWORD: number;
  };

  export function getDocument(params: {
    data: Uint8Array;
    password?: string;
    verbosity?: number;
  }): {
    promise: Promise<{
      numPages: number;
      getPage(pageNumber: number): Promise<{
        getTextContent(): Promise<{ items: ReadonlyArray<{ str?: string }> }>;
      }>;
    }>;
  };
}
