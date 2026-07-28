import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // Create default admin user
  const adminPassword = await bcrypt.hash('admin', 12);
  await prisma.user.upsert({
    where: { email: 'admin@ethtrading.com' },
    update: {},
    create: {
      email: 'admin@ethtrading.com',
      username: 'admin',
      password: adminPassword,
      role: 'admin',
    },
  });

  // Create default site settings
  await prisma.siteSetting.upsert({
    where: { id: 'main' },
    update: {},
    create: {
      id: 'main',
      siteTitle: 'ETH Trading Tool',
      siteSubtitle: 'Real-time Ethereum Trading Platform',
      siteLogo: '/logo.svg',
      footerText: '© 2024 ETH Trading Tool. All rights reserved.',
      primaryColor: '#3b82f6',
    },
  });

  console.log('Seed data created successfully');
  console.log('Admin account: admin@ethtrading.com / admin');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });