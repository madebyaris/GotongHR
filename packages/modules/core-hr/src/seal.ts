import { provisionTenantKeys, readTenantSecrets } from "@gotonghr/audit";
import {
  blindIndex,
  encryptField,
  maskBankAccount,
  maskBpjsKesehatan,
  maskBpjsTk,
  maskKkNumber,
  maskNik,
  maskNpwp,
  type PiiField,
} from "@gotonghr/crypto";
import type { TenantTx } from "@gotonghr/db";

export interface PlainPii {
  nik: string;
  npwp: string | null;
  kkNumber: string | null;
  bpjsKesehatanNo: string | null;
  bpjsTkNo: string | null;
  bankAccountNumber: string | null;
}

export interface SealedPii {
  nikEnc: string;
  nikHash: string;
  nikMask: string;
  npwpEnc: string | null;
  npwpHash: string | null;
  npwpMask: string | null;
  kkNumberEnc: string | null;
  kkNumberMask: string | null;
  bpjsKesehatanNoEnc: string | null;
  bpjsKesehatanNoMask: string | null;
  bpjsTkNoEnc: string | null;
  bpjsTkNoMask: string | null;
  bankAccountNumberEnc: string | null;
  bankAccountNumberMask: string | null;
}

/** Encrypts with the tenant DEK and stores a blind index. Callers keep the plaintext out of SQL logs. */
export async function sealPii(tx: TenantTx, tenantId: string, plain: PlainPii): Promise<SealedPii> {
  await provisionTenantKeys(tx, tenantId);
  const secrets = await readTenantSecrets(tx, tenantId);
  return sealPiiWithSecrets(secrets, tenantId, plain);
}

/** Same seal as `sealPii` when the caller already holds the tenant DEK. */
export function sealPiiWithSecrets(
  secrets: { dek: Buffer; pepper: Buffer },
  tenantId: string,
  plain: PlainPii,
): SealedPii {
  const npwp = sealOptional(secrets.dek, tenantId, "npwp", plain.npwp, maskNpwp);
  const kk = sealOptional(secrets.dek, tenantId, "kk_number", plain.kkNumber, maskKkNumber);
  const kesehatan = sealOptional(
    secrets.dek,
    tenantId,
    "bpjs_kesehatan_no",
    plain.bpjsKesehatanNo,
    maskBpjsKesehatan,
  );
  const tk = sealOptional(secrets.dek, tenantId, "bpjs_tk_no", plain.bpjsTkNo, maskBpjsTk);
  const bank = sealOptional(
    secrets.dek,
    tenantId,
    "bank_account_number",
    plain.bankAccountNumber,
    maskBankAccount,
  );
  return {
    nikEnc: encryptField(secrets.dek, tenantId, "nik", plain.nik),
    nikHash: blindIndex(secrets.pepper, plain.nik),
    nikMask: maskNik(plain.nik),
    npwpEnc: npwp.enc,
    npwpHash: plain.npwp ? blindIndex(secrets.pepper, plain.npwp) : null,
    npwpMask: npwp.mask,
    kkNumberEnc: kk.enc,
    kkNumberMask: kk.mask,
    bpjsKesehatanNoEnc: kesehatan.enc,
    bpjsKesehatanNoMask: kesehatan.mask,
    bpjsTkNoEnc: tk.enc,
    bpjsTkNoMask: tk.mask,
    bankAccountNumberEnc: bank.enc,
    bankAccountNumberMask: bank.mask,
  };
}

export async function nikHashFor(tx: TenantTx, tenantId: string, nik: string): Promise<string> {
  await provisionTenantKeys(tx, tenantId);
  const secrets = await readTenantSecrets(tx, tenantId);
  return blindIndex(secrets.pepper, nik);
}

export async function sealField(
  tx: TenantTx,
  tenantId: string,
  field: PiiField,
  value: string | null,
): Promise<{ enc: string | null; hash: string | null; mask: string | null }> {
  if (!value) return { enc: null, hash: null, mask: null };
  await provisionTenantKeys(tx, tenantId);
  const secrets = await readTenantSecrets(tx, tenantId);
  return {
    enc: encryptField(secrets.dek, tenantId, field, value),
    hash: blindIndex(secrets.pepper, value),
    mask: maskFor(field, value),
  };
}

export async function npwpHashFor(
  tx: TenantTx,
  tenantId: string,
  npwp: string | null,
): Promise<string | null> {
  if (!npwp) return null;
  await provisionTenantKeys(tx, tenantId);
  const secrets = await readTenantSecrets(tx, tenantId);
  return blindIndex(secrets.pepper, npwp);
}

function maskFor(field: PiiField, value: string): string {
  switch (field) {
    case "nik":
      return maskNik(value);
    case "npwp":
      return maskNpwp(value);
    case "kk_number":
      return maskKkNumber(value);
    case "bpjs_kesehatan_no":
      return maskBpjsKesehatan(value);
    case "bpjs_tk_no":
      return maskBpjsTk(value);
    case "bank_account_number":
      return maskBankAccount(value);
  }
}

function sealOptional(
  dek: Buffer,
  tenantId: string,
  field: PiiField,
  value: string | null,
  mask: (value: string) => string,
): { enc: string | null; mask: string | null } {
  if (!value) return { enc: null, mask: null };
  return { enc: encryptField(dek, tenantId, field, value), mask: mask(value) };
}
