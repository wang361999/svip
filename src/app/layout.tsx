import type { Metadata, Viewport } from 'next';
import './globals.css';
import { getSiteSettings } from '@/shared/lib/settings';
import CacheBuster from '@/components/CacheBuster';

export const viewport: Viewport = {
  width: 1280,
  initialScale: 0.25,
  minimumScale: 0.25,
  // 禁止缩放：手机上聚焦搜索框（币种选择器）时 iOS 不再自动放大页面
  // （交易图表类应用标准做法 — 图表与面板布局固定，缩放后反而溢出难用）
  maximumScale: 1,
  userScalable: false,
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
