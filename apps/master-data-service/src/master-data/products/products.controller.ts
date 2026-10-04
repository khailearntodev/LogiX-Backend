import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface.js';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto.js';
import { RecordStatus } from '../common/master-data.constants.js';
import { ProductService } from './services/product.service.js';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto.js';

@Controller('products')
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(private readonly products: ProductService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateProductDto,
  ) {
    return this.products.create(user.tenantId, dto);
  }

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.products.list(user.tenantId, query);
  }

  @Get(':id')
  async getById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.products.getById(user.tenantId, id);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(user.tenantId, id, dto);
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  async disable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.products.setStatus(user.tenantId, id, RecordStatus.INACTIVE);
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  async enable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.products.setStatus(user.tenantId, id, RecordStatus.ACTIVE);
  }
}
