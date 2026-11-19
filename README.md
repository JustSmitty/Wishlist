# Hushlist

Wishlists for any shop that keep the surprise. The people shopping for you can see what is already taken; you cannot, until a week after the occasion.

Plain Node.js with no dependencies: the built-in HTTP server, the built-in SQLite module, and a front end written as native ES modules with no build step.

## Run it

Requires **Node.js 22.13 or newer** (`node:sqlite` is used without a flag from that version).

```bash
npm start
```

Then open <http://localhost:3456>. The database is created at `data/hushlist.sqlite` on first start.

```bash
npm test
```

## Demo mode

Demo mode is **on by default** unless `NODE_ENV=production` or `HUSHLIST_DEMO=0` is set. In demo mode:

- A sample family (the Smiths) is loaded so there is something to look at.
- The welcome page offers one-click sign-in as any sample person, and a "Switch person" control stays visible. The same list looks different to its owner, to family, and to a guest with the link — that is the point of the demo.
- Sign-in codes and guest verification codes are shown in the app, because no email is sent.
- The server listens on `127.0.0.1` only, refuses to start on any other address, and only answers requests addressed to `localhost` or `127.0.0.1`. One-click sign-in means anyone who can reach the server can be anyone, so it must not be reachable from another machine or through another site.

Do not expose a demo-mode server to a network.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3456` | Port to listen on. |
| `HOST` | `127.0.0.1` in demo mode, otherwise `0.0.0.0` | Address to bind. |
| `HUSHLIST_DB` | `data/hushlist.sqlite` | Database file. |
| `HUSHLIST_DEMO` | on unless `NODE_ENV=production` | `0` turns demo mode off, `1` forces it on. |
| `HUSHLIST_DEMO_ALLOW_REMOTE` | off | `1` lets a demo-mode server bind to and answer on non-local addresses. Avoid: in demo mode anyone who can reach it can sign in as anyone. |
| `HUSHLIST_ADMIN_EMAILS` | none | Comma-separated addresses that become administrators when they sign in. |
| `HUSHLIST_SECURE_COOKIES` | off | `1` adds `Secure` to the session cookie. Set it when serving over HTTPS. |
| `HUSHLIST_TRUST_PROXY` | off | `1` takes the client address from `X-Forwarded-For` (only behind a proxy you control). |
| `HUSHLIST_MAIL_TRANSPORT` | `console` outside demo mode | `console` writes outgoing messages to the server log; `none` keeps them in the database only. |
| `HUSHLIST_BLOCKED_DOMAINS` | none | Extra comma-separated domains to refuse as links. |

## What is not built yet

These are stated here so nobody is surprised by them:

- **Email.** There is no email provider. Messages are stored in an outbox (visible under Inbox) and, outside demo mode, written to the server log. Until a provider is connected through `setMailTransport()` in `src/services/notifications.mjs`, sign-in outside demo mode depends on someone reading that log.
- **Reading product pages.** The server never requests a shop's page. Pasting a link fills in what can be worked out from the link itself; the rest is typed by hand or sent by the browser extension, which reads the page you already have open.
- **Product photos.** Images from other sites are not loaded or proxied. Each wish gets generated wrapping-paper artwork instead.
- **Payments.** Group gifts track pledges only. No money moves through Hushlist.

## How the surprise is kept

- While a list is in surprise mode and has not been opened, its owner and co-owners receive no claim data: the response is built without querying claims at all.
- Anything an owner can do to an item returns the same answer whether or not the item has been reserved.
- Surprise mode can only be switched off while a list is still empty, and items cannot be moved from a sealed list to an open one.
- A list can be opened a week after its date. The server decides that from the stored date; there is no override. Everyone who reserved something is told when it happens.
- Administrators do not see reservations on their own sealed lists.

One limit is inherent to link sharing: a list shared by link shows "taken" marks to anyone holding the link, without names. An owner who signs out and opens their own link can therefore see which items are taken, though not by whom. Lists shared only with circles do not have this property.

## Browser extension

`extension/` is a Manifest V3 extension that sends the page you are viewing to one of your lists.

1. Load it as an unpacked extension (`chrome://extensions`, Developer mode, "Load unpacked").
2. In Hushlist open **Account and settings** and choose **Create an extension token**.
3. Click the extension's toolbar button, enter your Hushlist address and paste the token.

The token is stored in the browser's extension storage and can be revoked from the same settings page.

## Layout

```
src/server.mjs            HTTP routes
src/http.mjs              body parsing, cookies, rate limiting, static files
src/config.mjs            environment configuration
src/db/                   schema, indexes, seed data
src/services/auth.mjs     sessions and email-code sign-in
src/services/surprise.mjs who may see what
src/services/access.mjs   relationship checks (circles, guardians, blocks)
src/services/claims.mjs   reservations, pledges, list archive
src/services/capture.mjs  link safety, text cleaning, page metadata extraction
src/public/               front end (ES modules, one stylesheet)
extension/                browser extension
tests/                    node:test suites
```

## Third-party material

The display typeface is Fraunces, copyright 2020 The Fraunces Project Authors, used under the SIL Open Font License 1.1. The full licence text, as shipped with the font, is in `src/public/fonts/OFL.txt`.
