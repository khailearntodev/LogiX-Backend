import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { MailService } from '../../mail/services/mail.service.js';
import {
  ADMIN_MAX_OFFSET,
  AdminContactLeadStatus,
  ContactNeedCategory,
} from '../admin.constants.js';
import {
  SendContactLeadEmailDto,
  UpdateContactLeadStatusDto,
} from '../dto/contact-lead-action.dto.js';
import { CreateContactLeadDto } from '../dto/create-contact-lead.dto.js';
import { ListContactLeadsQueryDto } from '../dto/list-admin-query.dto.js';

const CONTACT_LEAD_SELECT = {
  id: true,
  fullName: true,
  email: true,
  phoneNumber: true,
  companyName: true,
  needs: true,
  otherNeedDetail: true,
  status: true,
  contactedAt: true,
  createdAt: true,
  updatedAt: true,
  contactedByUser: {
    select: {
      id: true,
      displayName: true,
      email: true,
      avatarUrl: true,
    },
  },
} satisfies Prisma.ContactLeadSelect;

@Injectable()
export class AdminContactLeadsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MailService) private readonly mailService: MailService,
  ) {}

  async createContactLead(dto: CreateContactLeadDto) {
    const hasOther = dto.needs.includes(ContactNeedCategory.OTHER);
    const otherNeedDetail = hasOther
      ? (dto.otherNeedDetail?.trim() ?? null)
      : null;

    if (hasOther && !otherNeedDetail) {
      throw new BadRequestException(
        'Vui lòng nhập mô tả chi tiết khi chọn nhu cầu Khác',
      );
    }

    return this.prisma.contactLead.create({
      data: {
        fullName: dto.fullName.trim(),
        email: dto.email.trim().toLowerCase(),
        phoneNumber: dto.phoneNumber?.trim() || null,
        companyName: dto.companyName.trim(),
        needs: dto.needs,
        otherNeedDetail,
        status: AdminContactLeadStatus.NEW,
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
      },
    });
  }

  async listContactLeads(query: ListContactLeadsQueryDto) {
    const skip = this.offset(query);
    const where: Prisma.ContactLeadWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { fullName: { contains: query.q, mode: 'insensitive' } },
              { email: { contains: query.q, mode: 'insensitive' } },
              { companyName: { contains: query.q, mode: 'insensitive' } },
              { phoneNumber: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction(
      [
        this.prisma.contactLead.findMany({
          where,
          skip,
          take: query.pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          select: CONTACT_LEAD_SELECT,
        }),
        this.prisma.contactLead.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  async updateContactLeadStatus(
    id: string,
    dto: UpdateContactLeadStatusDto,
    actorUserId: string,
  ) {
    const existing = await this.prisma.contactLead.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException('Không tìm thấy thông tin khách hàng liên hệ');
    }

    const markContacted =
      dto.status === AdminContactLeadStatus.CONTACTED ||
      dto.status === AdminContactLeadStatus.QUALIFIED;

    return this.prisma.contactLead.update({
      where: { id },
      data: {
        status: dto.status,
        ...(markContacted
          ? {
              contactedAt: new Date(),
              contactedBy: actorUserId,
            }
          : {}),
      },
      select: CONTACT_LEAD_SELECT,
    });
  }

  async sendEmailToContactLead(
    id: string,
    dto: SendContactLeadEmailDto,
    actorUserId: string,
  ) {
    const lead = await this.prisma.contactLead.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        email: true,
        companyName: true,
        status: true,
      },
    });
    if (!lead) {
      throw new NotFoundException('Không tìm thấy thông tin khách hàng liên hệ');
    }

    const sent = await this.mailService.sendContactLeadReplyEmail({
      toEmail: lead.email,
      recipientName: lead.fullName,
      companyName: lead.companyName,
      subject: dto.subject,
      message: dto.message,
    });

    if (!sent) {
      throw new ServiceUnavailableException({
        message:
          'Dịch vụ gửi email (SMTP) hiện chưa khả dụng. Vui lòng sử dụng nút mở ứng dụng email trực tiếp.',
        code: 'MAIL_DELIVERY_FAILED',
      });
    }

    const nextStatus =
      lead.status === AdminContactLeadStatus.NEW
        ? AdminContactLeadStatus.CONTACTED
        : lead.status;

    return this.prisma.contactLead.update({
      where: { id },
      data: {
        status: nextStatus,
        contactedAt: new Date(),
        contactedBy: actorUserId,
      },
      select: CONTACT_LEAD_SELECT,
    });
  }

  private offset({
    page,
    pageSize,
  }: {
    page: number;
    pageSize: number;
  }): number {
    const skip = (page - 1) * pageSize;
    if (!Number.isSafeInteger(skip) || skip < 0 || skip > ADMIN_MAX_OFFSET) {
      throw new BadRequestException(
        'Pagination offset exceeds the supported range',
      );
    }
    return skip;
  }
}

