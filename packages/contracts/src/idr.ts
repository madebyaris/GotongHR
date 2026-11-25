declare const idrBrand: unique symbol;

/** Integer rupiah. The UI formats this value. The UI does not compute tax. */
export type Idr = bigint & { readonly [idrBrand]: "IDR" };

export function idr(value: bigint): Idr {
  if (typeof value !== "bigint") {
    throw new TypeError("IDR values are bigint rupiah.");
  }
  return value as Idr;
}
