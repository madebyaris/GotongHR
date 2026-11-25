/** Authentication failed, or the envelope version is not one this process can open. */
export class PiiCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiiCryptoError";
  }
}
