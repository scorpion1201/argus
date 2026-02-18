import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ARGUS',
  description: 'A DERP (Designated Encrypted Relay for Packets) monitoring web UI built with Next.js that runs Tailscale "derpprobe" inside a container.'
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>
        <main id="main-app">
          {children}
        </main>
      </body>
    </html>
  );
}
