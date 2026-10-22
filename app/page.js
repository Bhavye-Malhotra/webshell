'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export default function Home() {
  const hostRef = useRef(null);          // div the terminal mounts into
  const termRef = useRef(null);          // xterm.Terminal
  const fitAddonRef = useRef(null);
  const wsRef = useRef(null);            // WebSocket
  const esRef = useRef(null);            // EventSource (SSE fallback)
  const sseIdRef = useRef(null);         // SSE session id
  const sessionAliveRef = useRef(false);
  const gotWsDataRef = useRef(false);    // did the WS ever stream data?
  const wsFailedRef = useRef(false);     // WS blocked by proxy? → go straight to SSE
  const transportRef = useRef('ws');     // 'ws' | 'sse'
  const connectingRef = useRef(false);

  const [status, setStatus] = useState('connecting'); // connecting | connected | exited
  const [backend, setBackend] = useState('…');
  const [transport, setTransport] = useState('ws');   // ws | sse | exec (UI mirror)
  const [overlay, setOverlay] = useState(null);       // { title, detail }
  const [termSize, setTermSize] = useState({ cols: 80, rows: 24 });

  // ---- exec-mode state (line-based shell for managed hosts) ----------------
  const execRef = useRef({
    cwd: '',
    home: '',
    line: '',
    busy: false,
    history: [],
    historyIdx: -1,
    abort: null,
  });

  // ---- Sending input / resize over whichever transport is live -------------
  const sendInput = useCallback((data) => {
    if (transportRef.current === 'ws') {
      if (wsRef.current?.readyState === WebSocket.OPEN && sessionAliveRef.current) {
        wsRef.current.send(JSON.stringify({ type: 'input', data }));
      }
    } else if (transportRef.current === 'sse' && sseIdRef.current) {
      fetch('/api/term/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sseIdRef.current, data }),
      }).catch(() => { });
    }
  }, []);

  const sendResize = useCallback((cols, rows) => {
    if (transportRef.current === 'ws') {
      if (wsRef.current?.readyState === WebSocket.OPEN && sessionAliveRef.current) {
        wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    } else if (transportRef.current === 'sse' && sseIdRef.current) {
      fetch('/api/term/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sseIdRef.current, resize: { cols, rows } }),
      }).catch(() => { });
    }
  }, []);

  // ---- Transport teardown --------------------------------------------------
  const teardown = useCallback(() => {
    try { wsRef.current?.close(); } catch { }
    try { esRef.current?.close(); } catch { }
    wsRef.current = null;
    esRef.current = null;
    sseIdRef.current = null;
    sessionAliveRef.current = false;
  }, []);

  // ---- exec-mode transport (works on managed/serverless hosts) -------------
  const shortCwd = (cwd) => {
    const home = execRef.current.home;
    if (home && cwd.startsWith(home)) {
      const rest = cwd.slice(home.length);
      return rest === '' ? '~' : '~' + rest;
    }
    return cwd;
  };

  const writePrompt = useCallback(() => {
    const e = execRef.current;
    const p = `\r\n\x1b[36m${shortCwd(e.cwd)}\x1b[0m \x1b[32m❯\x1b[0m `;
    termRef.current?.write(p);
  }, []);

  const runCommand = useCallback(async (cmd) => {
    const e = execRef.current;
    const term = termRef.current;
    if (!term) return;
    e.busy = true;
    e.abort = new AbortController();

    try {
      const res = await fetch('/api/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, cwd: e.cwd }),
        signal: e.abort.signal,
      });
      if (!res.ok || !res.body) {
        term.write(`\x1b[31mexec error: HTTP ${res.status}\x1b[0m\r\n`);
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let pending = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += dec.decode(value, { stream: true });
        let idx;
        while ((idx = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, idx);
          pending = pending.slice(idx + 1);
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === 'data') term.write(msg.data);
          if (msg.type === 'done') {
            if (msg.cwd) e.cwd = msg.cwd;
            if (msg.home) e.home = msg.home;
            if (msg.error) term.write(`\x1b[31m${msg.error}\x1b[0m\r\n`);
            if (msg.exitCode !== 0) term.write(`\x1b[2m[exit ${msg.exitCode}]\x1b[0m\r\n`);
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        term.write(`\x1b[31m${err.message}\x1b[0m\r\n`);
      } else {
        term.write('^C\r\n');
      }
    } finally {
      e.busy = false;
      e.abort = null;
      writePrompt();
    }
  }, [writePrompt]);

  const handleExecKey = useCallback((data) => {
    const e = execRef.current;
    const term = termRef.current;
    if (!term) return;

    if (e.busy) {
      if (data === '\u0003' && e.abort) e.abort.abort(); // ctrl-c aborts
      return;
    }

    if (data === '\r') {
      const cmd = e.line.trim();
      e.line = '';
      e.historyIdx = -1;
      term.write('\r\n');
      if (cmd) {
        if (e.history[e.history.length - 1] !== cmd) e.history.push(cmd);
        if (cmd === 'clear' || cmd === 'cls') {
          term.clear();
          writePrompt();
        } else if (cmd === 'exit') {
          term.write('This is an exec-mode shell — there is no session to exit.\r\n');
          writePrompt();
        } else {
          runCommand(cmd);
        }
      } else {
        writePrompt();
      }
      return;
    }

    if (data === '\u007f') { // backspace
      if (e.line.length > 0) {
        e.line = e.line.slice(0, -1);
        term.write('\b \b');
      }
      return;
    }

    if (data === '\u0003') { // ctrl-c clears the line
      e.line = '';
      term.write('^C\r\n');
      writePrompt();
      return;
    }

    if (data === '\u001b[A' || data === '\u001b[B') { // up/down history
      if (e.history.length === 0) return;
      if (data === '\u001b[A') {
        e.historyIdx = e.historyIdx === -1 ? e.history.length - 1 : Math.max(0, e.historyIdx - 1);
      } else {
        if (e.historyIdx === -1) return;
        e.historyIdx += 1;
        if (e.historyIdx >= e.history.length) { e.historyIdx = -1; e.line = ''; }
      }
      const hist = e.historyIdx === -1 ? '' : e.history[e.historyIdx];
      term.write('\r\x1b[K');
      writePromptSameLine();
      term.write(hist);
      e.line = hist;
      return;
    }

    if (data === '\u001b[C' || data === '\u001b[D' || data === '\u001b[H' || data === '\u001b[F') {
      return; // no mid-line editing in exec mode
    }

    if (data >= ' ' || data === '\t') {
      e.line += data === '\t' ? '  ' : data;
      term.write(data === '\t' ? '  ' : data);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runCommand, writePrompt]);

  const writePromptSameLine = useCallback(() => {
    const e = execRef.current;
    termRef.current?.write(`\x1b[36m${shortCwd(e.cwd)}\x1b[0m \x1b[32m❯\x1b[0m `);
  }, []);

  const connectExec = useCallback(async () => {
    transportRef.current = 'exec';
    setTransport('exec');
    setStatus('connecting');

    let health = null;
    try {
      const r = await fetch('/api/term/health');
      if (r.ok) health = await r.json();
    } catch { }
    setBackend(health ? (health.backend === 'pty' ? 'pty (exec)' : 'pipe (exec)') : 'exec');
    execRef.current.cwd = '';

    const term = termRef.current;
    if (!term) return;
    term.reset();
    term.writeln('\x1b[2m── webshell exec mode ────────────────────────────\x1b[0m');
    term.writeln('\x1b[2m Managed host detected: commands run statelessly (no PTY).\x1b[0m');
    term.writeln('\x1b[2m Interactive apps (vim/htop) need the custom server on a long-running host.\x1b[0m');
    setStatus('connected');
    writePrompt();
    term.focus();
  }, [writePrompt]);

  // ---- SSE fallback transport ----------------------------------------------
  const connectSSE = useCallback(() => {
    transportRef.current = 'sse';
    setTransport('sse');
    setStatus('connecting');

    const dims = termRef.current ?? { cols: 80, rows: 24 };
    const es = new EventSource(`/api/term/sse?cols=${dims.cols}&rows=${dims.rows}`);
    esRef.current = es;
    sessionAliveRef.current = true;

    es.onopen = () => {
      setStatus('connected');
      termRef.current?.focus();
    };

    es.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case 'hello':
          sseIdRef.current = msg.id;
          setBackend(msg.backend === 'pty' ? 'pty' : 'pipe');
          break;
        case 'data':
          termRef.current?.write(msg.data);
          break;
        case 'exit':
          sessionAliveRef.current = false;
          setStatus('exited');
          setOverlay({
            title: 'Session ended',
            detail: `The shell exited with code ${msg.code}.`,
          });
          try { es.close(); } catch { }
          break;
        default:
          break;
      }
    };

    es.onerror = () => {
      if (esRef.current !== es) return; // superseded
      if (sessionAliveRef.current) {
        sessionAliveRef.current = false;
        setStatus('connecting');
        setOverlay({
          title: 'Connection lost',
          detail: 'The SSE stream dropped. Reconnect to start a new shell.',
        });
      }
      try { es.close(); } catch { }
    };
  }, []);

  // ---- WebSocket transport (preferred) --------------------------------------
  const connectWS = useCallback(() => {
    transportRef.current = 'ws';
    setTransport('ws');
    setStatus('connecting');
    setOverlay(null);
    gotWsDataRef.current = false;

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/api/term`);
    wsRef.current = ws;

    // If the server/proxy doesn't do WebSocket upgrades (404, hang, reset),
    // fall back to SSE. Give the handshake a short window.
    const fallbackTimer = setTimeout(() => {
      if (wsRef.current === ws && !gotWsDataRef.current) {
        try { ws.close(); } catch { }
        connectSSE();
      }
    }, 4000);

    ws.onopen = () => {
      setStatus('connected');
      const dims = termRef.current ?? { cols: 80, rows: 24 };
      sessionAliveRef.current = true;
      ws.send(JSON.stringify({ type: 'start', cols: dims.cols, rows: dims.rows }));
      ws.send(JSON.stringify({ type: 'hello' }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case 'data':
          clearTimeout(fallbackTimer);
          gotWsDataRef.current = true;
          termRef.current?.write(msg.data);
          break;
        case 'exit':
          clearTimeout(fallbackTimer);
          sessionAliveRef.current = false;
          setStatus('exited');
          setOverlay({
            title: 'Session ended',
            detail: `The shell exited with code ${msg.code}.`,
          });
          break;
        case 'backend':
          setBackend(msg.backend === 'pty' ? 'pty' : 'pipe');
          break;
        default:
          break;
      }
    };

    ws.onclose = () => {
      clearTimeout(fallbackTimer);
      if (wsRef.current !== ws) return; // superseded
      if (gotWsDataRef.current && sessionAliveRef.current) {
        sessionAliveRef.current = false;
        setStatus('connecting');
        setOverlay({
          title: 'Connection lost',
          detail: 'The WebSocket disconnected. Reconnect to start a new shell.',
        });
      } else if (!gotWsDataRef.current) {
        // WS never worked (e.g. proxy blocks upgrades) — switch to SSE
        wsFailedRef.current = true;
        connectSSE();
      }
    };

    ws.onerror = () => { /* onclose decides next step */ };
  }, [connectSSE]);

  const connect = useCallback(async () => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    teardown();
    try {
      // Probe whether the custom server (WS/SSE/PTY) exists on this host.
      let ptyHost = false;
      try {
        const r = await fetch('/api/term/health');
        if (r.ok) ptyHost = true;
      } catch { }

      if (!ptyHost) {
        await connectExec();     // managed host (e.g. Cloudways Velocity)
      } else if (wsFailedRef.current) {
        connectSSE();            // PTY host, WS blocked by proxy
      } else {
        connectWS();             // PTY host, try WebSocket first
      }
    } finally {
      connectingRef.current = false;
    }
  }, [connectWS, connectSSE, connectExec, teardown]);

  // ---- Boot: build terminal, connect, fit, resize handling ----------------
  useEffect(() => {
    let disposed = false;
    let term, fitAddon;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed) return;

      fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;

      term = new Terminal({
        fontFamily: '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 13.5,
        lineHeight: 1.25,
        cursorBlink: true,
        cursorStyle: 'bar',
        theme: {
          background: '#010409',
          foreground: '#e6edf3',
          cursor: '#58a6ff',
          selectionBackground: '#58a6ff44',
          black: '#484f58', red: '#ff7b72', green: '#3fb950',
          yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff',
          cyan: '#39c5cf', white: '#b1bac4',
          brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
          brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
          brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
        },
        allowProposedApi: true,
      });
      termRef.current = term;
      term.loadAddon(fitAddon);
      term.open(hostRef.current);
      fitAddon.fit();
      const dims = { cols: term.cols, rows: term.rows };
      setTermSize(dims);
      term.onData((data) => {
        if (transportRef.current === 'exec') handleExecKey(data);
        else sendInput(data);
      });
      term.onResize(({ cols, rows }) => {
        setTermSize({ cols, rows });
        sendResize(cols, rows);
      });
      term.focus();
      // Debug/test hook: lets tests feed xterm onData strings directly
      window.__webshell = {
        term,
        execKey: (d) => handleExecKey(d),
        sendInput: (d) => sendInput(d),
      };
      connect();
    })();

    const onWinResize = () => {
      try { fitAddonRef.current?.fit(); } catch { /* not ready */ }
    };
    window.addEventListener('resize', onWinResize);

    return () => {
      disposed = true;
      window.removeEventListener('resize', onWinResize);
      teardown();
      try { term?.dispose(); } catch { }
      wsRef.current = null;
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Actions ------------------------------------------------------------
  const restartSession = () => {
    setOverlay(null);
    termRef.current?.reset();
    connect();
  };

  const clearTerm = () => {
    termRef.current?.clear();
    termRef.current?.focus();
  };

  const statusLabel = {
    connecting: 'connecting…',
    connected: 'live',
    exited: 'exited',
  }[status];
  const statusClass = {
    connecting: 'statusConnecting',
    connected: 'statusConnected',
    exited: 'statusExited',
  }[status];

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-dot" />
          <span className="brand-name">webshell</span>
          <span className="badge" title="Terminal backend">backend: {backend}</span>
          <span
            className="badge"
            title={transport === 'ws' ? 'WebSocket transport' : 'SSE fallback transport (proxy blocked WebSocket)'}
          >
            transport: {transport}
          </span>
        </div>
        <div className="titlebar-actions">
          <span className={`status ${statusClass}`}>{statusLabel}</span>
          <button className="btn" onClick={restartSession} title="Restart the shell session">
            ↻ Reconnect
          </button>
          <button className="btn" onClick={clearTerm} title="Clear the terminal">
            Clear
          </button>
        </div>
      </header>

      <main className="terminalWrap">
        <div className="terminalHost" ref={hostRef} />
        {overlay && (
          <div className="overlay">
            <div className="overlayCard">
              <p className="overlayTitle">{overlay.title}</p>
              <p className="overlayDetail">{overlay.detail}</p>
              <button className="btn btnPrimary" onClick={restartSession}>
                Start new session
              </button>
            </div>
          </div>
        )}
      </main>

      <footer className="statusbar">
        <span>
          {status === 'connected' ? 'ready' : statusLabel}
        </span>
        <span>{termSize.cols} × {termSize.rows}</span>
      </footer>
    </div>
  );
}