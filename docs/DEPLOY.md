# Deploying Hushlist

Hushlist is one Node.js process with one SQLite database file. It needs:

| Requirement | Why |
|---|---|
| A long-running process | It runs timers: holds expire, reminders and held mail go out, old sign-in records are removed. |
| A persistent, writable disk | The database is a file (`HUSHLIST_DB`, `/data/hushlist.sqlite` in the container). Without a persistent disk every restart loses all data. |
| Exactly one instance | The database file, the rate limits and the mail dispatcher live in that one process. Two instances would each have their own database and limits. Do not turn on autoscaling or multiple replicas. |
| HTTPS in front | Session cookies, Google sign-in and HSTS assume HTTPS. The platform or a reverse proxy terminates TLS and forwards to port 3456. |
| An SMTP account | Without it nobody receives sign-in codes or guest codes. Google sign-in works without it, but guests reserving by link always need email. |
| Outbound HTTPS to Google | Only if Google sign-in is on: `oauth2.googleapis.com` and `www.googleapis.com`. |

That rules out serverless function hosts (no long-running process, no persistent local disk). It fits a container platform that offers a persistent volume, or any small virtual machine.

## The container

```bash
docker build -t hushlist .
```

```bash
docker run -d --name hushlist --restart unless-stopped -p 3456:3456 -v hushlist-data:/data --env-file hushlist.env hushlist
```

Tested in this repository's development session: the image builds from `node:22-slim`, starts with `NODE_ENV=production`, answers `GET /api/health`, keeps its data in `/data` across a restart, reports healthy to Docker, and exits cleanly on `SIGTERM`.

## Settings (`hushlist.env`)

```
HUSHLIST_PUBLIC_URL=https://gifts.example.com
HUSHLIST_TRUST_PROXY=1
HUSHLIST_ADMIN_EMAILS=you@example.com

HUSHLIST_SMTP_HOST=smtp.example.com
HUSHLIST_SMTP_PORT=587
HUSHLIST_SMTP_USER=...
HUSHLIST_SMTP_PASS=...
HUSHLIST_MAIL_FROM=Hushlist <no-reply@gifts.example.com>

# Optional: Sign in with Google
HUSHLIST_GOOGLE_CLIENT_ID=...
HUSHLIST_GOOGLE_CLIENT_SECRET=...
```

- `HUSHLIST_PUBLIC_URL` must be the exact `https://` address people use. Cookies become `Secure` automatically when it starts with `https://`.
- `HUSHLIST_TRUST_PROXY=1` only when a proxy you control sits in front and appends the client address to `X-Forwarded-For`. Hushlist uses the last entry. If your platform passes the client address differently, leave this off: limits then apply per proxy address, which is safe but coarse.
- Keep the SMTP password and Google client secret in the platform's secret store, not in the repository.

## Sign in with Google: setting up the Google side

These steps describe Google Cloud Console as I know it. I could not open Google's documentation from the session that wrote this, so check the wording against the console you see.

1. In Google Cloud Console, create a project, then configure the OAuth consent screen (app name, support email). Hushlist asks only for `openid email profile`.
2. Create an OAuth client ID of type **Web application**.
3. Add the authorised redirect URI, exactly: `https://gifts.example.com/api/auth/google/callback` (your `HUSHLIST_PUBLIC_URL` plus `/api/auth/google/callback`). For local testing also `http://localhost:3456/api/auth/google/callback`.
4. Put the client ID and secret into `HUSHLIST_GOOGLE_CLIENT_ID` and `HUSHLIST_GOOGLE_CLIENT_SECRET`.
5. While the consent screen is in testing mode Google only lets listed test users sign in; publish it when you are ready.

The endpoints Hushlist uses (`accounts.google.com/o/oauth2/v2/auth`, `oauth2.googleapis.com/token`, `www.googleapis.com/oauth2/v3/certs`), RS256 signatures and S256 PKCE were checked against Google's live discovery document, `https://accounts.google.com/.well-known/openid-configuration`.

## Email: using a Gmail account to send

Any SMTP provider works. If you want to send from a Gmail address, Google's SMTP server is commonly used as below. These details are from memory: I could not reach Google's help pages from the session that wrote this, so confirm them before relying on them.

```
HUSHLIST_SMTP_HOST=smtp.gmail.com
HUSHLIST_SMTP_PORT=465            # or 587 (STARTTLS)
HUSHLIST_SMTP_USER=you@gmail.com
HUSHLIST_SMTP_PASS=<an app password, not your Google password>
HUSHLIST_MAIL_FROM=Hushlist <you@gmail.com>
```

App passwords require 2-Step Verification on the Google account. Gmail applies daily sending limits to consumer accounts, so a dedicated transactional email provider is the better choice once more than a family uses the app.

## Where to run it

I could not open any hosting vendor's documentation from the session that wrote this, so what follows is the fit, not verified product detail. Check each vendor's current docs for volumes, pricing and limits.

| Option | Fit | What to watch |
|---|---|---|
| A small virtual machine (any provider) with Docker and a TLS reverse proxy such as Caddy or nginx | Good. Full control, one process, a real disk. | You patch the machine and set up backups yourself. |
| A container platform with persistent volumes (for example Fly.io, Render, Railway) | Good, if the volume is persistent and you run one instance. | Attaching a volume usually ties the app to one machine or region; confirm that the plan you choose includes persistent storage. |
| Serverless or static hosts (for example Vercel, Netlify, Cloudflare Workers) | Not suitable. | No long-running process and no persistent local disk for SQLite. |

## Before the first real user

1. Back up the database. With SQLite in WAL mode, copy it with `sqlite3 /data/hushlist.sqlite ".backup /data/backup.sqlite"` (or stop the container and copy the files). Keep backups off the machine.
2. Send yourself a sign-in code and confirm it arrives (and is not in spam). Set up SPF, DKIM and DMARC for the sending domain with your email provider.
3. Sign in with Google once, if enabled.
4. Watch the log for `WARNING:` lines at start-up.
