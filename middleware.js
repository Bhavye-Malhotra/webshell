import { NextResponse } from 'next/server';

// Opt-in basic auth for the exec route (applies when WEBSHELL_USER/WEBSHELL_PASS
// are set). The custom server (server.js) guards its own WS/SSE paths itself.
export function middleware(req) {
  const user = process.env.WEBSHELL_USER;
  const pass = process.env.WEBSHELL_PASS;
  if (!user || !pass) return NextResponse.next();

  const header = req.headers.get('authorization') || '';
  const [scheme, b64] = header.split(' ');
  let ok = false;
  if (scheme === 'Basic' && b64) {
    try {
      const [u, p] = Buffer.from(b64, 'base64').toString().split(':');
      ok = u === user && p === pass;
    } catch { }
  }
  if (ok) return NextResponse.next();

  return new NextResponse('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="webshell"' },
  });
}

export const config = {
  matcher: ['/api/exec'],
};