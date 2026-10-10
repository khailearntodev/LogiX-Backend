-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "address_line" TEXT,
ADD COLUMN     "district" VARCHAR(100),
ADD COLUMN     "legal_name" VARCHAR(255),
ADD COLUMN     "phone" VARCHAR(30),
ADD COLUMN     "postal_code" VARCHAR(20),
ADD COLUMN     "province" VARCHAR(100),
ADD COLUMN     "tax_code" VARCHAR(50),
ADD COLUMN     "ward" VARCHAR(100);

-- Manual: a legal address requires province and address line together
ALTER TABLE "tenants"
  ADD CONSTRAINT "ck_tenants_legal_address" CHECK (
    ("address_line" IS NULL AND "province" IS NULL)
    OR ("address_line" IS NOT NULL AND "province" IS NOT NULL)
  );
