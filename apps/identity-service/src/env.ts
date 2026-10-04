import dotenv from 'dotenv';
import path from 'path';

// Nạp biến môi trường đồng bộ trước khi bất kỳ module nào được import trong ESM
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), 'apps/identity-service/.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Hỗ trợ serialize BigInt (cho các cột version, id BigInt trong Prisma) sang JSON an toàn
(BigInt.prototype as any).toJSON = function () {
    const intVal = Number(this);
    return Number.isSafeInteger(intVal) ? intVal : this.toString();
};
