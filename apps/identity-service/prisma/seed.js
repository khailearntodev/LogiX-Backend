import bcrypt from 'bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';

export const SYSTEM_PERMISSIONS = [
  // --- Phân hệ Kho & Tồn kho (INVENTORY) ---
  {
    code: 'inventory:warehouse:read',
    module: 'INVENTORY',
    resource: 'warehouse',
    action: 'read',
    name: 'Xem thông tin kho bãi',
    description: 'Cho phép xem danh sách và chi tiết các kho bãi, sơ đồ vị trí lưu trữ',
  },
  {
    code: 'inventory:warehouse:create',
    module: 'INVENTORY',
    resource: 'warehouse',
    action: 'create',
    name: 'Tạo mới kho bãi',
    description: 'Cho phép tạo và thiết lập kho bãi mới',
  },
  {
    code: 'inventory:warehouse:update',
    module: 'INVENTORY',
    resource: 'warehouse',
    action: 'update',
    name: 'Chỉnh sửa kho bãi',
    description: 'Cho phép cập nhật thông tin và cấu hình kho bãi',
  },
  {
    code: 'inventory:warehouse:delete',
    module: 'INVENTORY',
    resource: 'warehouse',
    action: 'delete',
    name: 'Xóa kho bãi',
    description: 'Cho phép gỡ bỏ hoặc đóng cửa kho bãi',
  },
  {
    code: 'inventory:stock:read',
    module: 'INVENTORY',
    resource: 'stock',
    action: 'read',
    name: 'Xem tồn kho & kiểm kê',
    description: 'Cho phép tra cứu số lượng tồn kho theo sản phẩm, lô hàng và vị trí',
  },
  {
    code: 'inventory:stock:adjust',
    module: 'INVENTORY',
    resource: 'stock',
    action: 'update',
    name: 'Điều chỉnh tồn kho',
    description: 'Cho phép thực hiện điều chỉnh số lượng tồn kho và duyệt kết quả kiểm kê',
  },

  // --- Phân hệ Vận tải & Đội xe (TRANSPORT) ---
  {
    code: 'transport:trip:read',
    module: 'TRANSPORT',
    resource: 'trip',
    action: 'read',
    name: 'Xem chuyến xe & hành trình',
    description: 'Cho phép theo dõi lịch trình, trạng thái và vị trí các chuyến xe vận chuyển',
  },
  {
    code: 'transport:trip:create',
    module: 'TRANSPORT',
    resource: 'trip',
    action: 'create',
    name: 'Tạo chuyến xe mới',
    description: 'Cho phép lập kế hoạch và tạo mới chuyến xe vận tải',
  },
  {
    code: 'transport:trip:dispatch',
    module: 'TRANSPORT',
    resource: 'trip',
    action: 'execute',
    name: 'Điều phối & thực thi chuyến xe',
    description: 'Cho phép điều phối phương tiện, gán tài xế và xuất phát/hoàn thành chuyến xe',
  },
  {
    code: 'transport:vehicle:manage',
    module: 'TRANSPORT',
    resource: 'vehicle',
    action: 'manage',
    name: 'Quản lý phương tiện & tài xế',
    description: 'Cho phép thêm mới, bảo dưỡng và quản lý hồ sơ phương tiện, tài xế',
  },

  // --- Phân hệ Quản lý Đơn hàng (ORDER) ---
  {
    code: 'order:sales-order:read',
    module: 'ORDER',
    resource: 'sales_order',
    action: 'read',
    name: 'Xem danh sách đơn hàng',
    description: 'Cho phép tra cứu và xem chi tiết các đơn hàng bán hàng/vận chuyển',
  },
  {
    code: 'order:sales-order:create',
    module: 'ORDER',
    resource: 'sales_order',
    action: 'create',
    name: 'Tạo đơn hàng mới',
    description: 'Cho phép tạo mới đơn hàng trong hệ thống',
  },
  {
    code: 'order:sales-order:update',
    module: 'ORDER',
    resource: 'sales_order',
    action: 'update',
    name: 'Chỉnh sửa đơn hàng',
    description: 'Cho phép chỉnh sửa thông tin chi tiết đơn hàng trước khi duyệt',
  },
  {
    code: 'order:sales-order:approve',
    module: 'ORDER',
    resource: 'sales_order',
    action: 'approve',
    name: 'Duyệt đơn hàng',
    description: 'Cho phép phê duyệt đơn hàng để chuyển sang giai đoạn xử lý kho và giao hàng',
  },
  {
    code: 'order:sales-order:cancel',
    module: 'ORDER',
    resource: 'sales_order',
    action: 'delete',
    name: 'Hủy đơn hàng',
    description: 'Cho phép hủy bỏ đơn hàng không còn hợp lệ',
  },

  // --- Phân hệ Quản trị Tổ chức & Phân quyền (IAM) ---
  {
    code: 'iam:role:read',
    module: 'IAM',
    resource: 'role',
    action: 'read',
    name: 'Xem danh sách vai trò',
    description: 'Cho phép xem danh sách vai trò và quyền hạn được gán trong tổ chức',
  },
  {
    code: 'iam:role:manage',
    module: 'IAM',
    resource: 'role',
    action: 'manage',
    name: 'Quản lý vai trò & ma trận quyền',
    description: 'Cho phép tạo, sửa, xóa và tùy biến ma trận quyền cho các vai trò của tổ chức',
  },
  {
    code: 'iam:member:read',
    module: 'IAM',
    resource: 'member',
    action: 'read',
    name: 'Xem danh sách thành viên',
    description: 'Cho phép xem danh sách thành viên và các vai trò của họ trong tổ chức',
  },
  {
    code: 'iam:member:invite',
    module: 'IAM',
    resource: 'member',
    action: 'create',
    name: 'Mời thành viên mới',
    description: 'Cho phép mời nhân sự tham gia vào tổ chức',
  },
  {
    code: 'iam:member:assign-role',
    module: 'IAM',
    resource: 'member',
    action: 'update',
    name: 'Gán vai trò thành viên',
    description: 'Cho phép thay đổi hoặc gán các vai trò nghiệp vụ cho thành viên',
  },
  {
    code: 'iam:member:remove',
    module: 'IAM',
    resource: 'member',
    action: 'delete',
    name: 'Xóa thành viên khỏi tổ chức',
    description: 'Cho phép thu hồi quyền truy cập và gỡ bỏ thành viên khỏi tổ chức',
  },

  // --- Phân hệ Báo cáo & Thống kê (REPORT) ---
  {
    code: 'report:analytics:read',
    module: 'REPORT',
    resource: 'analytics',
    action: 'read',
    name: 'Xem báo cáo & số liệu phân tích',
    description: 'Cho phép xem các bảng điều khiển thống kê và báo cáo hiệu suất vận hành',
  },
  {
    code: 'report:export:execute',
    module: 'REPORT',
    resource: 'export',
    action: 'execute',
    name: 'Xuất dữ liệu báo cáo',
    description: 'Cho phép xuất dữ liệu ra file Excel/CSV/PDF',
  },
];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run seed');
  }

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  console.log('🚀 Bắt đầu quá trình seed dữ liệu Identity Service...');

  // 1. Seed System Permissions
  console.log(`📦 Đang seed ${SYSTEM_PERMISSIONS.length} quyền hệ thống...`);
  let permUpsertedCount = 0;
  for (const perm of SYSTEM_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: perm.code },
      update: {
        module: perm.module,
        resource: perm.resource,
        action: perm.action,
        name: perm.name,
        description: perm.description,
        deletedAt: null,
      },
      create: {
        code: perm.code,
        module: perm.module,
        resource: perm.resource,
        action: perm.action,
        name: perm.name,
        description: perm.description,
      },
    });
    permUpsertedCount++;
  }
  console.log(`✅ Đã seed thành công ${permUpsertedCount} quyền hệ thống.`);

  // 2. Seed SUPER_ADMIN account
  const superAdminEmail = process.env.SUPER_ADMIN_EMAIL || 'superadmin@logix.vn';
  const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD || 'SuperAdmin@123456';
  const passwordHash = await bcrypt.hash(superAdminPassword, 10);

  console.log(`👑 Đang kiểm tra/seed tài khoản SUPER_ADMIN: ${superAdminEmail}...`);
  const superAdminUser = await prisma.user.upsert({
    where: { email: superAdminEmail },
    update: {
      isSuperAdmin: true,
      status: 'ACTIVE',
      displayName: 'System Super Administrator',
      deletedAt: null,
    },
    create: {
      email: superAdminEmail,
      passwordHash,
      displayName: 'System Super Administrator',
      status: 'ACTIVE',
      isSuperAdmin: true,
    },
  });

  console.log(`✅ Tài khoản SUPER_ADMIN sẵn sàng: ID=${superAdminUser.id}, isSuperAdmin=${superAdminUser.isSuperAdmin}`);
  console.log('🎉 Hoàn thành seed dữ liệu Identity Service!');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Lỗi khi seed dữ liệu:', err);
  process.exit(1);
});
