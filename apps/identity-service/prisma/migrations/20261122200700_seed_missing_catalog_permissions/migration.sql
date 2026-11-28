-- Backfill remaining 10 permissions from the authoritative @logix/auth catalog into identity.permissions
INSERT INTO "identity"."permissions" ("id", "module", "resource", "action", "code", "name", "description", "created_at", "updated_at", "version", "deleted_at")
VALUES
  (gen_random_uuid(), 'AGENT', 'model_config', 'read', 'agent:model-config:read', 'Xem cấu hình mô hình AI', 'Cho phép xem provider và model AI đang được tổ chức sử dụng', NOW(), NOW(), 1, NULL),
  (gen_random_uuid(), 'AGENT', 'model_config', 'manage', 'agent:model-config:manage', 'Quản lý cấu hình mô hình AI', 'Cho phép thay đổi provider và model AI của tổ chức', NOW(), NOW(), 1, NULL),
  (gen_random_uuid(), 'TRANSPORT', 'trip', 'update', 'transport:trip:update', 'Cập nhật chuyến xe', 'Cho phép cập nhật danh sách lô giao, phân công và trạng thái kế hoạch chuyến xe', NOW(), NOW(), 1, NULL),
  (gen_random_uuid(), 'TRANSPORT', 'route', 'read', 'transport:route:read', 'Xem tuyến vận chuyển', 'Cho phép xem đề xuất, kế hoạch và lịch sử tuyến vận chuyển', NOW(), NOW(), 1, NULL),
  (gen_random_uuid(), 'TRANSPORT', 'route', 'execute', 'transport:route:optimize', 'Tối ưu tuyến vận chuyển', 'Cho phép yêu cầu tạo đề xuất tuyến từ bộ tối ưu', NOW(), NOW(), 1, NULL),
  (gen_random_uuid(), 'TRANSPORT', 'route', 'approve', 'transport:route:approve', 'Duyệt tuyến vận chuyển', 'Cho phép duyệt hoặc thay thế tuyến sau khi xác nhận', NOW(), NOW(), 1, NULL),
  (gen_random_uuid(), 'TRANSPORT', 'driver', 'read', 'transport:driver:read', 'Xem chuyến được giao', 'Cho phép đọc chuyến và điểm giao theo phạm vi tài xế được phép', NOW(), NOW(), 1, NULL),
  (gen_random_uuid(), 'TRANSPORT', 'driver', 'update', 'transport:driver:update', 'Ghi nhận kết quả chuyến', 'Cho phép tài xế ghi nhận đến điểm và kết quả giao theo quyền sở hữu', NOW(), NOW(), 1, NULL),
  (gen_random_uuid(), 'MASTER_DATA', 'driver', 'read', 'master-data:driver:read', 'Xem hồ sơ tài xế', 'Cho phép xem danh sách và hồ sơ tài xế của tổ chức', NOW(), NOW(), 1, NULL),
  (gen_random_uuid(), 'MASTER_DATA', 'driver', 'manage', 'master-data:driver:manage', 'Quản lý hồ sơ tài xế', 'Cho phép tạo mới, cập nhật và quản lý hồ sơ tài xế', NOW(), NOW(), 1, NULL)
ON CONFLICT ("code") DO UPDATE SET
  "module" = EXCLUDED."module",
  "resource" = EXCLUDED."resource",
  "action" = EXCLUDED."action",
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "deleted_at" = NULL,
  "updated_at" = NOW();

-- 1. Backfill all 10 permissions for OWNER and ADMIN system roles
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
  AND r."code" IN ('OWNER', 'ADMIN')
  AND p."deleted_at" IS NULL
  AND p."code" IN (
    'agent:model-config:read',
    'agent:model-config:manage',
    'transport:trip:update',
    'transport:route:read',
    'transport:route:optimize',
    'transport:route:approve',
    'transport:driver:read',
    'transport:driver:update',
    'master-data:driver:read',
    'master-data:driver:manage'
  )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- 2. Backfill non-restricted read-only permission (transport:route:read) for MEMBER
-- Restricted driver/agent permissions are intentionally excluded from MEMBER.
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
  AND r."code" = 'MEMBER'
  AND p."deleted_at" IS NULL
  AND p."code" = 'transport:route:read'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
