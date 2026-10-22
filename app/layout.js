import '@xterm/xterm/css/xterm.css';
import './globals.css';

export const metadata = {
  title: 'webshell',
  description: 'A stable, good-looking web-based terminal built with Next.js',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}