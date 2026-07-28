import { getSiteSettings } from '@/shared/lib/settings';
import HomeClient from './HomeClient';

export default async function HomePage() {
  let settings = {
    siteTitle: 'ETH Trading Tool',
    siteSubtitle: 'Real-time Ethereum Trading Platform',
  };

  try {
    settings = await getSiteSettings();
  } catch {}

  return <HomeClient title={settings.siteTitle} subtitle={settings.siteSubtitle} />;
}