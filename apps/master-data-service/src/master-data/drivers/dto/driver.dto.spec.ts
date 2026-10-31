import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateDriverDto,
  EligibleDriverUsersQueryDto,
  DriverVersionDto,
  UpdateDriverDto,
  RelinkDriverUserDto,
} from './driver.dto.js';

const valid = {
  code: 'DRV',
  userId: '74cc6e08-e865-49a2-b3e7-e2ee00fc894b',
  licenseNumber: 'LICENSE',
  licenseExpiry: '2027-10-25',
};
describe('Driver DTO contract', () => {
  it('validates explicit old/new binding and trims a required bounded reason', async () => {
    const body = {
      version: 1,
      expectedUserId: valid.userId,
      userId: valid.userId,
      reason: '  correction  ',
    };
    const dto = plainToInstance(RelinkDriverUserDto, body);
    expect(await validate(dto)).toEqual([]);
    expect(dto.reason).toBe('correction');
    for (const patch of [
      { reason: '' },
      { reason: '  ' },
      { reason: null },
      { reason: 'x'.repeat(1001) },
      { expectedUserId: 'invalid' },
      { expectedUserId: null },
      { userId: null },
      { version: '1' },
      { actorId: valid.userId },
    ]) {
      expect(
        (
          await validate(
            plainToInstance(RelinkDriverUserDto, { ...body, ...patch }),
            {
              whitelist: true,
              forbidNonWhitelisted: true,
            },
          )
        ).length,
      ).toBeGreaterThan(0);
    }
  });
  it('rejects inactive-member picker filters rather than ignoring them', async () => {
    const errors = await validate(
      plainToInstance(EligibleDriverUsersQueryDto, { status: 'INACTIVE' }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors.some((error) => error.property === 'status')).toBe(true);
  });
  it('trims input without inventing an expiry policy', async () => {
    const dto = plainToInstance(CreateDriverDto, {
      ...valid,
      code: ' DRV ',
      licenseExpiry: '2020-01-01',
    });
    expect(await validate(dto)).toEqual([]);
    expect(dto.code).toBe('DRV');
  });
  it.each([
    { userId: 'other' },
    { licenseNumber: '' },
    { licenseExpiry: '2027-02-30' },
    { licenseExpiry: '2027-01-01T00:00:00Z' },
    { licenseExpiry: null },
  ])('rejects invalid create %j', async (patch) => {
    expect(
      (await validate(plainToInstance(CreateDriverDto, { ...valid, ...patch })))
        .length,
    ).toBeGreaterThan(0);
  });
  it.each([undefined, '', '   '])(
    'allows omitted or blank create code %j for backend allocation',
    async (code) => {
      const body: Record<string, unknown> = { ...valid };
      if (code === undefined) delete body.code;
      else body.code = code;
      expect(await validate(plainToInstance(CreateDriverDto, body))).toEqual(
        [],
      );
    },
  );
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null])(
    'rejects unsafe version %j',
    async (version) => {
      expect(
        (await validate(plainToInstance(DriverVersionDto, { version }))).length,
      ).toBeGreaterThan(0);
    },
  );
  it('allows code edits and nullable phone, but forbids mutable linkage and null license', async () => {
    expect(
      await validate(
        plainToInstance(UpdateDriverDto, {
          version: 1,
          phone: null,
          code: ' DRV-2 ',
        }),
      ),
    ).toEqual([]);
    expect(
      plainToInstance(UpdateDriverDto, {
        version: 1,
        code: ' DRV-2 ',
      }).code,
    ).toBe('DRV-2');
    for (const patch of [
      { userId: valid.userId },
      { licenseNumber: null },
      { licenseExpiry: null },
    ]) {
      expect(
        (
          await validate(
            plainToInstance(UpdateDriverDto, { version: 1, ...patch }),
            { whitelist: true, forbidNonWhitelisted: true },
          )
        ).length,
      ).toBeGreaterThan(0);
    }
  });
});
