-- Seed immutable audit log read permission (OWNER-only default policy)
INSERT INTO "identity"."permissions" ("id", "module", "resource", "action", "code", "name", "description", "created_at", "updated_at", "version", "deleted_at")
VALUES
  (
    gen_random_uuid(),
    'AUDIT',
    'log',
    'read',
    'audit:log:read',
    'Xem nhật ký kiểm toán',
    'Cho phép tra cứu nhật ký kiểm toán bất biến và truy vết chuỗi sự kiện theo phạm vi tổ chức ở chế độ chỉ đọc',
    NOW(),
    NOW(),
    1,
    NULL
  )
ON CONFLICT ("code") DO UPDATE SET
  "module" = EXCLUDED."module",
  "resource" = EXCLUDED."resource",
  "action" = EXCLUDED."action",
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "deleted_at" = NULL,
  "updated_at" = NOW();

-- Backfill audit:log:read strictly for system OWNER roles only.
-- ADMIN, MEMBER, and custom roles must be granted explicitly by OWNER in the Permission Matrix.
INSERT INTO "identity"."role_permissions" ("id", "tenant_id", "role_id", "permission_id", "granted_at", "created_at", "updated_at", "version", "deleted_at")
SELECT
  gen_random_uuid(),
  r."tenant_id",
  r."id",
  p."id",
  NOW(),
  NOW(),
  NOW(),
  1,
  NULL
FROM "identity"."roles" r
CROSS JOIN "identity"."permissions" p
WHERE r."deleted_at" IS NULL
  AND r."is_system" = true
  AND r."code" = 'OWNER'
  AND p."deleted_at" IS NULL
  AND p."code" = 'audit:log:read'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
