import type { Metadata, Viewport } from 'next';
import './globals.css';
import { getSiteSettings } from '@/shared/lib/settings';
import CacheBuster from '@/components/CacheBuster';

export const viewport: Viewport = {
  width: 1280,
  initialScale: 0.25,
  minimumScale: 0.2,
  maximumScale: 1.5,
  userScalable: true,
};

export async function generateMetadata(): Promise<Metadata> {
  try {
    const settings = await getSiteSettings();
    return {
      title: settings.siteTitle,
      description: settings.siteSubtitle,
      icons: settings.siteLogo ? { icon: settings.siteLogo } : undefined,
    };
  } catch {
    return {
      title: 'ETH Trading Tool',
      description: 'Real-time Ethereum Trading Platform',
    };
  }
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="bg-dark-950 text-dark-100 min-h-screen">
        <CacheBuster />
        {children}
      </body>
    </html>
  );
}
