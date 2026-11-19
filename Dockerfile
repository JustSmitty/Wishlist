# Hushlist: one Node.js process and one SQLite file. Run exactly one
# container per database: the database file, the rate limits and the mail
# dispatcher all live in this one process, so it must not be scaled out.
#
#   docker build -t hushlist .
#   docker run -p 3456:3456 -v hushlist-data:/data \
#     -e HUSHLIST_PUBLIC_URL=https://gifts.example.com -e HUSHLIST_TRUST_PROXY=1 \
#     -e HUSHLIST_SMTP_HOST=... -e HUSHLIST_SMTP_USER=... -e HUSHLIST_SMTP_PASS=... \
#     -e HUSHLIST_MAIL_FROM='Hushlist <no-reply@gifts.example.com>' hushlist
#
# See docs/DEPLOY.md.
FROM node:22-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3456 \
    HUSHLIST_DB=/data/hushlist.sqlite

WORKDIR /app
# No dependencies to install: the app uses Node's standard library only.
COPY package.json ./
COPY src ./src

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node

EXPOSE 3456
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3456) + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "src/server.mjs"]
