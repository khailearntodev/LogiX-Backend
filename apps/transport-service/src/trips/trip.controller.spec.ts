import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { TripController } from './trip.controller.js';

describe('TripController action status codes', () => {
  it('returns HTTP 200 for assignment rather than the POST default 201', () => {
    expect(Reflect.getMetadata(
      HTTP_CODE_METADATA,
      TripController.prototype.assign,
    )).toBe(200);
  });
});
