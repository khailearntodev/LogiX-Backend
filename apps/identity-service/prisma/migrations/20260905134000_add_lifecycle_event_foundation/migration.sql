ALTER TABLE "tenants"
    ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

ALTER TABLE "users"
    ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

ALTER TABLE "roles"
    ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "version" BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

ALTER TABLE "permissions"
    ADD COLUMN "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "version" BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

ALTER TABLE "role_permissions"
    ADD COLUMN "id" UUID,
    ADD COLUMN "tenant_id" UUID,
    ADD COLUMN "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "version" BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

UPDATE "role_permissions" AS rp
SET "id" = gen_random_uuid(),
    "tenant_id" = r."tenant_id"
FROM "roles" AS r
WHERE r."id" = rp."role_id";

ALTER TABLE "role_permissions"
    ALTER COLUMN "id" SET NOT NULL,
    ALTER COLUMN "tenant_id" SET NOT NULL,
    ADD CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id"),
    ADD CONSTRAINT "role_permissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ix_role_permissions_tenant_permission" ON "role_permissions"("tenant_id", "permission_id");

ALTER TABLE "user_roles"
    ADD COLUMN "id" UUID,
    ADD COLUMN "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "version" BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

UPDATE "user_roles"
SET "id" = gen_random_uuid();

ALTER TABLE "user_roles"
    ALTER COLUMN "id" SET NOT NULL,
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id"),
    ADD CONSTRAINT "user_roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sessions"
    ADD COLUMN "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "version" BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
