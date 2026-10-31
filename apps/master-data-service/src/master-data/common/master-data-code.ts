import { Prisma } from '../../generated/prisma/client.js';

export const MASTER_DATA_CODE_PREFIXES = {
  customer: 'CUS',
  warehouse: 'WH',
  product: 'PRD',
  vehicle: 'VEH',
  driver: 'DRV',
} as const;

export type MasterDataCodeType = keyof typeof MASTER_DATA_CODE_PREFIXES;

export function highestMasterDataCodeSequence(
  type: MasterDataCodeType,
  existingCodes: readonly string[],
  additionalCode?: string,
): bigint {
  const prefix = `${MASTER_DATA_CODE_PREFIXES[type]}-`;
  let maximum = 0n;

  for (const code of [
    ...existingCodes,
    ...(additionalCode ? [additionalCode] : []),
  ]) {
    if (!code.startsWith(prefix)) continue;

    const suffix = code.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;

    const sequence = BigInt(suffix);
    if (sequence > maximum) maximum = sequence;
  }

  return maximum;
}

export async function syncMasterDataCodeSequence(
  tx: Prisma.TransactionClient,
  tenantId: string,
  type: MasterDataCodeType,
  existingCodes: readonly string[],
  additionalCode?: string,
): Promise<void> {
  const highWaterMark = highestMasterDataCodeSequence(
    type,
    existingCodes,
    additionalCode,
  );
  await tx.$executeRaw`
    INSERT INTO "master_data"."master_data_code_sequences"
      ("tenant_id", "code_type", "last_value", "updated_at")
    VALUES (${tenantId}::uuid, ${type}, ${highWaterMark}, now())
    ON CONFLICT ("tenant_id", "code_type")
    DO UPDATE SET
      "last_value" = GREATEST("master_data_code_sequences"."last_value", EXCLUDED."last_value"),
      "updated_at" = now()
  `;
}

export function nextMasterDataCode(
  type: MasterDataCodeType,
  sequence: bigint,
): string {
  return `${MASTER_DATA_CODE_PREFIXES[type]}-${sequence
    .toString()
    .padStart(6, '0')}`;
}

export async function allocateNextMasterDataCode(
  tx: Prisma.TransactionClient,
  tenantId: string,
  type: MasterDataCodeType,
): Promise<string> {
  const [row] = await tx.$queryRaw<Array<{ last_value: bigint }>>`
    UPDATE "master_data"."master_data_code_sequences"
    SET "last_value" = "last_value" + 1, "updated_at" = now()
    WHERE "tenant_id" = ${tenantId}::uuid AND "code_type" = ${type}
    RETURNING "last_value"
  `;

  if (!row) {
    throw new Error('Master data code sequence was not initialized');
  }

  return nextMasterDataCode(type, BigInt(row.last_value));
}
