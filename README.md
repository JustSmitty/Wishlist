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

Demo mode is **on by default** unless `NODE_ENV=production` or `HUSHLIST_DEMO=0` is set. With `NODE_ENV=production` demo mode cannot be turned on at all: the server refuses to start if both are set. In demo mode:

- A sample family (the Smiths) is loaded so there is something to look at.
- The welcome page offers one-click sign-in as any sample person, and a "Switch person" control stays visible. The same list looks different to its owner, to family, and to a guest with the link — that is the point of the demo.
- Sign-in codes and guest verification codes are shown in the app, because no email is sent.
- The server listens on `127.0.0.1` only, refuses to start on any other address, and only answers requests addressed to `localhost` or `127.0.0.1`. Requests that carry proxy headers (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`) are refused too, so putting a reverse proxy in front of a demo-mode server does not publish it. One-click sign-in means anyone who can reach the server can be anyone, so it must not be reachable from another machine or through another site.

Do not expose a demo-mode server to a network.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3456` | Port to listen on. |
| `HOST` | `127.0.0.1` in demo mode, otherwise `0.0.0.0` | Address to bind. |
| `HUSHLIST_DB` | `data/hushlist.sqlite` | Database file. |
| `HUSHLIST_DEMO` | on unless `NODE_ENV=production` | `0` turns demo mode off, `1` turns it on (refused together with `NODE_ENV=production`). |
| `HUSHLIST_DEMO_ALLOW_REMOTE` | off | `1` lets a demo-mode server bind to and answer on non-local addresses. Avoid: in demo mode anyone who can reach it can sign in as anyone. |
| `HUSHLIST_ADMIN_EMAILS` | none | Comma-separated addresses of the administrators. When set, this list decides: an address on it becomes an administrator, and an account whose address is taken off it loses the role (and is signed out) the next time the server starts. When empty, nothing is changed. |
| `HUSHLIST_PUBLIC_URL` | `http://localhost:PORT` in demo mode, otherwise none | The `https://` address people use. Needed for Google sign-in; turns on `Secure` cookies and HSTS. |
| `HUSHLIST_SECURE_COOKIES` | on when `HUSHLIST_PUBLIC_URL` is `https://` | `Secure` on cookies, and `Strict-Transport-Security`. |
| `HUSHLIST_TRUST_PROXY` | off | `1` takes the client address from the last entry of `X-Forwarded-For`, which is the one your own proxy adds (only behind a proxy you control; earlier entries are whatever the client sent and are ignored). |
| `HUSHLIST_MAIL_TRANSPORT` | `smtp` when `HUSHLIST_SMTP_HOST` is set, else `console` outside demo mode | `smtp` sends mail; `console` writes it to the server log; `none` keeps it in the database only. |
| `HUSHLIST_SMTP_HOST`, `HUSHLIST_SMTP_PORT` | none, `587` | Mail server. Port 465 means TLS from the start; otherwise STARTTLS is required. |
| `HUSHLIST_SMTP_SECURE` | on for port 465 | Force TLS from the start (on) or STARTTLS (off). |
| `HUSHLIST_SMTP_USER`, `HUSHLIST_SMTP_PASS` | none | Credentials, only ever sent over TLS. |
| `HUSHLIST_MAIL_FROM` | none (required for SMTP) | Sender, such as `Hushlist <no-reply@gifts.example.com>`. |
| `HUSHLIST_SMTP_ALLOW_INSECURE` | off | `1` allows an unencrypted mail server on this machine only (a development mail catcher). |
| `HUSHLIST_GOOGLE_CLIENT_ID`, `HUSHLIST_GOOGLE_CLIENT_SECRET` | none | Turns on Sign in with Google. See [docs/DEPLOY.md](docs/DEPLOY.md). |
| `HUSHLIST_BLOCKED_DOMAINS` | none | Extra comma-separated domains to refuse as links. |

On/off settings accept `1`, `true`, `on`, `yes` and `0`, `false`, `off`, `no`. Any other value stops the server at start-up rather than being guessed at.

## Deploying

See [docs/DEPLOY.md](docs/DEPLOY.md): a `Dockerfile` is included, and the guide covers what the app needs from a host, the settings, the Google and email set-up, and backups.

## Signing in

- **Email code.** An 8-digit code is sent to the address. A browser where the person has signed in before is remembered (an `hl_device` cookie), and code requests from it are limited separately, so someone requesting codes for your address from elsewhere cannot lock you out of a browser you already use. Unknown browsers share tight per-address limits, including a daily cap on wrong guesses across all codes.
- **Google.** With `HUSHLIST_GOOGLE_CLIENT_ID` and `HUSHLIST_GOOGLE_CLIENT_SECRET` set, "Sign in with Google" appears. The sign-in uses state bound to the browser, PKCE and a nonce, and Google's ID token is checked against Google's published keys. A Google account is matched to an existing Hushlist account by email only for `@gmail.com` and Google Workspace addresses, where Google controls the address; anyone else signs in with an email code once and then connects Google under Account settings.

## What is not built yet

These are stated here so nobody is surprised by them:

- **Email, before it is configured.** Without SMTP settings there is no email provider. Messages are stored in an outbox (visible under Inbox) and, outside demo mode, written to the server log. Until a provider is connected through `setMailTransport()` in `src/services/notifications.mjs`, sign-in outside demo mode depends on someone reading that log. Sign-in and verification codes are handed to the transport and never stored or shown in the Inbox. Other messages are delivered by a dispatcher that runs after each request and once a minute, retried with growing gaps if the mail server is unavailable; messages that can wait are held during the recipient's night (9 pm to 8 am in the time zone their browser reports, correct across clock changes) and sent when it ends.
- **Reading product pages.** The server never requests a shop's page. Pasting a link fills in what can be worked out from the link itself; the rest is typed by hand or sent by the browser extension, which reads the page you already have open.
- **Product photos.** Images from other sites are not loaded or proxied. Each wish gets generated wrapping-paper artwork instead.
- **Payments.** Group gifts track pledges only. No money moves through Hushlist.

## How the surprise is kept

- While a list is in surprise mode and has not been opened, its owner and co-owners receive no claim data: the response is built without querying claims at all.
- Anything an owner can do to an item returns the same answer whether or not the item has been reserved.
- Surprise mode can only be switched off while a list is still empty, and items cannot be moved from a sealed list to an open one.
- A list can be opened a week after its date. The server decides that from stored dates; there is no override. Everyone who reserved something is told when it happens.
- The opening date only ever moves later. Changing the date of a sealed list, reopening an archived one, or moving an item onto another sealed list never brings an opening forward: the list opens no sooner than it had already promised, and at least a week after the change.
- Only the list's owner (a guardian, for a child's list) can open it, choose its helper and co-owners, or change who can see it. A helper is never someone who owns the list.
- Administrators do not see reservations on their own sealed lists, in the audit log or in the activity feed.

Three limits are inherent to the design and are stated plainly:

- **Link sharing shows availability.** Anyone holding a list's link sees which items are still available and how many are left (never who took them, and never pledges or amounts), because that is what stops two guests buying the same thing. An owner who opens their own link while signed out can therefore see which items are taken, though not by whom. A surprise list that already has wishes cannot be switched to link sharing, so a list shared only with circles cannot be opened up for this. A list id is not a link: only the share link opens a list for someone with no other connection to it, and taking a list off link sharing retires that link.
- **A second identity defeats any rule about who may look.** An owner who creates another account (or a guest identity with another address) and joins their own circle, as its organizer can, sees that list as any giver would. No software rule can tell two accounts of one person apart; the protection is that this takes deliberate effort.
- **Small Secret Santa draws leak by arithmetic.** Each person sees only their own recipient, exclusions are shown to everyone in the draw, every allowed outcome is equally likely, and a set of exclusions is refused if it would let anyone work out the whole draw from their own pairing. In a group of four or five, knowing your own recipient and the exclusions can still narrow down part of the rest (two couples who cannot draw their partners is the plain example). That is a property of small draws, not something the software can remove.

## People, circles and blocking

- **Circles.** The invite code is shown to organizers only and can be replaced; the old one stops working. Organizers can remove members, anyone can leave, and a circle never ends up without an organizer. Joining a circle shares nothing by itself: lists shared by link are open to people in the owner's circles, and lists limited to particular circles stay limited to those until the owner adds another.
- **Children.** A child's list is never shared by link when it is created. It is shared with exactly the circles the guardian ticks.
- **Blocking.** A block belongs to one person (a guardian can block in a child's name). It removes follows and any helper or co-owner role between the two people in both directions, stops the blocked person opening lists, following, joining a circle the blocker organizes, or naming the blocker on their own lists. Blocks placed on someone are kept as a hash of their address when they close their account, so signing up again does not lift them. Reporting a person blocks them.
- **Being named on a list.** Co-ownership is an invitation: nothing changes for the person until they accept it from My lists, and they can leave at any time. Helpers are told when they are named and can step down at any time.
- **Secret ideas** belong to one circle, chosen by the author when there is more than one possibility. Only that circle sees the idea; the person it is about never does. Ideas written before this rule existed stay with their circle when the author and subject shared exactly one, and otherwise are visible to the author only until they choose.

## Administrators

An administrator can: read and resolve reports (including, on a single-administrator server, reports about themselves), release any reservation with a recorded reason (except on their own sealed lists), delete a secret idea, edit retailer adapters, and read the claim audit log and activity feed. An administrator cannot read anyone's reservations on a sealed list they own or co-own. Being named as co-owner does nothing until it is accepted, so nobody can hide a list from an administrator's console by naming them; an administrator who does accept co-ownership of a list stops seeing that list's reservations, like any owner.

## Limits

To keep one person from slowing the server down for everyone: 60 lists per person, 500 wishes per list (by any route: adding, importing, moving), 60 price points per wish, 20 child profiles per guardian, 1 MB per request, and per-address request rates on every write and on the heavier reads. A connection that neither sends nor reads for a minute is closed.

## Guest reservations and browsers

A guest's browser keeps a private token per reservation so they can mark it bought or release it later; those tokens are ignored and forgotten once anyone signs in on that browser. If the guest later signs up with the same address, their reservations become part of their account.

## Guests

Someone reserving by link confirms an email address with a code. If they lose the browser that made the reservation, "Find my reservation" on the list sends a code to the same address and gives that browser the reservation back (any other browser that held it loses it). The answer is the same whether or not the address has reserved anything.

## Closing an account

The account row is kept as an anonymous tombstone so other people's gift records still make sense. Removed: name, address, birthday, sessions, follows, circle memberships, secret ideas, budgets, messages addressed to the person, and the notes, payment instructions and thank-you notes on their lists. Their lists are closed and renamed "Closed wishlist"; item names are kept because other people's records refer to them. Reservations they made stay accurate but anonymous, including ones made as a guest with the same address, and old manage links stop working. Open pledges are cancelled. Any Secret Santa draw they were in is closed up around them (their giver is given their recipient, and told).

## Browser extension

`extension/` is a Manifest V3 extension that sends the page you are viewing to one of your lists.

1. Load it as an unpacked extension (`chrome://extensions`, Developer mode, "Load unpacked").
2. In Hushlist open **Account and settings** and choose **Create an extension token**.
3. Click the extension's toolbar button, enter your Hushlist address and paste the token. The address must be `https://…` unless it is this computer (`http://localhost:…`), and must not contain a user name or `@`; the popup shows the exact address the token will be sent to.

The token is stored in the browser's extension storage and can be revoked from the same settings page. It can do three things only: list your lists, read a product link, and add an item. It cannot read reservations, the inbox or exports, change or delete anything, or create another token — so a leaked token cannot be used to take over the account.

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
