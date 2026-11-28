import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

// Reuse existing workspace packages without adding new dependencies
const requireFromMasterData = createRequire(
  resolve(REPO_ROOT, 'apps/master-data-service/package.json'),
);
const { Client } = requireFromMasterData('pg');

const requireFromIdentity = createRequire(
  resolve(REPO_ROOT, 'apps/identity-service/package.json'),
);
const bcrypt = requireFromIdentity('bcrypt');

const PGHOST = process.env.PGHOST || 'localhost';
const PGPORT = parseInt(process.env.PGPORT || '5434', 10);
const PGUSER = process.env.PGUSER || 'postgres';
const PGPASSWORD = process.env.PGPASSWORD;
const PGSSLMODE = process.env.PGSSLMODE || 'disable';

if (!PGPASSWORD) {
  console.error('❌ Thiếu biến môi trường PGPASSWORD (ví dụ: $env:PGPASSWORD="postgres")');
  process.exit(1);
}

const ssl =
  PGSSLMODE && PGSSLMODE !== 'disable' ? { rejectUnauthorized: false } : undefined;

function detUuid(key) {
  const h = crypto.createHash('sha256').update(`logix-demo-all:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function withDb(database, fn) {
  const client = new Client({
    host: PGHOST,
    port: PGPORT,
    user: PGUSER,
    password: PGPASSWORD,
    database,
    ssl,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function runSubScript(scriptRelPath, extraEnv = {}) {
  execFileSync(process.execPath, [resolve(REPO_ROOT, scriptRelPath)], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      PGHOST,
      PGPORT: String(PGPORT),
      PGUSER,
      PGPASSWORD,
      PGSSLMODE,
      ...extraEnv,
    },
  });
}

async function seedIdentityExtras() {
  return withDb('logix_identity', async (db) => {
    const tenantRes = await db.query(
      `SELECT id, code, name FROM identity.tenants WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`,
    );
    const tenant = tenantRes.rows[0];
    if (!tenant) throw new Error('Không tìm thấy Tenant sau khi chạy identity seed.js');

    const superRes = await db.query(
      `SELECT id, email FROM identity.users WHERE is_super_admin = true AND deleted_at IS NULL LIMIT 1`,
    );
    const superAdmin = superRes.rows[0];

    const rolesRes = await db.query(
      `SELECT id, code FROM identity.roles WHERE tenant_id = $1 AND deleted_at IS NULL`,
      [tenant.id],
    );
    const roleMap = new Map(rolesRes.rows.map((r) => [r.code, r.id]));

    const demoPassword = process.env.DEMO_USER_PASSWORD || 'LogiX@123456';
    const passwordHash = await bcrypt.hash(demoPassword, 10);

    const demoUsers = [
      { key: 'admin', email: 'admin@logix.vn', name: 'Nguyễn Minh Quản Trị', role: 'ADMIN' },
      { key: 'staff', email: 'staff@logix.vn', name: 'Trần Văn Vận Hành', role: 'MEMBER' },
      { key: 'driver', email: 'driver@logix.vn', name: 'Lê Hoàng Tài Xế', role: 'MEMBER' },
    ];

    const seededUsers = [];
    for (const u of demoUsers) {
      const uid = detUuid(`user:${u.key}`);
      const res = await db.query(
        `INSERT INTO identity.users (id, email, password_hash, display_name, status, is_super_admin)
         VALUES ($1, $2, $3, $4, 'ACTIVE', false)
         ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name, deleted_at = NULL
         RETURNING id, email`,
        [uid, u.email, passwordHash, u.name],
      );
      const userId = res.rows[0].id;
      seededUsers.push({ id: userId, email: u.email, role: u.role });

      await db.query(
        `INSERT INTO identity.user_tenants (id, user_id, tenant_id, role, is_default, status)
         VALUES ($1, $2, $3, $4, true, 'ACTIVE')
         ON CONFLICT (user_id, tenant_id) DO NOTHING`,
        [detUuid(`ut:${u.key}`), userId, tenant.id, u.role],
      );

      const roleId = roleMap.get(u.role);
      if (roleId) {
        await db.query(
          `INSERT INTO identity.user_roles (id, tenant_id, user_id, role_id, granted_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, user_id, role_id) DO NOTHING`,
          [detUuid(`ur:${u.key}`), tenant.id, userId, roleId, superAdmin?.id ?? null],
        );
      }
    }

    // Seed sample contact leads
    const leads = [
      {
        key: 'lead-1',
        fullName: 'Phạm Quốc Hưng',
        email: 'hung.pham@saigonretail.vn',
        phone: '0908123456',
        company: 'Công ty Bán lẻ Sài Gòn',
        needs: ['ORDER_MANAGEMENT', 'INVENTORY'],
        status: 'NEW',
      },
      {
        key: 'lead-2',
        fullName: 'Đỗ Thị Lan Anh',
        email: 'lananh@bacninhfoods.vn',
        phone: '0912345678',
        company: 'Thực phẩm Bắc Ninh JSC',
        needs: ['ROUTE_OPTIMIZATION', 'DEMAND_FORECAST'],
        status: 'CONTACTED',
      },
    ];
    for (const l of leads) {
      await db.query(
        `INSERT INTO identity.contact_leads (id, full_name, email, phone_number, company_name, needs, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [detUuid(l.key), l.fullName, l.email, l.phone, l.company, l.needs, l.status],
      );
    }

    console.log(`✅ [Identity] Đã seed ${seededUsers.length} demo users + ${leads.length} contact leads.`);
    return { tenant, superAdmin, demoUsers: seededUsers };
  });
}

async function seedAndLoadMasterData(tenantId, driverUserId) {
  return withDb('logix_master_data', async (db) => {
    // Seed customers + SHIPPING addresses
    const customerSpecs = [
      {
        key: 'cust-1',
        code: 'KH-HN-001',
        name: 'Siêu thị WinMart Cầu Giấy',
        taxCode: '0101234567',
        phone: '02437654321',
        email: 'nhaphang@winmart-cg.vn',
        recipient: 'Nguyễn Thị Thu',
        addressLine: '241 Xuân Thủy',
        ward: 'Dịch Vọng Hậu',
        district: 'Cầu Giấy',
        province: 'Hà Nội',
        postalCode: '100000',
        lat: 21.0368,
        lng: 105.7824,
      },
      {
        key: 'cust-2',
        code: 'KH-HN-002',
        name: 'Công ty TNHH Phân phối Đông Đô',
        taxCode: '0107654321',
        phone: '02439876543',
        email: 'orders@dongdofoods.vn',
        recipient: 'Trần Quốc Bảo',
        addressLine: '18 Tam Trinh',
        ward: 'Mai Động',
        district: 'Hoàng Mai',
        province: 'Hà Nội',
        postalCode: '100000',
        lat: 20.9923,
        lng: 105.8625,
      },
      {
        key: 'cust-3',
        code: 'KH-HCM-001',
        name: 'Trung tâm Phân phối Bách Hóa Xanh Q7',
        taxCode: '0309988776',
        phone: '02837778899',
        email: 'supply@bhxq7.vn',
        recipient: 'Lê Minh Tuấn',
        addressLine: '469 Nguyễn Hữu Thọ',
        ward: 'Tân Hưng',
        district: 'Quận 7',
        province: 'TP. Hồ Chí Minh',
        postalCode: '700000',
        lat: 10.7412,
        lng: 106.7019,
      },
    ];

    for (const c of customerSpecs) {
      const cid = detUuid(`cust:${tenantId}:${c.key}`);
      await db.query(
        `INSERT INTO master_data.customers (id, tenant_id, code, name, tax_code, phone, email, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [cid, tenantId, c.code, c.name, c.taxCode, c.phone, c.email],
      );
      await db.query(
        `INSERT INTO master_data.customer_addresses
           (id, tenant_id, customer_id, label, recipient_name, phone, address_line, ward, district, province, postal_code, latitude, longitude, is_default, status, address_type)
         VALUES ($1, $2, $3, 'Kho nhận hàng chính', $4, $5, $6, $7, $8, $9, $10, $11, $12, true, 'ACTIVE', 'SHIPPING')
         ON CONFLICT (id) DO NOTHING`,
        [detUuid(`caddr:${tenantId}:${c.key}`), tenantId, cid, c.recipient, c.phone, c.addressLine, c.ward, c.district, c.province, c.postalCode, c.lat, c.lng],
      );
    }

    // Seed suppliers
    await db.query(
      `INSERT INTO master_data.suppliers
         (id, tenant_id, code, name, tax_code, contact_name, phone, email, address_line, ward, district, province, postal_code, latitude, longitude, status)
       VALUES ($1, $2, 'NCC-001', 'Công ty Cổ phần Sản xuất Hàng tiêu dùng Việt', '0105556667', 'Phạm Văn Nam', '02435556667', 'sales@vietconsumer.vn', 'KCN Quang Minh', 'Quang Minh', 'Mê Linh', 'Hà Nội', '100000', 21.2015, 105.7832, 'ACTIVE')
       ON CONFLICT (id) DO NOTHING`,
      [detUuid(`sup:${tenantId}:1`), tenantId],
    );

    // Seed vehicles
    const vehicleSpecs = [
      { key: 'veh-1', code: 'XE-HN-01', plate: '29C-886.12', weight: 2500, volume: 12.5 },
      { key: 'veh-2', code: 'XE-HN-02', plate: '29H-512.88', weight: 5000, volume: 24.0 },
      { key: 'veh-3', code: 'XE-HCM-01', plate: '51D-409.33', weight: 3500, volume: 16.0 },
    ];
    for (const v of vehicleSpecs) {
      await db.query(
        `INSERT INTO master_data.vehicles (id, tenant_id, code, license_plate, capacity_weight, capacity_volume, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [detUuid(`veh:${tenantId}:${v.key}`), tenantId, v.code, v.plate, v.weight, v.volume],
      );
    }

    // Seed driver linked to driver@logix.vn
    if (driverUserId) {
      await db.query(
        `INSERT INTO master_data.drivers (id, tenant_id, code, user_id, license_number, license_expiry, phone, status)
         VALUES ($1, $2, 'TX-001', $3, 'B2-012345678', '2029-12-31', '0987654321', 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [detUuid(`drv:${tenantId}:1`), tenantId, driverUserId],
      );
    }

    console.log(`✅ [Master Data] Đã seed ${customerSpecs.length} customers + SHIPPING addresses, 1 supplier, ${vehicleSpecs.length} vehicles, 1 driver.`);

    const warehouses = (
      await db.query(
        `SELECT id, code, name, address_line, ward, district, province, postal_code, latitude, longitude
         FROM master_data.warehouses WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY code`,
        [tenantId],
      )
    ).rows;
    const products = (
      await db.query(
        `SELECT id, sku, name, base_unit AS unit, weight, volume
         FROM master_data.products WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY sku`,
        [tenantId],
      )
    ).rows;
    const customers = (
      await db.query(
        `SELECT c.id, c.code, c.name, c.email, c.phone,
                a.id AS address_id, a.address_line, a.ward, a.district, a.province, a.postal_code, a.latitude, a.longitude
         FROM master_data.customers c
         JOIN master_data.customer_addresses a ON a.customer_id = c.id AND a.address_type = 'SHIPPING' AND a.deleted_at IS NULL
         WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
         ORDER BY c.code`,
        [tenantId],
      )
    ).rows;
    const vehicles = (
      await db.query(
        `SELECT id, code, license_plate, capacity_weight, capacity_volume
         FROM master_data.vehicles WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY code`,
        [tenantId],
      )
    ).rows;
    const drivers = (
      await db.query(
        `SELECT id, code, user_id, phone, license_number
         FROM master_data.drivers WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY code`,
        [tenantId],
      )
    ).rows;
    return { warehouses, products, customers, vehicles, drivers };
  });
}

async function seedInventory(tenantId, actorId, master) {
  return withDb('logix_inventory', async (db) => {
    let balancesCount = 0;
    const receiptId = detUuid(`receipt:${tenantId}:initial`);
    const primaryWh = master.warehouses[0];
    if (!primaryWh || master.products.length === 0) return;

    const corrId = detUuid(`corr:inventory:init:${tenantId}`);
    await db.query(
      `INSERT INTO inventory.stock_receipts
         (id, tenant_id, receipt_number, warehouse_id, idempotency_key, status, received_at, actor_id, correlation_id)
       VALUES ($1, $2, 'GR-DEMO-0001', $3, $4, 'POSTED', now() - interval '3 days', $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [receiptId, tenantId, primaryWh.id, `demo-receipt-${tenantId}`, actorId, corrId],
    );

    for (let wIdx = 0; wIdx < master.warehouses.length; wIdx++) {
      const wh = master.warehouses[wIdx];
      for (let pIdx = 0; pIdx < master.products.length; pIdx++) {
        const prod = master.products[pIdx];
        const balanceId = detUuid(`bal:${tenantId}:${wh.id}:${prod.id}`);
        // Make last product low-stock so low-stock alerts/UI look realistic
        const isLowStock = wIdx === 0 && pIdx === master.products.length - 1;
        const onHand = isLowStock ? 8 : 500 + pIdx * 50;
        const reserved = wIdx === 0 && pIdx < 2 ? 20 : 0;
        const threshold = isLowStock ? 25 : 50;

        const balRes = await db.query(
          `INSERT INTO inventory.inventory_balances
             (id, tenant_id, warehouse_id, product_id, on_hand_quantity, reserved_quantity, low_stock_threshold)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, warehouse_id, product_id) DO UPDATE SET updated_at = now()
           RETURNING id`,
          [balanceId, tenantId, wh.id, prod.id, onHand, reserved, threshold],
        );
        const actualBalanceId = balRes.rows[0].id;
        balancesCount++;

        if (wIdx === 0) {
          const moveId = detUuid(`move:${tenantId}:${wh.id}:${prod.id}`);
          await db.query(
            `INSERT INTO inventory.stock_movements
               (id, tenant_id, warehouse_id, product_id, balance_id, movement_type, quantity_delta,
                before_on_hand, after_on_hand, reference_type, reference_id, idempotency_key, reason, actor_id, correlation_id, occurred_at)
             VALUES ($1, $2, $3, $4, $5, 'RECEIPT', $6, 0, $6, 'STOCK_RECEIPT', $7, $8, 'Nhập kho khởi tạo dữ liệu demo', $9, $10, now() - interval '3 days')
             ON CONFLICT (id) DO NOTHING`,
            [moveId, tenantId, wh.id, prod.id, actualBalanceId, onHand, receiptId, `demo-move-${wh.id}-${prod.id}`, actorId, corrId],
          );
          await db.query(
            `INSERT INTO inventory.stock_receipt_lines
               (id, tenant_id, receipt_id, product_id, quantity, movement_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO NOTHING`,
            [detUuid(`rline:${tenantId}:${prod.id}`), tenantId, receiptId, prod.id, onHand, moveId],
          );
        }
      }
    }
    console.log(`✅ [Inventory] Đã seed ${balancesCount} inventory_balances + phiếu nhập kho & stock_movements.`);
  });
}

async function seedOrders(tenantId, actorId, master) {
  return withDb('logix_order', async (db) => {
    const wh = master.warehouses[0];
    if (!wh || master.customers.length === 0 || master.products.length < 2) return [];

    const today = new Date();
    const period = `${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, '0')}${String(today.getUTCDate()).padStart(2, '0')}`;

    const specs = [
      { key: 'ord-1', num: `SO-${period}-000001`, status: 'COMPLETED', qty: 10, daysAgo: 4 },
      { key: 'ord-2', num: `SO-${period}-000002`, status: 'IN_DELIVERY', qty: 12, daysAgo: 2 },
      { key: 'ord-3', num: `SO-${period}-000003`, status: 'READY_TO_SHIP', qty: 8, daysAgo: 1 },
      { key: 'ord-4', num: `SO-${period}-000004`, status: 'PICKING', qty: 6, daysAgo: 1 },
      { key: 'ord-5', num: `SO-${period}-000005`, status: 'CONFIRMED', qty: 15, daysAgo: 0 },
      { key: 'ord-6', num: `SO-${period}-000006`, status: 'DRAFT', qty: 5, daysAgo: 0 },
    ];

    const createdOrders = [];
    const whSnap = {
      id: wh.id,
      code: wh.code,
      name: wh.name,
      addressLine: wh.address_line,
      ward: wh.ward,
      district: wh.district,
      province: wh.province,
    };

    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      const cust = master.customers[i % master.customers.length];
      const prod1 = master.products[i % master.products.length];
      const prod2 = master.products[(i + 1) % master.products.length];
      const orderId = detUuid(`order:${tenantId}:${s.key}`);
      const resGroupId = detUuid(`resgrp:${tenantId}:${s.key}`);
      const corrId = detUuid(`corr:order:${s.key}`);

      const qty1 = s.qty;
      const qty2 = Math.max(2, Math.floor(s.qty / 2));
      const totalQty = qty1 + qty2;
      const totalWeight = Number(prod1.weight) * qty1 + Number(prod2.weight) * qty2;
      const totalVolume = Number(prod1.volume) * qty1 + Number(prod2.volume) * qty2;

      const custSnap = { id: cust.id, code: cust.code, name: cust.name, email: cust.email, phone: cust.phone };
      const addrSnap = {
        id: cust.address_id,
        addressLine: cust.address_line,
        ward: cust.ward,
        district: cust.district,
        province: cust.province,
        postalCode: cust.postal_code,
        latitude: cust.latitude ? Number(cust.latitude) : null,
        longitude: cust.longitude ? Number(cust.longitude) : null,
      };

      const isConfirmed = s.status !== 'DRAFT';
      const isCompleted = s.status === 'COMPLETED';

      await db.query(
        `INSERT INTO orders.sales_orders
           (id, tenant_id, order_number, customer_id, delivery_address_id, warehouse_id,
            customer_snapshot, delivery_address_snapshot, warehouse_snapshot,
            currency, status, order_source, idempotency_key, total_quantity, total_weight, total_volume,
            confirmed_at, completed_at, reservation_group_id, version, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
                 'VND', $10, 'MANUAL', $11, $12, $13, $14,
                 CASE WHEN $15 THEN now() - ($17 || ' days')::interval ELSE NULL END,
                 CASE WHEN $16 THEN now() - interval '1 day' ELSE NULL END,
                 CASE WHEN $15 THEN $18::uuid ELSE NULL END,
                 2, now() - ($17 || ' days')::interval)
         ON CONFLICT (id) DO NOTHING`,
        [
          orderId, tenantId, s.num, cust.id, cust.address_id, wh.id,
          JSON.stringify(custSnap), JSON.stringify(addrSnap), JSON.stringify(whSnap),
          s.status, `demo-ord-${s.key}`, totalQty, totalWeight.toFixed(3), totalVolume.toFixed(6),
          isConfirmed, isCompleted, String(s.daysAgo), resGroupId,
        ],
      );

      const line1Id = detUuid(`oline:${tenantId}:${s.key}:1`);
      const line2Id = detUuid(`oline:${tenantId}:${s.key}:2`);
      for (const [lineNo, lid, prod, qty] of [
        [1, line1Id, prod1, qty1],
        [2, line2Id, prod2, qty2],
      ]) {
        await db.query(
          `INSERT INTO orders.order_lines
             (id, tenant_id, order_id, line_number, product_id, sku_snapshot, product_name_snapshot, unit_snapshot, quantity, unit_weight, unit_volume)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (id) DO NOTHING`,
          [lid, tenantId, orderId, lineNo, prod.id, prod.sku, prod.name, prod.unit, qty, prod.weight, prod.volume],
        );
      }

      await db.query(
        `INSERT INTO orders.order_status_history
           (id, tenant_id, order_id, from_status, to_status, reason, actor_id, correlation_id, order_version)
         VALUES ($1, $2, $3, NULL, 'DRAFT', 'Tạo đơn hàng demo', $4, $5, 1)
         ON CONFLICT (tenant_id, order_id, order_version) DO NOTHING`,
        [detUuid(`ohist:${s.key}:1`), tenantId, orderId, actorId, corrId],
      );
      if (isConfirmed) {
        await db.query(
          `INSERT INTO orders.order_status_history
             (id, tenant_id, order_id, from_status, to_status, reason, actor_id, correlation_id, order_version)
           VALUES ($1, $2, $3, 'DRAFT', $4, 'Cập nhật trạng thái đơn demo', $5, $6, 2)
           ON CONFLICT (tenant_id, order_id, order_version) DO NOTHING`,
          [detUuid(`ohist:${s.key}:2`), tenantId, orderId, s.status, actorId, corrId],
        );
      }

      createdOrders.push({
        id: orderId,
        key: s.key,
        orderNumber: s.num,
        status: s.status,
        warehouseId: wh.id,
        warehouseSnapshot: whSnap,
        customerSnapshot: custSnap,
        deliveryAddressId: cust.address_id,
        deliveryAddressSnapshot: addrSnap,
        reservationGroupId: resGroupId,
        totalWeight,
        totalVolume,
        lines: [
          { id: line1Id, product: prod1, qty: qty1 },
          { id: line2Id, product: prod2, qty: qty2 },
        ],
      });
    }

    await db.query(
      `INSERT INTO orders.order_number_sequences (tenant_id, period, last_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, period) DO UPDATE SET last_value = GREATEST(orders.order_number_sequences.last_value, EXCLUDED.last_value)`,
      [tenantId, period, specs.length],
    );

    console.log(`✅ [Orders] Đã seed ${createdOrders.length} sales_orders + order_lines + status_history.`);
    return createdOrders;
  });
}

async function seedFulfillment(tenantId, actorId, orders) {
  return withDb('logix_fulfillment', async (db) => {
    const statusMap = {
      COMPLETED: 'DELIVERED',
      IN_DELIVERY: 'DISPATCHED',
      READY_TO_SHIP: 'READY_TO_SHIP',
      PICKING: 'PICKING',
      CONFIRMED: 'PENDING_PICK',
    };

    const shipments = [];
    let seq = 1;
    for (const ord of orders) {
      const shipStatus = statusMap[ord.status];
      if (!shipStatus) continue;

      const shipmentId = detUuid(`ship:${tenantId}:${ord.key}`);
      const shipNumber = `SHP-DEMO-${String(seq++).padStart(4, '0')}`;
      const corrId = detUuid(`corr:ship:${ord.key}`);

      const isReady = ['READY_TO_SHIP', 'DISPATCHED', 'DELIVERED'].includes(shipStatus);
      const isDispatched = ['DISPATCHED', 'DELIVERED'].includes(shipStatus);
      const isDelivered = shipStatus === 'DELIVERED';

      await db.query(
        `INSERT INTO fulfillment.shipments
           (id, tenant_id, shipment_number, order_id, order_number, warehouse_id, delivery_address_id,
            status, total_weight, total_volume, reservation_group_id, confirmed_order_version,
            customer_snapshot, delivery_address_snapshot, warehouse_snapshot,
            ready_at, dispatch_issued_at, delivered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 2,
                 $12::jsonb, $13::jsonb, $14::jsonb,
                 CASE WHEN $15::bool THEN now() - interval '1 day' ELSE NULL END,
                 CASE WHEN $16::bool THEN now() - interval '12 hours' ELSE NULL END,
                 CASE WHEN $17::bool THEN now() - interval '2 hours' ELSE NULL END)
         ON CONFLICT (id) DO NOTHING`,
        [
          shipmentId, tenantId, shipNumber, ord.id, ord.orderNumber, ord.warehouseId, ord.deliveryAddressId,
          shipStatus, ord.totalWeight.toFixed(3), ord.totalVolume.toFixed(6), ord.reservationGroupId,
          JSON.stringify(ord.customerSnapshot), JSON.stringify(ord.deliveryAddressSnapshot), JSON.stringify(ord.warehouseSnapshot),
          isReady, isDispatched, isDelivered,
        ],
      );

      for (const l of ord.lines) {
        await db.query(
          `INSERT INTO fulfillment.shipment_items
             (id, tenant_id, shipment_id, order_line_id, product_id, sku_snapshot, product_name_snapshot, unit_snapshot, quantity, weight, volume)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (id) DO NOTHING`,
          [
            detUuid(`sitem:${ord.key}:${l.id}`), tenantId, shipmentId, l.id, l.product.id,
            l.product.sku, l.product.name, l.product.unit, l.qty,
            (Number(l.product.weight) * l.qty).toFixed(3),
            (Number(l.product.volume) * l.qty).toFixed(6),
          ],
        );
      }

      await db.query(
        `INSERT INTO fulfillment.shipment_status_history
           (id, tenant_id, shipment_id, from_status, to_status, reason, actor_id, correlation_id, shipment_version)
         VALUES ($1, $2, $3, NULL, $4, 'Khởi tạo lô giao hàng demo', $5, $6, 1)
         ON CONFLICT (id) DO NOTHING`,
        [detUuid(`shist:${ord.key}`), tenantId, shipmentId, shipStatus, actorId, corrId],
      );

      await db.query(
        `INSERT INTO fulfillment.shipment_order_cursors (tenant_id, order_id, order_version, canceled)
         VALUES ($1, $2, 2, false)
         ON CONFLICT (tenant_id, order_id) DO NOTHING`,
        [tenantId, ord.id],
      );

      shipments.push({
        id: shipmentId,
        shipmentNumber: shipNumber,
        status: shipStatus,
        order: ord,
      });
    }

    console.log(`✅ [Fulfillment] Đã seed ${shipments.length} shipments + shipment_items + status_history.`);
    return shipments;
  });
}

async function seedTransport(tenantId, master, shipments) {
  return withDb('logix_transport', async (db) => {
    const wh = master.warehouses[0];
    const veh = master.vehicles[0];
    const drv = master.drivers[0];
    if (!wh || !veh || !drv || shipments.length < 2) return;

    const depotSnap = {
      id: wh.id,
      code: wh.code,
      name: wh.name,
      addressLine: wh.address_line,
      province: wh.province,
      latitude: wh.latitude ? Number(wh.latitude) : 21.036237,
      longitude: wh.longitude ? Number(wh.longitude) : 105.908456,
    };
    const vehSnap = {
      id: veh.id,
      code: veh.code,
      licensePlate: veh.license_plate,
      capacityWeight: Number(veh.capacity_weight),
      capacityVolume: Number(veh.capacity_volume),
    };
    const drvSnap = {
      id: drv.id,
      code: drv.code,
      userId: drv.user_id,
      fullName: 'Lê Hoàng Tài Xế',
      phone: drv.phone,
      licenseNumber: drv.license_number,
    };

    const tripConfigs = [
      { key: 'trip-completed', num: 'TRP-DEMO-0001', status: 'COMPLETED', ship: shipments[0] },
      { key: 'trip-planned', num: 'TRP-DEMO-0002', status: 'APPROVED', ship: shipments[2] ?? shipments[1] },
    ];

    for (const tc of tripConfigs) {
      const tripId = detUuid(`trip:${tenantId}:${tc.key}`);
      const ord = tc.ship.order;

      const tripCompleted = tc.status === 'COMPLETED';
      await db.query(
        `INSERT INTO transport.delivery_trips
           (id, tenant_id, trip_number, warehouse_id, vehicle_id, driver_id, status,
            planned_start_at, actual_start_at, completed_at, total_weight, total_volume,
            dispatch_version, dispatched_at, depot_snapshot, driver_snapshot, vehicle_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 now() - interval '1 day',
                 CASE WHEN $13::bool THEN now() - interval '20 hours' ELSE NULL END,
                 CASE WHEN $13::bool THEN now() - interval '2 hours' ELSE NULL END,
                 $8, $9, 1,
                 CASE WHEN $13::bool THEN now() - interval '20 hours' ELSE NULL END,
                 $10::jsonb, $11::jsonb, $12::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [
          tripId, tenantId, tc.num, wh.id, veh.id, drv.id, tc.status,
          ord.totalWeight.toFixed(3), ord.totalVolume.toFixed(6),
          JSON.stringify(depotSnap), JSON.stringify(drvSnap), JSON.stringify(vehSnap),
          tripCompleted,
        ],
      );

      await db.query(
        `INSERT INTO transport.trip_shipments
           (id, tenant_id, trip_id, shipment_id, warehouse_id, weight, volume, order_id, order_version, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 2, 'ASSIGNED')
         ON CONFLICT (id) DO NOTHING`,
        [
          detUuid(`tship:${tc.key}`), tenantId, tripId, tc.ship.id, wh.id,
          ord.totalWeight.toFixed(3), ord.totalVolume.toFixed(6), ord.id,
        ],
      );

      const stopId = detUuid(`tstop:${tc.key}`);
      await db.query(
        `INSERT INTO transport.trip_stops
           (id, tenant_id, trip_id, shipment_id, delivery_address_id, address_snapshot,
            latitude, longitude, planned_sequence, approved_sequence, status, current_attempt, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 1, 1,
                 CASE WHEN $9::bool THEN 'DELIVERED' ELSE 'PENDING' END,
                 CASE WHEN $9::bool THEN 1 ELSE 0 END,
                 CASE WHEN $9::bool THEN now() - interval '2 hours' ELSE NULL END)
         ON CONFLICT (id) DO NOTHING`,
        [
          stopId, tenantId, tripId, tc.ship.id, ord.deliveryAddressId,
          JSON.stringify(ord.deliveryAddressSnapshot),
          ord.deliveryAddressSnapshot.latitude, ord.deliveryAddressSnapshot.longitude,
          tripCompleted,
        ],
      );

      if (tc.status === 'COMPLETED') {
        await db.query(
          `INSERT INTO transport.delivery_attempts
             (id, tenant_id, trip_stop_id, shipment_id, attempt_number, status, reason, actor_driver_id, occurred_at, correlation_id)
           VALUES ($1, $2, $3, $4, 1, 'DELIVERED', 'Giao hàng thành công ký nhận đầy đủ', $5, now() - interval '2 hours', $6)
           ON CONFLICT (id) DO NOTHING`,
          [detUuid(`datt:${tc.key}`), tenantId, stopId, tc.ship.id, drv.id, detUuid(`corr:datt:${tc.key}`)],
        );
      }
    }

    console.log(`✅ [Transport] Đã seed ${tripConfigs.length} delivery_trips + trip_shipments + trip_stops + delivery_attempts.`);
  });
}

async function seedNotifications(tenantId, recipientIds, orders) {
  return withDb('logix_notification', async (db) => {
    const firstOrder = orders[0];
    const notifs = [
      {
        key: 'notif-1',
        type: 'ORDER_CONFIRMED',
        title: 'Đơn hàng mới đã được xác nhận',
        body: `Đơn hàng ${firstOrder?.orderNumber ?? 'SO-DEMO-0001'} đã được xác nhận và giữ tồn kho thành công.`,
        severity: 'INFO',
        entityType: 'SalesOrder',
        entityId: firstOrder?.id ?? null,
        read: false,
      },
      {
        key: 'notif-2',
        type: 'INVENTORY_LOW_STOCK',
        title: 'Cảnh báo tồn kho xuống thấp',
        body: 'Một số sản phẩm tại Kho Phân Phối Hà Nội đang dưới ngưỡng tồn kho tối thiểu.',
        severity: 'WARNING',
        entityType: 'InventoryBalance',
        entityId: null,
        read: false,
      },
      {
        key: 'notif-3',
        type: 'DELIVERY_COMPLETED',
        title: 'Chuyến giao hàng TRP-DEMO-0001 đã hoàn tất',
        body: 'Tài xế đã xác nhận giao hàng thành công cho toàn bộ các điểm dừng trên chuyến.',
        severity: 'INFO',
        entityType: 'DeliveryTrip',
        entityId: detUuid(`trip:${tenantId}:trip-completed`),
        read: true,
      },
    ];

    for (const n of notifs) {
      const nid = detUuid(`notif:${tenantId}:${n.key}`);
      await db.query(
        `INSERT INTO notification.notifications
           (id, tenant_id, type, title, body, severity, entity_type, entity_id, deduplication_key, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [nid, tenantId, n.type, n.title, n.body, n.severity, n.entityType, n.entityId, `demo-${n.key}`, JSON.stringify({ seeded: true })],
      );

      for (const uid of recipientIds) {
        const rid = detUuid(`nrec:${nid}:${uid}`);
        await db.query(
          `INSERT INTO notification.notification_recipients
             (id, tenant_id, notification_id, recipient_type, recipient_id, read_at)
           VALUES ($1, $2, $3, 'USER', $4, CASE WHEN $5 THEN now() - interval '1 hour' ELSE NULL END)
           ON CONFLICT (tenant_id, notification_id, recipient_type, recipient_id) DO NOTHING`,
          [rid, tenantId, nid, uid, n.read],
        );
        await db.query(
          `INSERT INTO notification.notification_deliveries
             (id, notification_recipient_id, channel, status, attempt_count, sent_at)
           VALUES ($1, $2, 'IN_APP', 'SENT', 1, now())
           ON CONFLICT (notification_recipient_id, channel) DO NOTHING`,
          [detUuid(`ndel:${rid}`), rid],
        );
      }
    }

    console.log(`✅ [Notification] Đã seed ${notifs.length} notifications cho ${recipientIds.length} người dùng.`);
  });
}

async function seedAuditLogs(tenantId, actorId, orders) {
  return withDb('logix_audit', async (db) => {
    const sharedCorr = detUuid(`corr:audit:e2e:${tenantId}`);
    const firstOrder = orders[0];
    const entries = [
      {
        key: 'aud-1',
        actorType: 'USER',
        action: 'IDENTITY_LOGIN_SUCCEEDED',
        entityType: 'User',
        entityId: actorId,
        outcome: 'SUCCESS',
        sourceService: 'identity-service',
        corr: detUuid(`corr:audit:login:${tenantId}`),
        after: { email: 'superadmin@logix.vn', tenantCode: 'LOGIX_DEFAULT' },
      },
      {
        key: 'aud-2',
        actorType: 'USER',
        action: 'ORDER_CREATED',
        entityType: 'SalesOrder',
        entityId: firstOrder?.id ?? detUuid('ord-fallback'),
        outcome: 'SUCCESS',
        sourceService: 'order-service',
        corr: sharedCorr,
        after: { orderNumber: firstOrder?.orderNumber ?? 'SO-DEMO-0001', status: 'DRAFT' },
      },
      {
        key: 'aud-3',
        actorType: 'USER',
        action: 'ORDER_CONFIRMED',
        entityType: 'SalesOrder',
        entityId: firstOrder?.id ?? detUuid('ord-fallback'),
        outcome: 'SUCCESS',
        sourceService: 'order-service',
        corr: sharedCorr,
        after: { orderNumber: firstOrder?.orderNumber ?? 'SO-DEMO-0001', status: 'CONFIRMED' },
      },
      {
        key: 'aud-4',
        actorType: 'SYSTEM',
        action: 'INVENTORY_RESERVED',
        entityType: 'ReservationGroup',
        entityId: firstOrder?.reservationGroupId ?? detUuid('res-fallback'),
        outcome: 'SUCCESS',
        sourceService: 'inventory-service',
        corr: sharedCorr,
        after: { orderNumber: firstOrder?.orderNumber ?? 'SO-DEMO-0001', status: 'RESERVED' },
      },
      {
        key: 'aud-5',
        actorType: 'SYSTEM',
        action: 'SHIPMENT_DELIVERED',
        entityType: 'Shipment',
        entityId: detUuid(`ship:${tenantId}:ord-1`),
        outcome: 'SUCCESS',
        sourceService: 'fulfillment-service',
        corr: sharedCorr,
        after: { shipmentNumber: 'SHP-DEMO-0001', status: 'DELIVERED' },
      },
      {
        key: 'aud-6',
        actorType: 'AGENT',
        action: 'AGENT_TOOL_CALLED',
        entityType: 'ToolCall',
        entityId: detUuid(`tool:${tenantId}:1`),
        outcome: 'SUCCESS',
        sourceService: 'agent-service',
        corr: detUuid(`corr:audit:agent:${tenantId}`),
        after: { toolName: 'get_stock_summary', durationMs: 142 },
      },
    ];

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const eventId = detUuid(`audevt:${tenantId}:${e.key}`);
      await db.query(
        `INSERT INTO audit.audit_logs
           (id, tenant_id, actor_id, actor_type, action, entity_type, entity_id, outcome,
            after_data, metadata, correlation_id, source_service, source_event_id, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, now() - ($14 || ' minutes')::interval)
         ON CONFLICT (id) DO NOTHING`,
        [
          detUuid(`audlog:${tenantId}:${e.key}`),
          tenantId,
          e.actorType === 'SYSTEM' ? null : actorId,
          e.actorType,
          e.action,
          e.entityType,
          e.entityId,
          e.outcome,
          JSON.stringify(e.after),
          JSON.stringify({ seeded: true }),
          e.corr,
          e.sourceService,
          eventId,
          String((entries.length - i) * 15),
        ],
      );
    }

    console.log(`✅ [Audit] Đã seed ${entries.length} audit_logs đa dịch vụ (có chuỗi correlation_id mẫu).`);
  });
}

async function main() {
  console.log(`\n🚀 BẮT ĐẦU SEED TOÀN HỆ THỐNG LOGIX (${PGHOST}:${PGPORT})...\n`);

  // 1. Identity: Permissions + Super Admin + Default Tenant
  const identityUrl = `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${PGPORT}/logix_identity?schema=identity${PGSSLMODE !== 'disable' ? '&sslmode=require' : ''}`;
  runSubScript('apps/identity-service/prisma/seed.js', { DATABASE_URL: identityUrl });

  // 1b. Identity extras: demo staff/admin/driver users + contact leads
  const { tenant, superAdmin, demoUsers } = await seedIdentityExtras();

  // 2. Master Data: warehouses, products, customers, shipping addresses, suppliers, vehicles, drivers
  runSubScript('scripts/seed-master-data.mjs');
  const driverUser = demoUsers.find((u) => u.email === 'driver@logix.vn');
  const master = await seedAndLoadMasterData(tenant.id, driverUser?.id ?? null);

  // 3. Inventory: balances, stock receipts & movements
  await seedInventory(tenant.id, superAdmin.id, master);

  // 4. Orders: 6 sales orders across full lifecycle
  const orders = await seedOrders(tenant.id, superAdmin.id, master);

  // 5. Fulfillment: shipments + items + status history
  const shipments = await seedFulfillment(tenant.id, superAdmin.id, orders);

  // 6. Transport: delivery trips + trip shipments + stops + delivery attempts
  await seedTransport(tenant.id, master, shipments);

  // 7. Notification: notifications + recipients + deliveries
  const allRecipientIds = [superAdmin.id, ...demoUsers.map((u) => u.id)];
  await seedNotifications(tenant.id, allRecipientIds, orders);

  // 8. Audit: cross-service immutable audit logs
  await seedAuditLogs(tenant.id, superAdmin.id, orders);

  // 9. Forecast: historical demand & baseline forecast data
  try {
    runSubScript('scripts/seed-forecast-data.mjs');
  } catch (err) {
    console.warn(`⚠️ [Forecast] Bỏ qua seed forecast (${err instanceof Error ? err.message : String(err)})`);
  }

  console.log('\n🎉 HOÀN TẤT SEED TOÀN BỘ DỮ LIỆU MẪU CHO LOGIX!');
  console.log('   👑 Super Admin : superadmin@logix.vn / SuperAdmin@123456');
  console.log('   👤 Demo Users  : admin@logix.vn | staff@logix.vn | driver@logix.vn (Pass: LogiX@123456)\n');
}

main().catch((err) => {
  console.error('❌ Lỗi khi seed toàn hệ thống:', err);
  process.exit(1);
});
