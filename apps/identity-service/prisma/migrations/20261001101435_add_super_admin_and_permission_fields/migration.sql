/*
  Warnings:

  - Added the required column `action` to the `permissions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `module` to the `permissions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `name` to the `permissions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `resource` to the `permissions` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "permissions" ADD COLUMN     "action" VARCHAR(50) NOT NULL,
ADD COLUMN     "module" VARCHAR(50) NOT NULL,
ADD COLUMN     "name" VARCHAR(150) NOT NULL,
ADD COLUMN     "resource" VARCHAR(50) NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_super_admin" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "ix_permissions_module_resource" ON "permissions"("module", "resource");
