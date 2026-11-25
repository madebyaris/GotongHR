import { randomBytes } from "node:crypto";
import { keyAad, open, seal } from "./envelope.ts";

export function generateKey(): Buffer {
  return randomBytes(32);
}

export function wrapDek(kek: Buffer, dek: Buffer, tenantId: string): string {
  if (dek.length !== 32) throw new Error("DEK must be 32 bytes.");
  return seal(kek, dek, keyAad("dek", tenantId));
}

export function unwrapDek(kek: Buffer, wrapped: string, tenantId: string): Buffer {
  const dek = open(kek, wrapped, keyAad("dek", tenantId));
  if (dek.length !== 32) throw new Error("DEK must be 32 bytes.");
  return dek;
}

export function wrapPepper(kek: Buffer, pepper: Buffer, tenantId: string): string {
  if (pepper.length !== 32) throw new Error("pepper must be 32 bytes.");
  return seal(kek, pepper, keyAad("pepper", tenantId));
}

export function unwrapPepper(kek: Buffer, wrapped: string, tenantId: string): Buffer {
  const pepper = open(kek, wrapped, keyAad("pepper", tenantId));
  if (pepper.length !== 32) throw new Error("pepper must be 32 bytes.");
  return pepper;
}
