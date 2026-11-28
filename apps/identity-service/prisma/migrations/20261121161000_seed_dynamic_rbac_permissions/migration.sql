-- Phase 3: Standardize complete dynamic Multi-Tenant RBAC permissions catalog in PostgreSQL
-- 1. Upsert newly standardized atomic permissions into identity.permissions
INSERT INTO "identity"."permissions" ("id", "module", "resource", "action", "code", "name", "description", "created_at", "updated_at", "version", "deleted_at")
VALUES
  (gen_random_uuid(), 'TRANSPORT', 'vehicle', 'read', 'transport:vehicle:read', 'Xem danh sách phương tiện', 'Cho phép xem danh sách và chi tiết phương tiện vận tải của tổ chức', NOW(), NOW(), 1, NULL),
  (gen_random_uuid(), 'MASTER_DATA', 'customer', 'read', 'master-data:customer:read', 'Xem danh mục khách hàng', 'Cho phép xem danh sách, chi tiết và địa chỉ giao nhận của khách hàng', NOW(), NOW(), 1, NULL),
  (gen_random_uuid(), 'MASTER_DATA', 'customer', 'manage', 'master-data:customer:manage', 'Quản lý danh mục khách hàng', 'Cho phép tạo mới, cập nhật, kích hoạt và vô hiệu hóa khách hàng cùng địa chỉ giao hàng', NOW(), NOW(), 1, NULL),
  (gen_random_uuid(), 'MASTER_DATA', 'product', 'read', 'master-data:product:read', 'Xem danh mục sản phẩm', 'Cho phép xem danh sách và thông số quy cách sản phẩm (SKU)', NOW(), NOW(), 1, NULL),
  (gen_random_uuid(), 'MASTER_DATA', 'product', 'manage', 'master-data:product:manage', 'Quản lý danh mục sản phẩm', 'Cho phép tạo mới, cập nhật, kích hoạt và vô hiệu hóa sản phẩm (SKU)', NOW(), NOW(), 1, NULL),
  (gen_random_uuid(), 'IAM', 'organization', 'manage', 'iam:organization:manage', 'Quản lý hồ sơ tổ chức', 'Cho phép cập nhật tên, logo và hồ sơ pháp lý của tổ chức', NOW(), NOW(), 1, NULL),
  (gen_random_uuid(), 'IAM', 'ai_instructions', 'manage', 'iam:ai-instructions:manage', 'Cấu hình chỉ dẫn AI của tổ chức', 'Cho phép cập nhật, bật/tắt và khôi phục mặc định bộ chỉ dẫn AI của tổ chức', NOW(), NOW(), 1, NULL),
  (gen_random_uuid(), 'FORECAST', 'demand_forecast', 'read', 'forecast:read', 'Xem dự báo nhu cầu', 'Cho phép xem kết quả dự báo nhu cầu SKU theo kho và cảnh báo thiếu hàng', NOW(), NOW(), 1, NULL),
  (gen_random_uuid(), 'FORECAST', 'demand_forecast', 'execute', 'forecast:run', 'Chạy dự báo nhu cầu', 'Cho phép kích hoạt chạy mô hình dự báo nhu cầu Prophet theo kho và sản phẩm', NOW(), NOW(), 1, NULL)
ON CONFLICT ("code") DO UPDATE SET
  "module" = EXCLUDED."module",
  "resource" = EXCLUDED."resource",
  "action" = EXCLUDED."action",
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "deleted_at" = NULL,
  "updated_at" = NOW();

-- 2. Backfill grants for existing OWNER and ADMIN system roles across all active tenants
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
    'transport:vehicle:read',
    'master-data:customer:read',
    'master-data:customer:manage',
    'master-data:product:read',
    'master-data:product:manage',
    'iam:organization:manage',
    'iam:ai-instructions:manage',
    'forecast:read',
    'forecast:run'
  )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- 3. Backfill read-only grants for existing MEMBER system roles across all active tenants
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
  AND p."action" = 'read'
  AND p."code" IN (
    'transport:vehicle:read',
    'master-data:customer:read',
    'master-data:product:read',
    'forecast:read'
  )
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
