import { Test } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service.js';
import { MailService } from '../../mail/services/mail.service.js';
import {
  AdminContactLeadStatus,
  ContactNeedCategory,
} from '../admin.constants.js';
import {
  SendContactLeadEmailDto,
  UpdateContactLeadStatusDto,
} from '../dto/contact-lead-action.dto.js';
import { CreateContactLeadDto } from '../dto/create-contact-lead.dto.js';
import { ListContactLeadsQueryDto } from '../dto/list-admin-query.dto.js';
import { AdminContactLeadsService } from './admin-contact-leads.service.js';

describe('AdminContactLeadsService', () => {
  const contactLead = {
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  };
  const transaction = vi.fn((queries: Promise<unknown>[]) =>
    Promise.all(queries),
  );
  const mailService = {
    sendContactLeadReplyEmail: vi.fn(),
  };
  let service: AdminContactLeadsService;

  beforeEach(async () => {
    vi.clearAllMocks();
    contactLead.findMany.mockResolvedValue([]);
    contactLead.count.mockResolvedValue(0);
    const module = await Test.createTestingModule({
      providers: [
        AdminContactLeadsService,
        {
          provide: PrismaService,
          useValue: { contactLead, $transaction: transaction },
        },
        {
          provide: MailService,
          useValue: mailService,
        },
      ],
    }).compile();
    service = module.get(AdminContactLeadsService);
  });

  it('creates a contact lead and normalizes otherNeedDetail when OTHER is not selected', async () => {
    const now = new Date();
    contactLead.create.mockResolvedValue({
      id: 'lead-1',
      status: AdminContactLeadStatus.NEW,
      createdAt: now,
    });
    const dto = Object.assign(new CreateContactLeadDto(), {
      fullName: '  Trần Thị B ',
      email: '  TranThiB@Company.VN ',
      phoneNumber: '',
      companyName: ' Công ty Vận tải B ',
      needs: [ContactNeedCategory.INVENTORY_WAREHOUSE],
      otherNeedDetail: 'Ignored detail',
    });

    const created = await service.createContactLead(dto);
    expect(created).toEqual({
      id: 'lead-1',
      status: AdminContactLeadStatus.NEW,
      createdAt: now,
    });
    expect(contactLead.create).toHaveBeenCalledWith({
      data: {
        fullName: 'Trần Thị B',
        email: 'tranthib@company.vn',
        phoneNumber: null,
        companyName: 'Công ty Vận tải B',
        needs: [ContactNeedCategory.INVENTORY_WAREHOUSE],
        otherNeedDetail: null,
        status: AdminContactLeadStatus.NEW,
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
      },
    });
  });

  it('lists contact leads with search and status filters in a RepeatableRead transaction', async () => {
    const query = Object.assign(new ListContactLeadsQueryDto(), {
      q: 'Ahihi',
      status: AdminContactLeadStatus.NEW,
      page: 1,
      pageSize: 20,
    });
    await service.listContactLeads(query);

    const where = {
      status: AdminContactLeadStatus.NEW,
      OR: [
        { fullName: { contains: 'Ahihi', mode: 'insensitive' } },
        { email: { contains: 'Ahihi', mode: 'insensitive' } },
        { companyName: { contains: 'Ahihi', mode: 'insensitive' } },
        { phoneNumber: { contains: 'Ahihi', mode: 'insensitive' } },
      ],
    };
    expect(contactLead.count).toHaveBeenCalledWith({ where });
    expect(contactLead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        skip: 0,
        take: 20,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
    );
    expect(transaction).toHaveBeenCalledWith(expect.any(Array), {
      isolationLevel: 'RepeatableRead',
    });
  });

  it('updates status and records contactedAt/contactedBy when transitioning to CONTACTED', async () => {
    contactLead.findUnique.mockResolvedValue({ id: 'lead-1' });
    contactLead.update.mockResolvedValue({
      id: 'lead-1',
      status: AdminContactLeadStatus.CONTACTED,
    });

    const dto = Object.assign(new UpdateContactLeadStatusDto(), {
      status: AdminContactLeadStatus.CONTACTED,
    });
    await service.updateContactLeadStatus('lead-1', dto, 'super-admin-id');

    expect(contactLead.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'lead-1' },
        data: expect.objectContaining({
          status: AdminContactLeadStatus.CONTACTED,
          contactedBy: 'super-admin-id',
          contactedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('sends reply email via MailService and transitions NEW lead to CONTACTED', async () => {
    contactLead.findUnique.mockResolvedValue({
      id: 'lead-1',
      fullName: 'Nguyễn Văn A',
      email: 'a@company.vn',
      companyName: 'Công ty A',
      status: AdminContactLeadStatus.NEW,
    });
    mailService.sendContactLeadReplyEmail.mockResolvedValue(true);
    contactLead.update.mockResolvedValue({
      id: 'lead-1',
      status: AdminContactLeadStatus.CONTACTED,
    });

    const dto = Object.assign(new SendContactLeadEmailDto(), {
      subject: '[LogiX] Xác nhận lịch demo',
      message: 'Xin chào anh A, đội ngũ LogiX xin gửi lịch hẹn demo.',
    });
    await service.sendEmailToContactLead('lead-1', dto, 'super-admin-id');

    expect(mailService.sendContactLeadReplyEmail).toHaveBeenCalledWith({
      toEmail: 'a@company.vn',
      recipientName: 'Nguyễn Văn A',
      companyName: 'Công ty A',
      subject: '[LogiX] Xác nhận lịch demo',
      message: 'Xin chào anh A, đội ngũ LogiX xin gửi lịch hẹn demo.',
    });
    expect(contactLead.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'lead-1' },
        data: expect.objectContaining({
          status: AdminContactLeadStatus.CONTACTED,
          contactedBy: 'super-admin-id',
          contactedAt: expect.any(Date),
        }),
      }),
    );
  });
});

