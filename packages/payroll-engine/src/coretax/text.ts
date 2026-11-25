const XML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Escapes text and attribute values so a name cannot close an element early. */
export function escapeXml(value: string): string {
  let out = "";
  for (const char of value) out += XML_ESCAPES[char] ?? char;
  return out;
}

export function isAsciiDigits(value: string, length: number): boolean {
  if (value.length !== length) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

/**
 * Rejects illegal XML controls, and also tab and new lines,
 * so each slip field stays on one line.
 */
export function hasIllegalXmlChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (
      code < 0x20 ||
      (char.length === 1 && code >= 0xd800 && code <= 0xdfff) ||
      code === 0x7f ||
      code === 0xfffe ||
      code === 0xffff
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Writes ratePerScale / rateScale as a percent.
 * This matches TerRate: scale 10000 and rate 200 is 2 percent.
 * Returns null when the percent is outside 0 to 100 or needs more than four decimals.
 */
export function formatScaledPercent(ratePerScale: bigint, rateScale: bigint): string | null {
  if (typeof ratePerScale !== "bigint" || typeof rateScale !== "bigint") return null;
  if (rateScale <= 0n || ratePerScale < 0n) return null;
  const scaled = ratePerScale * 100n;
  const whole = scaled / rateScale;
  if (whole > 100n) return null;
  let rest = scaled % rateScale;
  if (whole === 100n && rest !== 0n) return null;
  if (rest === 0n) return whole.toString();
  let fraction = "";
  for (let place = 0; place < 4; place += 1) {
    rest *= 10n;
    fraction += (rest / rateScale).toString();
    rest %= rateScale;
    if (rest === 0n) break;
  }
  if (rest !== 0n) return null;
  const trimmed = fraction.replace(/0+$/, "");
  return `${whole.toString()}.${trimmed}`;
}
