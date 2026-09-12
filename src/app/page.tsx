import { getSiteSettings } from '@/shared/lib/settings';
import HomeClient from './HomeClient';

export default async function HomePage() {
  let settings = {
    siteTitle: 'ETH Trading Tool',
    siteSubtitle: '个人技术研究用途 · 不提供投资建议 · 不构成任何交易服务',
  };

  try {
    settings = await getSiteSettings();
  } catch {}

  return <HomeClient title={settings.siteTitle} subtitle={settings.siteSubtitle} />;
}