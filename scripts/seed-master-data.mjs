import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve pg from master-data-service or local node_modules
const require = createRequire(resolve(__dirname, '../apps/master-data-service/package.json'));
const { Client } = require('pg');

const DB_CONFIG = {
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5433', 10),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
};

const SAMPLE_WAREHOUSES = [
  {
    code: 'KHO-HN-01',
    name: 'Kho Phân Phối Hà Nội',
    addressLine: 'Khu công nghiệp Đài Tư, 386 Nguyễn Văn Linh',
    ward: 'Phúc Lợi',
    district: 'Long Biên',
    province: 'Hà Nội',
    postalCode: '100000',
    latitude: 21.036237,
    longitude: 105.908456,
  },
  {
    code: 'KHO-HCM-01',
    name: 'Kho Trung Chuyển TP. Hồ Chí Minh',
    addressLine: 'Lô II-1, Đường CN13, Nhóm CN II, KCN Tân Bình',
    ward: 'Tây Thạnh',
    district: 'Tân Phú',
    province: 'Hồ Chí Minh',
    postalCode: '700000',
    latitude: 10.814421,
    longitude: 106.623118,
  },
  {
    code: 'KHO-DN-01',
    name: 'Kho Miền Trung Đà Nẵng',
    addressLine: 'Đường số 3, KCN Hòa Khánh',
    ward: 'Hòa Khánh Bắc',
    district: 'Liên Chiểu',
    province: 'Đà Nẵng',
    postalCode: '550000',
    latitude: 16.073429,
    longitude: 108.149890,
  },
  {
    code: 'KHO-BD-01',
    name: 'Kho Tổng Sóng Thần - Bình Dương',
    addressLine: 'Số 8 Đại lộ Hữu Nghị, KCN VSIP 1',
    ward: 'An Phú',
    district: 'Thuận An',
    province: 'Bình Dương',
    postalCode: '820000',
    latitude: 10.932456,
    longitude: 106.698712,
  },
  {
    code: 'KHO-HP-01',
    name: 'Kho Logistics Cảng Hải Phòng',
    addressLine: 'Khu phi thuế quan Đình Vũ, Bán đảo Đình Vũ',
    ward: 'Đông Hải 2',
    district: 'Hải An',
    province: 'Hải Phòng',
    postalCode: '180000',
    latitude: 20.835123,
    longitude: 106.745678,
  },
  {
    code: 'KHO-CT-01',
    name: 'Kho Đồng Bằng Sông Cửu Long',
    addressLine: 'Khu công nghiệp Trà Nóc 1',
    ward: 'Trà Nóc',
    district: 'Bình Thủy',
    province: 'Cần Thơ',
    postalCode: '900000',
    latitude: 10.089123,
    longitude: 105.732145,
  },
];

const SAMPLE_PRODUCTS = [
  {
    sku: 'SP-SN-18L',
    name: 'Sơn nước ngoại thất cao cấp Dulux Weathershield 18L',
    baseUnit: 'Thùng',
    weight: 25.500,
    volume: 0.024000,
  },
  {
    sku: 'SP-SN-05L',
    name: 'Sơn nội thất kháng khuẩn Dulux EasyClean 5L',
    baseUnit: 'Lon',
    weight: 7.200,
    volume: 0.007000,
  },
  {
    sku: 'SP-BL-40K',
    name: 'Bột trét tường nội ngoại thất Jotun 40kg',
    baseUnit: 'Bao',
    weight: 40.000,
    volume: 0.035000,
  },
  {
    sku: 'SP-DH-18L',
    name: 'Dầu nhớt động cơ xe tải nặng Castrol CRB Turbomax 18L',
    baseUnit: 'Xô',
    weight: 16.800,
    volume: 0.020000,
  },
  {
    sku: 'SP-CF-24H',
    name: 'Thùng cà phê hòa tan G7 3in1 (24 hộp x 20 gói)',
    baseUnit: 'Thùng',
    weight: 11.500,
    volume: 0.028000,
  },
  {
    sku: 'SP-NN-24L',
    name: 'Thùng nước ngọt Coca-Cola Sleek (24 lon x 320ml)',
    baseUnit: 'Thùng',
    weight: 8.800,
    volume: 0.016000,
  },
  {
    sku: 'SP-GAO-25K',
    name: 'Bao gạo sạch ST25 thượng hạng túi 25kg',
    baseUnit: 'Bao',
    weight: 25.000,
    volume: 0.032000,
  },
  {
    sku: 'SP-PP-25K',
    name: 'Hạt nhựa nguyên sinh Polypropylene PP 25kg',
    baseUnit: 'Bao',
    weight: 25.000,
    volume: 0.030000,
  },
  {
    sku: 'SP-TV-55IN',
    name: 'Tivi thông minh Sony 4K UHD 55 inch',
    baseUnit: 'Chiếc',
    weight: 17.500,
    volume: 0.135000,
  },
  {
    sku: 'SP-GAY-A4',
    name: 'Thùng giấy in Double A A4 70gsm (5 ram/thùng)',
    baseUnit: 'Thùng',
    weight: 10.900,
    volume: 0.018000,
  },
  {
    sku: 'SP-MY-30G',
    name: 'Thùng mì tôm Hảo Hảo tôm chua cay (30 gói x 75g)',
    baseUnit: 'Thùng',
    weight: 2.700,
    volume: 0.019000,
  },
  {
    sku: 'SP-ST-24H',
    name: 'Thùng sữa tươi tiệt trùng Vinamilk 100% (24 hộp x 1L)',
    baseUnit: 'Thùng',
    weight: 25.000,
    volume: 0.026000,
  },
];

async function seed() {
  console.log('🚀 Kết nối cơ sở dữ liệu để nạp dữ liệu mẫu Master Data...');
  
  const identityClient = new Client({
    ...DB_CONFIG,
    database: 'logix_identity',
  });
  
  const masterDataClient = new Client({
    ...DB_CONFIG,
    database: 'logix_master_data',
  });

  try {
    await identityClient.connect();
    await masterDataClient.connect();
    console.log('✅ Đã kết nối thành công tới PostgreSQL (port 5433).');

    // 1. Lấy danh sách Tenant đang hoạt động
    const tenantsRes = await identityClient.query(`
      SELECT id, code, name 
      FROM identity.tenants 
      WHERE status = 'ACTIVE' AND deleted_at IS NULL
      ORDER BY created_at ASC;
    `);

    if (tenantsRes.rows.length === 0) {
      console.warn('⚠️ Không tìm thấy tenant nào trong hệ thống! Vui lòng đăng ký tài khoản trước.');
      return;
    }

    console.log(`📌 Tìm thấy ${tenantsRes.rows.length} tổ chức/tenant đang hoạt động:`);
    tenantsRes.rows.forEach((t) => console.log(`   - [${t.code}] ${t.name} (ID: ${t.id})`));

    // 2. Chèn kho hàng và sản phẩm cho từng tenant
    for (const tenant of tenantsRes.rows) {
      console.log(`\n📦 Đang nạp dữ liệu cho tenant: "${tenant.name}" (${tenant.code})...`);

      // 2.1 Seed Warehouses
      let whCount = 0;
      for (const wh of SAMPLE_WAREHOUSES) {
        await masterDataClient.query(`
          INSERT INTO master_data.warehouses (
            id, tenant_id, code, name, address_line, ward, district, province, postal_code, latitude, longitude, status, version
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ACTIVE', 1
          )
          ON CONFLICT (tenant_id, code) DO UPDATE SET
            name = EXCLUDED.name,
            address_line = EXCLUDED.address_line,
            ward = EXCLUDED.ward,
            district = EXCLUDED.district,
            province = EXCLUDED.province,
            postal_code = EXCLUDED.postal_code,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            status = 'ACTIVE',
            deleted_at = NULL;
        `, [
          tenant.id,
          wh.code,
          wh.name,
          wh.addressLine,
          wh.ward,
          wh.district,
          wh.province,
          wh.postalCode,
          wh.latitude,
          wh.longitude,
        ]);
        whCount++;
      }
      console.log(`   ✅ Đã nạp ${whCount} kho hàng.`);

      // 2.2 Seed Products
      let prodCount = 0;
      for (const p of SAMPLE_PRODUCTS) {
        await masterDataClient.query(`
          INSERT INTO master_data.products (
            id, tenant_id, sku, name, base_unit, weight, volume, status, version
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'ACTIVE', 1
          )
          ON CONFLICT (tenant_id, sku) DO UPDATE SET
            name = EXCLUDED.name,
            base_unit = EXCLUDED.base_unit,
            weight = EXCLUDED.weight,
            volume = EXCLUDED.volume,
            status = 'ACTIVE',
            deleted_at = NULL;
        `, [
          tenant.id,
          p.sku,
          p.name,
          p.baseUnit,
          p.weight,
          p.volume,
        ]);
        prodCount++;
      }
      console.log(`   ✅ Đã nạp ${prodCount} sản phẩm master.`);
    }

    console.log('\n🎉 HOÀN TẤT NẠP DỮ LIỆU MẪU MASTER DATA!');
    console.log('Bây giờ bạn có thể vào giao diện Quản lý tồn kho để chọn Kho và Sản phẩm vừa tạo.');

  } catch (err) {
    console.error('❌ Lỗi trong quá trình nạp dữ liệu:', err);
    process.exit(1);
  } finally {
    await identityClient.end().catch(() => {});
    await masterDataClient.end().catch(() => {});
  }
}

seed();
