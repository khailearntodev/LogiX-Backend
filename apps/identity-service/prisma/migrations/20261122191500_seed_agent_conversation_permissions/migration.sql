-- Seed dynamic RBAC permissions for User Conversation Management Center
-- Only OWNER receives these permissions by default; ADMIN and custom roles must be granted explicitly by OWNER.
INSERT INTO "identity"."permissions" ("id", "module", "resource", "action", "code", "name", "description", "created_at", "updated_at", "version", "deleted_at")
VALUES
  (gen_random_uuid(), 'AGENT', 'conversation', 'read', 'agent:conversation:read', 'Xem hội thoại AI của tổ chức', 'Cho phép xem, lọc và đọc chi tiết các cuộc hội thoại AI thuộc tổ chức ở chế độ chỉ đọc', NOW(), NOW(), 1, NULL),
  (gen_random_uuid(), 'AGENT', 'conversation', 'manage', 'agent:conversation:manage', 'Quản lý hội thoại AI của tổ chức', 'Cho phép đổi tiêu đề, lưu trữ và xóa mềm các cuộc hội thoại AI thuộc tổ chức', NOW(), NOW(), 1, NULL)
ON CONFLICT ("code") DO UPDATE SET
  "module" = EXCLUDED."module",
  "resource" = EXCLUDED."resource",
  "action" = EXCLUDED."action",
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "deleted_at" = NULL,
  "updated_at" = NOW();

-- Backfill grants ONLY for existing OWNER system roles across all active tenants
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
  AND p."code" IN (
    'agent:conversation:read',
    'agent:conversation:manage'
  )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
