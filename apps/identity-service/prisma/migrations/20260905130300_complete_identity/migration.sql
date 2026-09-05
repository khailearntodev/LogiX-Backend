ALTER TABLE "tenants"
ADD CONSTRAINT "ck_tenants_status"
CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'DISABLED'));

DROP INDEX "tenants_code_key";
CREATE UNIQUE INDEX "ux_tenants_code" ON "tenants" (lower("code"));
CREATE INDEX "ix_tenants_status_created"
ON "tenants" ("status", "created_at" DESC);

CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" VARCHAR(200) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "token_version" BIGINT NOT NULL DEFAULT 1,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_users_status" CHECK ("status" IN ('ACTIVE', 'LOCKED', 'DISABLED')),
    CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "roles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "description" TEXT,
    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_by" UUID,
    CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "user_roles" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_by" UUID,
    CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" VARCHAR(128) NOT NULL,
    "device_id" VARCHAR(200),
    "ip_hash" VARCHAR(64),
    "user_agent" TEXT,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_reason" TEXT,
    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ux_users_tenant_email" ON "users" ("tenant_id", lower("email"));
CREATE INDEX "ix_users_tenant_status" ON "users" ("tenant_id", "status", "created_at" DESC);
CREATE INDEX "ix_users_active_email" ON "users" ("tenant_id", lower("email")) WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "ux_roles_tenant_code" ON "roles" ("tenant_id", "code");
CREATE UNIQUE INDEX "ux_permissions_code" ON "permissions" ("code");
CREATE UNIQUE INDEX "ux_role_permissions" ON "role_permissions" ("role_id", "permission_id");
CREATE UNIQUE INDEX "ux_user_roles" ON "user_roles" ("tenant_id", "user_id", "role_id");
CREATE INDEX "ix_user_roles_role" ON "user_roles" ("tenant_id", "role_id", "user_id");
CREATE UNIQUE INDEX "ux_sessions_refresh_hash" ON "sessions" ("refresh_token_hash");
CREATE INDEX "ix_sessions_user_active" ON "sessions" ("tenant_id", "user_id", "expires_at" DESC) WHERE "revoked_at" IS NULL;
CREATE INDEX "ix_sessions_expiry" ON "sessions" ("expires_at") WHERE "revoked_at" IS NULL;