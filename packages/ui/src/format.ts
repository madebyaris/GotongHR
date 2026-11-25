export type UiLocale = "id-ID" | "en-ID";

function groupThousands(digits: string, separator: string): string {
  const groups: string[] = [];
  let rest = digits;
  while (rest.length > 3) {
    groups.unshift(rest.slice(-3));
    rest = rest.slice(0, -3);
  }
  groups.unshift(rest);
  return groups.join(separator);
}

/** Formats integer rupiah. This does not compute tax. */
export function formatIdr(value: bigint, locale: UiLocale = "id-ID"): string {
  if (typeof value !== "bigint") {
    throw new TypeError("IDR values are bigint rupiah.");
  }
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  const grouped = groupThousands(digits, locale === "id-ID" ? "." : ",");
  const body = locale === "id-ID" ? `Rp${grouped}` : `IDR ${grouped}`;
  return negative ? `-${body}` : body;
}

const dateFormatters: Record<UiLocale, Intl.DateTimeFormat> = {
  "id-ID": new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeZone: "Asia/Jakarta",
  }),
  "en-ID": new Intl.DateTimeFormat("en-ID", {
    dateStyle: "medium",
    timeZone: "Asia/Jakarta",
  }),
};

export function formatDate(value: Date, locale: UiLocale): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("formatDate requires a valid Date.");
  }
  return dateFormatters[locale].format(value);
}
