import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

describe('Fulfillment permission catalogue', () => {
  it('seeds exactly the approved four separate permissions without executing the account seed', () => {
    const source = readFileSync(new URL('../../../prisma/seed.js', import.meta.url), 'utf8');
    const start = source.indexOf('export const SYSTEM_PERMISSIONS');
    const end = source.indexOf('];', start) + 2;
    const permissions: Array<{ code: string; module: string; resource: string }> = runInNewContext(
      source.slice(start, end).replace('export ', '') + '; SYSTEM_PERMISSIONS',
    );
    const fulfillment = permissions.filter(permission => permission.module === 'FULFILLMENT');
    expect(fulfillment.map(permission => permission.code).sort()).toEqual([
      'fulfillment:shipment:complete', 'fulfillment:shipment:dispatch',
      'fulfillment:shipment:read', 'fulfillment:shipment:update',
    ]);
    expect(fulfillment.every(permission => permission.resource === 'shipment')).toBe(true);
    expect(new Set(permissions.map(permission => permission.code)).size).toBe(permissions.length);
  });
});
