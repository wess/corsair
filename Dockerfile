FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.3-alpine
WORKDIR /app

# libcap so the entrypoint can grant the port-25 binding capability without the
# process itself having to run as root.
RUN apk add --no-cache libcap ca-certificates

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Ports below 1024 need this capability. Granting it to the binary is the
# alternative to running the whole mail server as root, which it should not be.
RUN setcap 'cap_net_bind_service=+ep' /usr/local/bin/bun || true

RUN addgroup -S corsair && adduser -S corsair -G corsair \
  && chown -R corsair:corsair /app
USER corsair

ENV NODE_ENV=production

# HTTP
EXPOSE 3000
# SMTP: MX, submission, submission over implicit TLS
EXPOSE 25 587 465
# IMAP and POP3, plaintext-with-STARTTLS and implicit TLS
EXPOSE 143 993 110 995

# Migrations are not run here on purpose — two containers coming up at once
# would race. Run `bun scripts/migrate.ts up` as a one-off before rolling out.
CMD ["bun", "src/start.ts"]
