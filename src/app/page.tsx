import { getSiteSettings } from '@/shared/lib/settings';
import HomeClient from './HomeClient';

export default async function HomePage() {
  let settings = {
    siteTitle: 'ETH Trading Tool',
    siteSubtitle: '回测验证的 BTC / ETH 手动交易决策系统 · 信号 · 结构位 · 风控',
  };

  try {
    settings = await getSiteSettings();
  } catch {}

  return <HomeClient title={settings.siteTitle} subtitle={settings.siteSubtitle} />;
}