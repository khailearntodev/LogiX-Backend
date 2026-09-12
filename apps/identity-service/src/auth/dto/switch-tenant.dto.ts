import { IsNotEmpty, IsString } from 'class-validator';

export class SwitchTenantDto {
  @IsString()
  @IsNotEmpty({ message: 'Mã Tenant không được để trống' })
  tenantId!: string;
}
