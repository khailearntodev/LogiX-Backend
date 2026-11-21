-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "ai_custom_instructions" TEXT,
ADD COLUMN     "ai_instructions_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "ai_instructions_updated_at" TIMESTAMPTZ(6),
ADD COLUMN     "ai_instructions_updated_by" UUID;

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_ai_instructions_updated_by_fkey" FOREIGN KEY ("ai_instructions_updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Manual CHECK Constraint: enforce maximum 2000 characters and non-blank text when not null
ALTER TABLE "tenants"
  ADD CONSTRAINT "ck_tenants_ai_custom_instructions_len"
  CHECK (
    "ai_custom_instructions" IS NULL
    OR (
      char_length("ai_custom_instructions") <= 2000
      AND char_length(btrim("ai_custom_instructions")) > 0
    )
  );
