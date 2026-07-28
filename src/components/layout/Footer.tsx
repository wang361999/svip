'use client';

import { useEffect, useState } from 'react';
import { apiGet } from '@/shared/api/client';

export default function Footer() {
  const [settings, setSettings] = useState({
    footerText: '© 2024 ETH Trading Tool. All rights reserved.',
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await apiGet<{ footerText?: string }>('/api/settings');
        if (cancelled) return;
        setSettings({
          footerText: settings.footerText || '© 2024 ETH Trading Tool. All rights reserved.',
        });
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <footer className="border-t border-dark-800 bg-dark-900/50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-dark-400 text-sm">{settings.footerText}</p>
          <div className="flex items-center space-x-4 text-sm text-dark-500">
            <span>Data from Binance</span>
            <span className="text-dark-700">|</span>
            <span>Powered by Vercel</span>
          </div>
        </div>
      </div>
    </footer>
  );
}