-- CreateTable
CREATE TABLE "user_tenants" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "role" VARCHAR(50) NOT NULL DEFAULT 'MEMBER',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_tenants_pkey" PRIMARY KEY ("id")
);

-- DropIndex & AddIndex on User
DROP INDEX IF EXISTS "ix_users_tenant_status";
CREATE INDEX "ix_users_status" ON "users" ("status", "created_at" DESC);
CREATE UNIQUE INDEX "ux_users_email" ON "users" ("email");

-- Remove tenant_id column constraint & column from users if migrating, or drop constraint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_tenant_id_fkey";
ALTER TABLE "users" DROP COLUMN IF EXISTS "tenant_id";

-- CreateIndex on user_tenants
CREATE UNIQUE INDEX "ux_user_tenants" ON "user_tenants" ("user_id", "tenant_id");
CREATE INDEX "ix_user_tenants_tenant_status" ON "user_tenants" ("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "user_tenants" ADD CONSTRAINT "user_tenants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_tenants" ADD CONSTRAINT "user_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
