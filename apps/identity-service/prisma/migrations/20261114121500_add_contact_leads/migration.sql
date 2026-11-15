-- CreateTable
CREATE TABLE "contact_leads" (
    "id" UUID NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "phone_number" VARCHAR(50),
    "company_name" VARCHAR(255) NOT NULL,
    "needs" VARCHAR(50)[],
    "other_need_detail" TEXT,
    "status" VARCHAR(30) NOT NULL DEFAULT 'NEW',
    "contacted_at" TIMESTAMPTZ(6),
    "contacted_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_contact_leads_status_created" ON "contact_leads"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_contact_leads_email" ON "contact_leads"("email");

-- AddForeignKey
ALTER TABLE "contact_leads" ADD CONSTRAINT "contact_leads_contacted_by_fkey" FOREIGN KEY ("contacted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

