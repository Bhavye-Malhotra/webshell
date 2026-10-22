import { spawn } from 'child_process';

/**
 * Stateless command execution for managed/serverless hosts (e.g. Cloudways
 * Velocity) where the custom server (server.js) with its PTY can't run.
 *
 * POST { command, cwd } -> NDJSON stream:
 *   {"type":"data","data":"...chunk..."}   (stdout+stderr, streamed)
 *   {"type":"done","cwd":"/new/pwd","exitCode":0}
 *
 * The shell keeps state only via `cwd` which the client sends back on the
 * next call — no server-side session, so it works on ephemeral runtimes.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const shq = (s) => `'` + String(s).replace(/'/g, `'\\''`) + `'`;

export async function POST(req) {
  let body = {};
  try { body = await req.json(); } catch { }
  const command = typeof body.command === 'string' ? body.command : '';
  const startCwd = (typeof body.cwd === 'string' && body.cwd) || process.cwd();
  const shell = process.env.WEBSHELL_SHELL || '/bin/bash';

  if (!command.trim()) {
    return jsonLine({ type: 'done', cwd: startCwd, exitCode: 0 });
  }

  // Run the command from startCwd; report the resulting PWD and exit code
  // on fd 3 so they never mix with command output.
  const script =
    `cd ${shq(startCwd)} 2>/dev/null\n` +
    `${command}\n` +
    `__ws_rc=$?\n` +
    `printf '%s' "__WS_CWD__$PWD" >&3\n` +
    `printf '%s' "__WS_HOME__$HOME" >&3\n` +
    `printf '%s' "__WS_RC__$__ws_rc" >&3\n` +
    `exit $__ws_rc\n`;

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const finish = (obj) => {
        if (closed) return;
        closed = true;
        try { controller.enqueue(enc.encode(JSON.stringify(obj) + '\n')); } catch { }
        try { controller.close(); } catch { }
      };

      let child;
      try {
        child = spawn(shell, ['-c', script], {
          env: { ...process.env, TERM: 'xterm-256color' },
          stdio: ['ignore', 'pipe', 'pipe', 'pipe'], // fd3 = control channel
        });
      } catch (err) {
        finish({ type: 'done', cwd: startCwd, exitCode: 127, error: err.message });
        return;
      }

      const send = (obj) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(JSON.stringify(obj) + '\n')); } catch { }
      };

      const onData = (buf) => send({ type: 'data', data: buf.toString('utf8') });
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);

      let control = '';
      child.stdio[3]?.on('data', (buf) => { control += buf.toString('utf8'); });

      // Hard cap so a runaway command can't pin the runtime forever
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { }
      }, 120000);

      const abort = () => { try { child.kill('SIGKILL'); } catch { } };
      req.signal?.addEventListener('abort', abort);

      child.on('error', (err) => {
        clearTimeout(killTimer);
        finish({ type: 'done', cwd: startCwd, exitCode: 127, error: err.message });
      });

      child.on('close', (code) => {
        clearTimeout(killTimer);
        const cwdM = control.match(/__WS_CWD__([\s\S]*?)__WS_HOME__/);
        const homeM = control.match(/__WS_HOME__([\s\S]*?)__WS_RC__/);
        const rcM = control.match(/__WS_RC__(-?\d+)\s*$/);
        finish({
          type: 'done',
          cwd: cwdM ? cwdM[1] : startCwd,
          home: homeM ? homeM[1] : '',
          exitCode: rcM ? parseInt(rcM[1], 10) : (code ?? 0),
        });
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

function jsonLine(obj) {
  return new Response(JSON.stringify(obj) + '\n', {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}