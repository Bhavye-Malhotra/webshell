# webshell

A stable, good-looking web-based terminal built with **Next.js**, **node-pty**, and **xterm.js**. Run your shell from the browser with full interactivity — colors, vim, htop, ctrl-c, tab completion, everything.

![webshell UI](docs/screenshot.png)

## Features

- **Real PTY terminal** — `node-pty` streams a genuine shell session (`$SHELL`), not a command executor
- **Full interactivity** — vim, htop, less, interactive prompts, ctrl-c/ctrl-d, 256-color + truecolor
- **Dual transport** — WebSocket first, automatic **SSE + POST fallback** if a proxy blocks WebSocket upgrades (works through Cloudflare, Cloudways, and other restrictive proxies)
- **Exec mode for managed hosts** — on serverless/Vercel-like runtimes (e.g. Cloudways Velocity) where long-lived PTY processes can't exist, the app auto-detects it and switches to a stateless line-based shell (`POST /api/exec`) — commands still run, `cd` state is tracked, streamed NDJSON output
- **Polished UI** — dark GitHub-style theme, live connection status, transport badge, terminal size readout
- **Live resize** — terminal refits on window resize and propagates `TIOCSWINSZ` to the shell
- **Auto reconnection** — session-ended overlay with one-click restart
- **Opt-in auth** — set `WEBSHELL_USER` + `WEBSHELL_PASS` for HTTP basic auth (also guards the WebSocket)
- **Graceful fallback** — if the native `node-pty` module can't build, a piped-shell fallback keeps commands working

## Quick start

```bash
npm install
npm run dev
# open http://localhost:3000
```

Production:

```bash
npm run build
npm start
```

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (keep `127.0.0.1` unless you add auth) |
| `SHELL` | `$SHELL` or `/bin/zsh` | Shell to spawn |
| `WEBSHELL_CWD` | project dir | Working directory for the shell |
| `WEBSHELL_USER` / `WEBSHELL_PASS` | unset | Enable HTTP basic auth when both are set |

## Architecture

```
server.js              custom Next.js server
├─ Next.js             renders the React UI (app router)
├─ WebSocket /api/term streams a node-pty session (fallback: piped shell)
└─ SSE fallback        GET /api/term/sse (output) + POST /api/term/input (input)
                       used automatically when WebSocket upgrades are blocked

app/
├─ layout.js           loads xterm.css + globals.css
├─ page.js             "use client" — xterm.js terminal, WS + SSE client
└─ globals.css         dark theme, titlebar, statusbar, overlay
```

Protocol (JSON over WebSocket, both directions):

- client → server: `{type: "hello"}`, `{type: "start", cols, rows}`, `{type: "input", data}`, `{type: "resize", cols, rows}`
- server → client: `{type: "backend", backend}`, `{type: "data", data}`, `{type: "exit", code}`

## Deploying behind proxies (Cloudways, Cloudflare, nginx, …)

The client probes `GET /api/term/health` on boot and picks a transport automatically (badge in the titlebar):

| Condition | Transport | What works |
|---|---|---|
| Custom server reachable, proxy forwards upgrades | **WebSocket** | Everything — full PTY (vim, htop, ctrl-c) |
| Custom server reachable, upgrades blocked | **SSE + POST** | Everything — full PTY over `text/event-stream` |
| Managed/serverless runtime (custom server ignored, e.g. Cloudways Velocity) | **Exec mode** | Commands run statelessly — no interactive apps, no persistent session |

Exec mode uses `POST /api/exec`: each command is spawned fresh by a Next.js Route Handler
(`app/api/exec/route.js`), output streams back as NDJSON, and `cwd`/`$HOME`/exit code
return on a control channel (fd 3). The client tracks `cd` state and renders a line-based
shell with history.

### WebSocket checklist (for full PTY mode)

1. **Run the custom server** — startup command must be `npm start` (`node server.js`), *not* `next start`.
2. **Bind reachable** — set `HOST=0.0.0.0` if your proxy doesn't reach the app on `127.0.0.1`.
3. **Proxy upgrades** — nginx needs `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_http_version 1.1;` in front of the Node app.

## Security notes

- Binds to `127.0.0.1` by default — do not expose a shell to your network without `WEBSHELL_USER`/`WEBSHELL_PASS` (or a reverse proxy with TLS + auth).
- A webshell grants full shell access to whoever can reach it. Treat the host as trusted.

## Tech stack

- [Next.js 15](https://nextjs.org) — UI + custom server
- [node-pty](https://github.com/microsoft/node-pty) — pseudo-terminal (`node-pty@beta` on Node ≥ 24 / macOS)
- [xterm.js](https://xtermjs.org) — terminal emulator in the browser
- [ws](https://github.com/websockets/ws) — WebSocket transport