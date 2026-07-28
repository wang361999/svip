import { prisma } from './prisma';

export async function getSiteSettings() {
  let settings = await prisma.siteSetting.findUnique({
    where: { id: 'main' },
  });

  if (!settings) {
    settings = await prisma.siteSetting.create({
      data: {
        id: 'main',
        siteTitle: 'ETH Trading Tool',
        siteSubtitle: 'Real-time Ethereum Trading Platform',
        siteLogo: '/logo.svg',
        footerText: '© 2024 ETH Trading Tool. All rights reserved.',
        primaryColor: '#3b82f6',
      },
    });
  }

  return settings;
}