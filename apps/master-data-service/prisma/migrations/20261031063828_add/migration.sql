-- CreateTable
CREATE TABLE "master_data_code_sequences" (
    "tenant_id" UUID NOT NULL,
    "code_type" VARCHAR(20) NOT NULL,
    "last_value" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_master_data_code_sequences" PRIMARY KEY ("tenant_id","code_type")
);
