import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const require = createRequire(resolve(__dirname, '../apps/master-data-service/package.json'));
const { Client } = require('pg');

const DB_CONFIG = {
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5433', 10),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
};

function deterministicUuid(namespaceKey) {
  const hash = crypto.createHash('sha256').update(namespaceKey).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    '8' + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

function formatDate(dateObj) {
  const y = dateObj.getUTCFullYear();
  const m = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Generates realistic daily B2B demand observations ending on 2026-11-14
 * with weekly seasonality, positive trend, and deterministic pseudo-noise.
 */
function buildDemandSeries({ days, baseDemand, dailyTrend, seedOffset, endDateStr = '2026-11-14' }) {
  const weeklyFactors = [0.85, 0.95, 1.02, 1.08, 1.18, 1.28, 0.72];
  const endDate = new Date(`${endDateStr}T00:00:00Z`);
  const observations = [];

  for (let idx = 0; idx < days; idx++) {
    const currDate = new Date(endDate);
    currDate.setUTCDate(endDate.getUTCDate() - (days - 1 - idx));
    const dayOfWeek = currDate.getUTCDay(); // 0=Sun..6=Sat
    const factor = weeklyFactors[dayOfWeek];
    const wave = Math.sin((idx + seedOffset) * 0.65) * (baseDemand * 0.06);
    const rawQty = (baseDemand + dailyTrend * idx) * factor + wave;
    const qty = Math.max(4, Math.round(rawQty * 10) / 10);

    observations.push({
      demandDate: formatDate(currDate),
      fulfilledQuantity: qty,
    });
  }

  return observations;
}

const PRIORITY_PROPHET_SKUS = new Set([
  'DEMO-NHUA',
  'DEMO-AMDIEN',
  'DEMO-GAO25',
  'SP-PP-25K',
  'SP-GAO-25K',
  'SP-SN-18L',
]);

async function seedForecastAndBalances() {
  console.log('🚀 Kết nối PostgreSQL (port 5433) để seed dữ liệu Forecast & Inventory Balances...');

  const identityClient = new Client({ ...DB_CONFIG, database: 'logix_identity' });
  const masterClient = new Client({ ...DB_CONFIG, database: 'logix_master_data' });
  const inventoryClient = new Client({ ...DB_CONFIG, database: 'logix_inventory' });
  const forecastClient = new Client({ ...DB_CONFIG, database: 'logix_forecast' });

  try {
    await Promise.all([
      identityClient.connect(),
      masterClient.connect(),
      inventoryClient.connect(),
      forecastClient.connect(),
    ]);

    const tenantsRes = await identityClient.query(`
      SELECT id, code, name
      FROM identity.tenants
      WHERE status = 'ACTIVE' AND deleted_at IS NULL
      ORDER BY created_at ASC;
    `);

    if (tenantsRes.rows.length === 0) {
      console.warn('⚠️ Không tìm thấy tenant ACTIVE nào.');
      return;
    }

    for (const tenant of tenantsRes.rows) {
      const whRes = await masterClient.query(
        `
          SELECT id, code, name
          FROM master_data.warehouses
          WHERE tenant_id = $1 AND deleted_at IS NULL
          ORDER BY created_at DESC;
        `,
        [tenant.id]
      );

      const prodRes = await masterClient.query(
        `
          SELECT id, sku, name
          FROM master_data.products
          WHERE tenant_id = $1 AND deleted_at IS NULL
          ORDER BY created_at DESC;
        `,
        [tenant.id]
      );

      if (whRes.rows.length === 0 || prodRes.rows.length === 0) {
        console.log(`ℹ️ Tenant "${tenant.name}" chưa có kho hoặc sản phẩm, bỏ qua.`);
        continue;
      }

      console.log(
        `\n📦 Tenant "${tenant.name}" (${tenant.code}): ${whRes.rows.length} kho, ${prodRes.rows.length} sản phẩm`
      );

      // Clear old seeded demand_observations for this tenant to avoid duplicates
      await forecastClient.query(
        `DELETE FROM forecast.demand_observations WHERE tenant_id = $1;`,
        [tenant.id]
      );

      let balanceUpsertCount = 0;
      let observationInsertCount = 0;

      for (let wIdx = 0; wIdx < whRes.rows.length; wIdx++) {
        const wh = whRes.rows[wIdx];

        for (let pIdx = 0; pIdx < prodRes.rows.length; pIdx++) {
          const prod = prodRes.rows[pIdx];

          // Determine realistic stock level:
          // Make DEMO-NHUA and every 3rd product have tight stock (~340-460 units) so stockout risk is demonstrated,
          // and other products have comfortable stock (~820-1150 units).
          const isTightStock = prod.sku === 'DEMO-NHUA' || pIdx % 3 === 0;
          const onHandQty = isTightStock
            ? 360 + ((wIdx * 35 + pIdx * 15) % 140)
            : 850 + ((wIdx * 50 + pIdx * 25) % 350);
          const reservedQty = isTightStock ? 40 : 30;
          const lowStockThreshold = 150;

          const balanceId = deterministicUuid(`balance:${tenant.id}:${wh.id}:${prod.id}`);
          await inventoryClient.query(
            `
              INSERT INTO inventory.inventory_balances (
                id, tenant_id, warehouse_id, product_id,
                on_hand_quantity, reserved_quantity, low_stock_threshold, version
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
              ON CONFLICT (tenant_id, warehouse_id, product_id) DO UPDATE SET
                on_hand_quantity = CASE
                  WHEN inventory.inventory_balances.on_hand_quantity = 0 THEN EXCLUDED.on_hand_quantity
                  ELSE inventory.inventory_balances.on_hand_quantity
                END,
                deleted_at = NULL;
            `,
            [balanceId, tenant.id, wh.id, prod.id, onHandQty, reservedQty, lowStockThreshold]
          );
          balanceUpsertCount++;

          // Decide observation window length:
          // - Top default product (pIdx === 0) + PRIORITY_PROPHET_SKUS get 56 days (runs official Meta Prophet)
          // - Other products get 12 days (runs ultra-fast Moving Average 7 in <1ms so stockout-risks endpoint stays fast while every SKU still has data)
          const useFullProphetHistory = pIdx === 0 || PRIORITY_PROPHET_SKUS.has(prod.sku);
          const days = useFullProphetHistory ? 56 : 12;
          const baseDemand = prod.sku === 'DEMO-NHUA'
            ? 38 + (wIdx % 4) * 3
            : 26 + ((pIdx * 5 + wIdx * 3) % 24);
          const dailyTrend = prod.sku === 'DEMO-NHUA'
            ? 0.28
            : 0.12 + ((pIdx % 5) * 0.04);

          const series = buildDemandSeries({
            days,
            baseDemand,
            dailyTrend,
            seedOffset: wIdx * 17 + pIdx * 7,
            endDateStr: '2026-11-14',
          });

          // Batch insert demand observations for this (warehouse, product)
          const valuesSql = [];
          const params = [];
          let paramIdx = 1;

          for (let dIdx = 0; dIdx < series.length; dIdx++) {
            const pt = series[dIdx];
            const obsId = deterministicUuid(`obs:${tenant.id}:${wh.id}:${prod.id}:${pt.demandDate}`);
            const eventId = deterministicUuid(`evt:${tenant.id}:${wh.id}:${prod.id}:${pt.demandDate}`);
            const orderId = deterministicUuid(`ord:${tenant.id}:${wh.id}:${prod.id}:${pt.demandDate}`);
            const sourceVersion = dIdx + 1;

            valuesSql.push(
              `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, 1)`
            );
            params.push(
              obsId,
              tenant.id,
              wh.id,
              prod.id,
              pt.demandDate,
              pt.fulfilledQuantity,
              eventId,
              orderId,
              sourceVersion
            );
          }

          await forecastClient.query(
            `
              INSERT INTO forecast.demand_observations (
                id, tenant_id, warehouse_id, product_id,
                demand_date, fulfilled_quantity,
                source_event_id, source_order_id, source_version, version
              ) VALUES ${valuesSql.join(', ')}
              ON CONFLICT DO NOTHING;
            `,
            params
          );

          observationInsertCount += series.length;
        }
      }

      console.log(
        `   ✅ Đã cập nhật ${balanceUpsertCount} dòng tồn kho (inventory_balances) và chèn ${observationInsertCount} dòng lịch sử nhu cầu (demand_observations).`
      );
    }

    console.log('\n🎉 HOÀN TẤT SEED DỮ LIỆU FORECAST & INVENTORY!');
  } catch (err) {
    console.error('❌ Lỗi khi seed dữ liệu forecast:', err);
    process.exit(1);
  } finally {
    await Promise.allSettled([
      identityClient.end(),
      masterClient.end(),
      inventoryClient.end(),
      forecastClient.end(),
    ]);
  }
}

seedForecastAndBalances();
