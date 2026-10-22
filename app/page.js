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
  const [transport, setTransport] = useState('ws');   // ws | sse (UI mirror)
  const [overlay, setOverlay] = useState(null);       // { title, detail }
  const [termSize, setTermSize] = useState({ cols: 80, rows: 24 });

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

  const connect = useCallback(() => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    teardown();
    const done = () => { connectingRef.current = false; };
    try {
      if (wsFailedRef.current) connectSSE();
      else connectWS();
    } finally {
      setTimeout(done, 100);
    }
  }, [connectWS, connectSSE, teardown]);

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
      term.onData((data) => sendInput(data));
      term.onResize(({ cols, rows }) => {
        setTermSize({ cols, rows });
        sendResize(cols, rows);
      });
      term.focus();
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