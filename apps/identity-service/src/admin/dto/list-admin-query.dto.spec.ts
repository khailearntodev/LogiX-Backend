import { ValidationPipe } from '@nestjs/common';
import {
  ListOrganizationsQueryDto,
  ListUsersQueryDto,
} from './list-admin-query.dto.js';

describe('Admin query validation', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  });
  const parse = (
    value: object,
    metatype:
      | typeof ListOrganizationsQueryDto
      | typeof ListUsersQueryDto = ListOrganizationsQueryDto,
  ) => pipe.transform(value, { type: 'query', metatype });

  it('uses defaults and trims search before enforcing length', async () => {
    expect(await parse({})).toMatchObject({ page: 1, pageSize: 20 });
    expect(await parse({ q: `  ${'a'.repeat(200)}  ` })).toHaveProperty(
      'q',
      'a'.repeat(200),
    );
    expect(await parse({ q: '   ', page: '2', pageSize: '100' })).toMatchObject(
      {
        q: '',
        page: 2,
        pageSize: 100,
      },
    );
  });

  it.each([
    { page: '0' },
    { page: '-1' },
    { page: '1.5' },
    { page: '' },
    { page: '9007199254740992' },
    { page: ['1', '2'] },
    { pageSize: '0' },
    { pageSize: '101' },
    { pageSize: ['20'] },
    { q: ['search'] },
    { q: 'a'.repeat(201) },
    { status: 'INACTIVE' },
    { status: 'active' },
    { status: ['ACTIVE'] },
    { tenantId: 'untrusted-filter' },
  ])(
    'returns 400 instead of coercing/clamping invalid query %j',
    async (query) => {
      await expect(parse(query)).rejects.toMatchObject({ status: 400 });
    },
  );

  it('keeps resource status enums distinct', async () => {
    await expect(parse({ status: 'SUSPENDED' })).resolves.toHaveProperty(
      'status',
      'SUSPENDED',
    );
    await expect(parse({ status: 'LOCKED' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      parse({ status: 'LOCKED' }, ListUsersQueryDto),
    ).resolves.toHaveProperty('status', 'LOCKED');
    await expect(
      parse({ status: 'SUSPENDED' }, ListUsersQueryDto),
    ).rejects.toMatchObject({ status: 400 });
  });
});
