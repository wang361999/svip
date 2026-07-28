/**
 * 验证码存储与管理
 * 使用 Prisma Client 类型安全查询，彻底废弃 $queryRawUnsafe
 */
import { prisma } from './prisma';

/** 生成6位随机数字验证码 */
export function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * 存储验证码（写入数据库）
 * 同一邮箱+类型只保留最新一条，先删旧再插新
 */
export async function storeCode(email: string, type: string): Promise<string> {
  const code = generateCode();
  const now = new Date();
  const expiry = new Date(now.getTime() + 5 * 60 * 1000); // 5分钟有效

  // 先删除该邮箱+类型的旧验证码
  await prisma.verificationCode.deleteMany({
    where: { email, type },
  });

  // 插入新验证码
  await prisma.verificationCode.create({
    data: { email, code, type, expiry },
  });

  return code;
}

/**
 * 验证验证码（一次性使用，验证后自动删除）
 */
export async function verifyCode(email: string, code: string, expectedType: string): Promise<boolean> {
  const record = await prisma.verificationCode.findFirst({
    where: { email, type: expectedType },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) return false;

  // 过期检查
  if (new Date() > record.expiry) {
    await prisma.verificationCode.delete({ where: { id: record.id } }).catch(() => {});
    return false;
  }

  // 验证码匹配检查
  if (record.code !== code) return false;

  // 验证通过后删除（一次性使用）
  await prisma.verificationCode.delete({ where: { id: record.id } }).catch(() => {});
  return true;
}

/**
 * 获取上次发送时间（用于频率限制，返回时间戳毫秒）
 */
export async function getLastSent(email: string): Promise<number> {
  const record = await prisma.verificationCode.findFirst({
    where: { email },
    orderBy: { lastSent: 'desc' },
    select: { lastSent: true },
  });

  if (!record) return 0;
  return new Date(record.lastSent).getTime();
}
