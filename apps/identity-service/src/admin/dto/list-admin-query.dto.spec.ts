import { ValidationPipe } from '@nestjs/common';
import { ContactNeedCategory } from '../admin.constants.js';
import { CreateContactLeadDto } from './create-contact-lead.dto.js';
import {
  ListContactLeadsQueryDto,
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
      | typeof ListUsersQueryDto
      | typeof ListContactLeadsQueryDto = ListOrganizationsQueryDto,
  ) => pipe.transform(value, { type: 'query', metatype });
  const parseBody = (value: object) =>
    pipe.transform(value, { type: 'body', metatype: CreateContactLeadDto });

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
    await expect(
      parse({ status: 'CONTACTED' }, ListContactLeadsQueryDto),
    ).resolves.toHaveProperty('status', 'CONTACTED');
    await expect(
      parse({ status: 'ACTIVE' }, ListContactLeadsQueryDto),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('validates CreateContactLeadDto including optional phone and OTHER need details', async () => {
    const valid = await parseBody({
      fullName: '  Nguyễn Văn A  ',
      email: '  TEST@Example.VN ',
      phoneNumber: '   ',
      companyName: '  Công ty Logistics ABC ',
      needs: [ContactNeedCategory.ORDER_FULFILLMENT],
    });
    expect(valid).toEqual({
      fullName: 'Nguyễn Văn A',
      email: 'test@example.vn',
      phoneNumber: undefined,
      companyName: 'Công ty Logistics ABC',
      needs: [ContactNeedCategory.ORDER_FULFILLMENT],
    });

    await expect(
      parseBody({
        fullName: 'Nguyễn Văn A',
        email: 'test@example.vn',
        companyName: 'Công ty ABC',
        needs: [ContactNeedCategory.OTHER],
        otherNeedDetail: '   ',
      }),
    ).rejects.toMatchObject({ status: 400 });

    const withOther = await parseBody({
      fullName: 'Nguyễn Văn A',
      email: 'test@example.vn',
      phoneNumber: '+84 901 234 567',
      companyName: 'Công ty ABC',
      needs: [ContactNeedCategory.TRANSPORT_ROUTE, ContactNeedCategory.OTHER],
      otherNeedDetail: '  Cần tích hợp ERP nội bộ  ',
    });
    expect(withOther).toMatchObject({
      phoneNumber: '+84 901 234 567',
      otherNeedDetail: 'Cần tích hợp ERP nội bộ',
    });
  });
});
