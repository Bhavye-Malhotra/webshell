/**
 * webshell — custom Next.js server.
 *
 * Next renders the UI; a WebSocket at /api/term streams a real PTY
 * (node-pty → full interactivity: vim, htop, ctrl-c, colors).
 * If node-pty failed to build, falls back to a piped child shell.
 */
const http = require('http');
const next = require('next');
const { WebSocketServer } = require('ws');

const dev = process.env.NODE_ENV !== 'production';
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// ---------------------------------------------------------------------------
// PTY backend selection
// ---------------------------------------------------------------------------
let pty = null;
let usingPty = false;
try {
  pty = require('node-pty');
  usingPty = true;
  console.log('[webshell] backend: node-pty (full TTY)');
} catch (err) {
  console.warn('[webshell] node-pty unavailable, using fallback pipe backend');
  console.warn(`[webshell]   (${err.message.split('\n')[0]})`);
}

const shell = process.env.SHELL || '/bin/zsh';
const cwd = process.env.WEBSHELL_CWD || process.cwd();

/**
 * Spawn a terminal session.
 * Returns { write, resize, onData, onExit, kill }.
 */
function createSession(cols, rows) {
  if (usingPty) {
    let term;
    try {
      term = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
    } catch (err) {
      // e.g. restricted environments that block posix_spawnp — degrade gracefully
      console.warn(`[webshell] pty spawn failed (${err.message}); using pipe fallback for this session`);
      return createPipeSession();
    }
    return {
      write: (d) => term.write(d),
      resize: (c, r) => {
        try { term.resize(Math.max(2, c | 0), Math.max(2, r | 0)); } catch { /* closing */ }
      },
      onData: (cb) => term.onData(cb),
      onExit: (cb) => term.onExit(({ exitCode }) => cb(exitCode)),
      kill: () => { try { term.kill(); } catch { /* already dead */ } },
    };
  }

  return createPipeSession();
}

function createPipeSession() {
  // Fallback: piped child shell (no raw mode, but commands run + output streams)
  const { spawn } = require('child_process');
  const child = spawn(shell, ['-i'], { cwd, env: { ...process.env, TERM: 'dumb' } });
  return {
    write: (d) => child.stdin.write(d),
    resize: () => { /* not supported */ },
    onData: (cb) => {
      child.stdout.on('data', cb);
      child.stderr.on('data', cb);
    },
    onExit: (cb) => child.on('exit', (code) => cb(code)),
    kill: () => child.kill(),
  };
}

// ---------------------------------------------------------------------------
// Next app + HTTP server
// ---------------------------------------------------------------------------
const app = next({ dev, hostname: HOST, port: PORT });
const handle = app.getRequestHandler();

// Opt-in basic auth: set WEBSHELL_USER + WEBSHELL_PASS to protect the shell
function authOk(headers) {
  const user = process.env.WEBSHELL_USER;
  const pass = process.env.WEBSHELL_PASS;
  if (!user || !pass) return true; // auth disabled
  const header = headers.authorization || '';
  const [scheme, b64] = header.split(' ');
  if (scheme !== 'Basic' || !b64) return false;
  const [u, p] = Buffer.from(b64, 'base64').toString().split(':');
  return u === user && p === pass;
}

app.prepare().then(() => {
  const upgradeHandler = app.getUpgradeHandler();

  // -------------------------------------------------------------------------
  // SSE fallback transport (works through any proxy — no Upgrade headers needed)
  // -------------------------------------------------------------------------
  const sseSessions = new Map();
  let sseCounter = 0;

  function readJsonBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 1e6) req.destroy(); // sanity cap
      });
      req.on('end', () => {
        try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
      });
      req.on('error', () => resolve({}));
    });
  }

  function sseWrite(res, obj) {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* closed */ }
  }

  async function handleSse(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/term/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ backend: usingPty ? 'pty' : 'pipe', sse: true }));
      return;
    }

    if (url.pathname === '/api/term/sse' && req.method === 'GET') {
      let session;
      try {
        session = createSession(parseInt(url.searchParams.get('cols'), 10) || 80,
                                parseInt(url.searchParams.get('rows'), 10) || 24);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Failed to start shell: ${err.message}` }));
        return;
      }

      const id = `sse-${Date.now().toString(36)}-${++sseCounter}`;
      sseSessions.set(id, { session });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // nginx: don't buffer this stream
      });
      sseWrite(res, { type: 'hello', id, backend: usingPty ? 'pty' : 'pipe' });

      session.onData((data) => sseWrite(res, { type: 'data', data }));
      session.onExit((code) => {
        sseWrite(res, { type: 'exit', code });
        res.end();
      });

      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        sseSessions.delete(id);
        session.kill();
      });
      return;
    }

    if (url.pathname === '/api/term/input' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const rec = sseSessions.get(body.id);
      if (!rec) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no such session' }));
        return;
      }
      try {
        if (body.resize) rec.session.resize(body.resize.cols, body.resize.rows);
        if (typeof body.data === 'string' && body.data.length) rec.session.write(body.data);
      } catch { /* session died mid-write */ }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end('{"ok":true}');
      return;
    }
  }

  const server = http.createServer(async (req, res) => {
    if (!authOk(req.headers)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="webshell"');
      res.statusCode = 401;
      res.end('Unauthorized');
      return;
    }
    if (req.url.startsWith('/api/term/')) {
      await handleSse(req, res);
      return;
    }
    handle(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/api/term') {
      if (!authOk(req.headers)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="webshell"\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      return;
    }

    // Hand everything else (e.g. Next dev HMR) to Next's own upgrade handler
    upgradeHandler(req, socket, head);
  });

  wss.on('connection', (ws, req) => {
    let session = null;
    let pingTimer = null;

    const cleanup = () => {
      if (pingTimer) clearInterval(pingTimer);
      session?.kill();
      session = null;
    };

    pingTimer = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping();
    }, 30000);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      switch (msg.type) {
        case 'hello':
          ws.send(JSON.stringify({ type: 'backend', backend: usingPty ? 'pty' : 'pipe' }));
          break;
        case 'start': {
          if (session) return;
          try {
            session = createSession(msg.cols, msg.rows);
          } catch (err) {
            ws.send(JSON.stringify({
              type: 'exit',
              code: -1,
              error: `Failed to start shell: ${err.message}`,
            }));
            break;
          }
          session.onData((data) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
          });
          session.onExit((code) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', code }));
            cleanup();
          });
          break;
        }
        case 'input':
          session?.write(msg.data);
          break;
        case 'resize':
          session?.resize(msg.cols, msg.rows);
          break;
        default:
          break;
      }
    });

    ws.on('close', cleanup);
    ws.on('error', () => { cleanup(); try { ws.terminate(); } catch { } });
  });

  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    console.log(`[webshell] ${dev ? 'dev' : 'prod'} server on ${url}`);
    console.log(`[webshell] shell: ${shell}  cwd: ${cwd}`);
    if (!process.env.WEBSHELL_USER) {
      console.log('[webshell] note: no auth set — bind is 127.0.0.1 only. Set WEBSHELL_USER/WEBSHELL_PASS to enable basic auth.');
    }
  });
});