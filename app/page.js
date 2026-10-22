'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export default function Home() {
  const hostRef = useRef(null);          // div the terminal mounts into
  const termRef = useRef(null);          // xterm.Terminal
  const fitAddonRef = useRef(null);
  const wsRef = useRef(null);            // WebSocket
  const sessionAliveRef = useRef(false);

  const [status, setStatus] = useState('connecting'); // connecting | connected | exited
  const [backend, setBackend] = useState('…');
  const [overlay, setOverlay] = useState(null);       // { title, detail }
  const [termSize, setTermSize] = useState({ cols: 80, rows: 24 });

  // ---- WebSocket lifecycle ------------------------------------------------
  const connect = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/api/term`);
    wsRef.current = ws;
    setStatus('connecting');
    setOverlay(null);

    ws.onopen = () => {
      setStatus('connected');
      const { cols, rows } = termRef.current ?? { cols: 80, rows: 24 };
      sessionAliveRef.current = true;
      ws.send(JSON.stringify({ type: 'start', cols, rows }));
      // Ask server which backend it's using
      ws.send(JSON.stringify({ type: 'hello' }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
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
          break;
        case 'backend':
          setBackend(msg.backend === 'pty' ? 'pty' : 'pipe');
          break;
        default:
          break;
      }
    };

    ws.onclose = () => {
      setStatus((s) => (s === 'exited' ? s : 'connecting'));
      if (sessionAliveRef.current) {
        sessionAliveRef.current = false;
        setOverlay({
          title: 'Connection lost',
          detail: 'The WebSocket disconnected. Reconnect to start a new shell.',
        });
      }
    };

    ws.onerror = () => ws.close();
  }, []);

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
        if (wsRef.current?.readyState === WebSocket.OPEN && sessionAliveRef.current) {
          wsRef.current.send(JSON.stringify({ type: 'input', data }));
        }
      });
      term.onResize(({ cols, rows }) => {
        setTermSize({ cols, rows });
        if (wsRef.current?.readyState === WebSocket.OPEN && sessionAliveRef.current) {
          wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
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
      try { wsRef.current?.close(); } catch { }
      try { term?.dispose(); } catch { }
      wsRef.current = null;
      termRef.current = null;
    };
  }, [connect]);

  // ---- Actions ------------------------------------------------------------
  const restartSession = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      connect();
      return;
    }
    termRef.current?.reset();
    sessionAliveRef.current = true;
    setOverlay(null);
    const { cols, rows } = termRef.current;
    wsRef.current.send(JSON.stringify({ type: 'start', cols, rows }));
    termRef.current?.focus();
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