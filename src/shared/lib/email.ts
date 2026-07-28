import nodemailer from 'nodemailer';
import { prisma } from './prisma';

export interface EmailConfig {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
}

/**
 * 从数据库或环境变量获取 SMTP 配置
 * 优先读数据库 SiteSetting，回退到环境变量
 */
export async function getEmailConfig(): Promise<EmailConfig | null> {
  try {
    const setting = await prisma.siteSetting.findUnique({
      where: { id: 'main' },
      select: {
        smtpHost: true,
        smtpPort: true,
        smtpSecure: true,
        smtpUser: true,
        smtpPass: true,
        smtpFrom: true,
      },
    });

    if (setting?.smtpHost && setting?.smtpUser && setting?.smtpPass) {
      return {
        smtpHost: setting.smtpHost,
        smtpPort: parseInt(setting.smtpPort || '465', 10),
        smtpSecure: setting.smtpSecure !== 'false',
        smtpUser: setting.smtpUser,
        smtpPass: setting.smtpPass,
        smtpFrom: setting.smtpFrom || setting.smtpUser,
      };
    }
  } catch {
    // 数据库未初始化或字段不存在，回退到环境变量
  }

  // 回退到环境变量
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return {
    smtpHost: host,
    smtpPort: Number(process.env.SMTP_PORT) || 465,
    smtpSecure: process.env.SMTP_SECURE !== 'false',
    smtpUser: user,
    smtpPass: pass,
    smtpFrom: process.env.SMTP_FROM || user,
  };
}

/**
 * 创建 SMTP 传输器
 */
export async function createTransporter() {
  const config = await getEmailConfig();
  if (!config) {
    throw new Error('邮件服务未配置，请先配置 SMTP');
  }

  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
    // 解决 QQ 邮箱 502 Invalid parameters 错误
    connectionTimeout: 10000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
  });
}

/**
 * 发送注册验证码邮件
 */
export async function sendVerificationEmail(email: string, code: string) {
  const config = await getEmailConfig();
  if (!config) throw new Error('邮件服务未配置');

  const transporter = await createTransporter();

  const htmlContent = `
    <div style="max-width:480px;margin:0 auto;background:#1a1a2e;border-radius:16px;overflow:hidden;font-family:'Segoe UI',Arial,sans-serif;">
      <div style="background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);padding:32px;text-align:center;">
        <h1 style="color:#e0e0ff;margin:0;font-size:24px;">ETH Trading Tool</h1>
        <p style="color:#a0a0cc;margin:8px 0 0;font-size:14px;">邮箱验证码</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#c0c0dd;font-size:16px;margin:0 0 20px;">您好，感谢注册 ETH Trading Tool！</p>
        <p style="color:#c0c0dd;font-size:16px;margin:0 0 20px;">您的验证码是：</p>
        <div style="text-align:center;margin:24px 0;">
          <span style="display:inline-block;background:#2d2d5e;color:#7c7cff;font-size:32px;font-weight:bold;letter-spacing:8px;padding:16px 32px;border-radius:12px;">
            ${code}
          </span>
        </div>
        <p style="color:#808099;font-size:14px;margin:20px 0 0;">验证码有效期为 <strong style="color:#a0a0cc;">5分钟</strong>，请尽快完成验证。</p>
        <p style="color:#808099;font-size:14px;margin:8px 0 0;">如果这不是您本人的操作，请忽略此邮件。</p>
      </div>
      <div style="background:#12122a;padding:16px;text-align:center;">
        <p style="color:#606080;font-size:12px;margin:0;">此邮件由系统自动发送，请勿回复。</p>
      </div>
    </div>
  `;

  // 格式化发件人：确保 from 包含邮箱地址，解决 SMTP 502 错误
  const fromAddr = config.smtpFrom.includes('@')
    ? config.smtpFrom
    : `${config.smtpFrom} <${config.smtpUser}>`;

  await transporter.sendMail({
    from: fromAddr,
    to: email,
    subject: 'ETH Trading Tool - 注册验证码',
    html: htmlContent,
  });
}

/**
 * 发送找回密码验证码邮件
 */
export async function sendPasswordResetEmail(email: string, code: string) {
  const config = await getEmailConfig();
  if (!config) throw new Error('邮件服务未配置');

  const transporter = await createTransporter();

  const htmlContent = `
    <div style="max-width:480px;margin:0 auto;background:#1a1a2e;border-radius:16px;overflow:hidden;font-family:'Segoe UI',Arial,sans-serif;">
      <div style="background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);padding:32px;text-align:center;">
        <h1 style="color:#e0e0ff;margin:0;font-size:24px;">ETH Trading Tool</h1>
        <p style="color:#a0a0cc;margin:8px 0 0;font-size:14px;">找回密码</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#c0c0dd;font-size:16px;margin:0 0 20px;">您好，我们收到了您的密码重置请求。</p>
        <p style="color:#c0c0dd;font-size:16px;margin:0 0 20px;">您的验证码是：</p>
        <div style="text-align:center;margin:24px 0;">
          <span style="display:inline-block;background:#2d2d5e;color:#7c7cff;font-size:32px;font-weight:bold;letter-spacing:8px;padding:16px 32px;border-radius:12px;">
            ${code}
          </span>
        </div>
        <p style="color:#808099;font-size:14px;margin:20px 0 0;">验证码有效期为 <strong style="color:#a0a0cc;">5分钟</strong>，请尽快完成密码重置。</p>
        <p style="color:#808099;font-size:14px;margin:8px 0 0;">如果这不是您本人的操作，请忽略此邮件，您的密码不会被更改。</p>
      </div>
      <div style="background:#12122a;padding:16px;text-align:center;">
        <p style="color:#606080;font-size:12px;margin:0;">此邮件由系统自动发送，请勿回复。</p>
      </div>
    </div>
  `;

  const fromAddr = config.smtpFrom.includes('@')
    ? config.smtpFrom
    : `${config.smtpFrom} <${config.smtpUser}>`;

  await transporter.sendMail({
    from: fromAddr,
    to: email,
    subject: 'ETH Trading Tool - 找回密码验证码',
    html: htmlContent,
  });
}

/**
 * 发送测试邮件
 */
export async function sendTestEmail(toEmail: string) {
  const config = await getEmailConfig();
  if (!config) throw new Error('邮件服务未配置');

  const transporter = await createTransporter();

  const fromAddr = config.smtpFrom.includes('@')
    ? config.smtpFrom
    : `${config.smtpFrom} <${config.smtpUser}>`;

  await transporter.sendMail({
    from: fromAddr,
    to: toEmail,
    subject: 'ETH Trading Tool - 邮件测试',
    html: `
      <div style="max-width:480px;margin:0 auto;background:#1a1a2e;border-radius:16px;overflow:hidden;font-family:'Segoe UI',Arial,sans-serif;">
        <div style="background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);padding:32px;text-align:center;">
          <h1 style="color:#e0e0ff;margin:0;font-size:24px;">ETH Trading Tool</h1>
          <p style="color:#a0a0cc;margin:8px 0 0;font-size:14px;">邮件服务测试</p>
        </div>
        <div style="padding:32px;">
          <p style="color:#c0c0dd;font-size:16px;margin:0 0 20px;">恭喜！您的邮件服务配置成功。</p>
          <p style="color:#808099;font-size:14px;margin:20px 0 0;">如果您收到了这封邮件，说明 SMTP 配置正确，可以正常使用邮箱验证码功能。</p>
        </div>
      </div>
    `,
  });
}
