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

From Google's guide "Using OAuth 2.0 for Web Server Applications" (https://developers.google.com/identity/protocols/oauth2/web-server), checked 20 November 2026:

1. In Google Cloud Console, go to the **Clients** page, click **Create Client**, and choose the **Web application** type. Google's guide points to its help article "Setting up your OAuth consent screen" for the consent screen; set that up too (Hushlist asks only for `openid email profile`).
2. Add the authorised redirect URI, exactly: `https://gifts.example.com/api/auth/google/callback` (your `HUSHLIST_PUBLIC_URL` plus `/api/auth/google/callback`). Google requires redirect URIs to use HTTPS, except for localhost, and not to be raw IP addresses (localhost IPs excepted). The URI the app sends must exactly match one you registered. For local testing you can add `http://localhost:3456/api/auth/google/callback`.
3. Put the client ID and secret into `HUSHLIST_GOOGLE_CLIENT_ID` and `HUSHLIST_GOOGLE_CLIENT_SECRET`.

The endpoints Hushlist uses (`accounts.google.com/o/oauth2/v2/auth`, `oauth2.googleapis.com/token`, `www.googleapis.com/oauth2/v3/certs`), RS256 signatures and S256 PKCE were checked against Google's live discovery document, `https://accounts.google.com/.well-known/openid-configuration`. The ID token checks follow the list in Google's OpenID Connect guide (https://developers.google.com/identity/openid-connect/openid-connect): signature against the published keys, issuer `https://accounts.google.com` or `accounts.google.com`, audience equal to the client ID, expiry. The button is Google's own asset from its branding guidelines.

## Email: using a Gmail account to send

Any SMTP provider works. To send from a Gmail address:

```
HUSHLIST_SMTP_HOST=smtp.gmail.com
HUSHLIST_SMTP_PORT=465            # or 587 (STARTTLS)
HUSHLIST_SMTP_USER=you@gmail.com
HUSHLIST_SMTP_PASS=<an app password, not your Google password>
HUSHLIST_MAIL_FROM=Hushlist <you@gmail.com>
```

From Google's help pages, checked 20 November 2026:

- App passwords "can only be used with accounts that have 2-Step Verification turned on", and the option may be missing for work or school accounts, accounts with Advanced Protection, and accounts whose 2-Step Verification uses only security keys (https://support.google.com/accounts/answer/185833).
- A consumer Gmail account hits a limit when it sends "more than 500 emails ... in a day" (https://support.google.com/mail/answer/22839). Every sign-in code and guest code is an email, so a dedicated transactional email provider is the better choice beyond a family-sized group.

Not verified: the server name and ports above. Google's page on sending from apps now redirects to `knowledge.workspace.google.com`, which I could not open. Confirm them in your Google account help before relying on them.

## Where to run it

I cannot deploy it for you from here: that needs an account with a hosting provider, which only you can create and pay for. Any host that runs a Docker image with a persistent disk will do. What the vendors' own documentation says, checked 20 November 2026:

| Option | Fit | From the vendor's documentation |
|---|---|---|
| **Render** (paid instance + persistent disk) | Good | Persistent disks attach only to paid services ("You can attach a persistent disk to a paid Render web service"). "You can't scale a service to multiple instances if it has a disk attached", and a disk "prevents zero-downtime deploys" (one instance is what Hushlist needs anyway). Disks get automatic daily snapshots. Render's load balancer terminates TLS and redirects HTTP to HTTPS. It builds from a Dockerfile. Your service must listen on `0.0.0.0`; Render's default port is 10000, so set `PORT=10000` or change the port in Render. (https://render.com/docs/disks, https://render.com/docs/web-services) |
| **Render free instance** | Not suitable | "Free web services cannot" have persistent disks; their filesystem, including "local SQLite databases", is lost on every redeploy, restart or spin-down, and they spin down after 15 minutes without traffic. (https://render.com/docs/free) |
| **Railway** (with a volume) | Good | Volumes give a service persistent storage; "Each service can only have a single volume" and "Replicas cannot be used with volumes"; there is "a small amount of downtime when re-deploying a service that has a volume attached". Railway builds from a Dockerfile at the root of the source directory. (https://docs.railway.com/volumes/reference, https://docs.railway.com/builds/dockerfiles) |
| **Fly.io** (with a volume) | Probably good | Not verified: Fly's documentation moved to `docs.fly.io`, which I could not open. Check volumes, regions and backups there. |
| **A small virtual machine** (any provider) with Docker and a TLS reverse proxy such as Caddy or nginx | Good | Full control, one process, a real disk. You patch the machine and run backups yourself. |
| **Vercel** | Not suitable | Vercel "creates a new function invocation for each incoming request" and "scales your functions down to zero when there are no incoming requests" (https://vercel.com/docs/functions). Hushlist needs one long-running process for its timers and a persistent disk for its database. |

Behind Render or Railway, set `HUSHLIST_TRUST_PROXY=1` only after confirming how that platform passes the client address; neither page I read states the header. Without it the app still works, but rate limits apply to the platform's proxy address rather than to each visitor.

## Before the first real user

1. Back up the database. With SQLite in WAL mode, copy it with `sqlite3 /data/hushlist.sqlite ".backup /data/backup.sqlite"` (or stop the container and copy the files). Keep backups off the machine.
2. Send yourself a sign-in code and confirm it arrives (and is not in spam). Set up SPF, DKIM and DMARC for the sending domain with your email provider.
3. Sign in with Google once, if enabled.
4. Watch the log for `WARNING:` lines at start-up.
