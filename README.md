# ElectroSync API

NestJS backend for ElectroSync: user accounts, saved meters, usage analytics and
low-balance alerts, on top of the NESCO prepaid customer portal
(`customer.nesco.gov.bd`).

## Why this cannot run on a foreign host

NESCO refuses requests by **source IP**. From any host outside Bangladesh every
upstream request comes back as a bare `403` with a zero-length body, which
surfaced downstream as a confusing `list index out of range` before the portal
client learned to report what it actually received.

The diagnosis, one hypothesis at a time — each failed fix eliminating a whole
class of solutions rather than being wasted effort:

| Evidence | Conclusion |
|---|---|
| TLS handshake succeeds, valid `*.nesco.gov.bd` cert | Not a network-layer block — the real server is reached |
| `example.com` returns 200 from the same host | Outbound networking is fine |
| Chrome-like headers → still 403 | Not User-Agent / header filtering |
| Chrome TLS fingerprint (JA3) → still 403 | Not bot fingerprinting |
| Site root also 403 | Not path-specific |
| Blocked from US **and** Mumbai regions | Foreign IPs refused, not one bad region |
| Works from a Bangladesh ISP IP | Bangladesh-only access |

One consequence follows, and it is the reason this README exists: **no code
change fixes this.** The rejection happens before the request is read, so there
is no header, client library or setting that helps.

What works is changing **where the request originates**. The app runs on a BDIX
VPS in Bangladesh, and that is the entire reason the hosting choice is not
negotiable.

> A working Python reference implementation of the same approach lives in
> `../python`. It exists as evidence and as a second opinion when the portal's
> markup changes — it is not part of this service and this backend never calls
> it.

## The API URL is frozen in the app

The mobile client reads `EXPO_PUBLIC_API_URL`, and Expo inlines `EXPO_PUBLIC_*`
into the JS bundle at **build** time. The value present when `eas build` runs is
baked into the APK/IPA; changing it afterwards needs a new build and a new store
review. Installed copies keep pointing at the old address forever.

That makes one decision load-bearing: **the production hostname must be one you
own.** A provider-issued name works right up until you want to leave that
provider, and this backend has already changed hosts once. With your own domain
that move is a DNS edit. With a provider-issued subdomain it is a rebuild of an
app that is already on people's phones.

| Where | `EXPO_PUBLIC_API_URL` | Notes |
|---|---|---|
| Simulator / emulator | `http://localhost:4000/api/v1` | Backend's default bind covers it |
| Real phone, same Wi-Fi | `http://<LAN-IP>:4000/api/v1` | `localhost` on a phone means the phone |
| Production | `https://api.yourdomain.com/api/v1` | HTTPS is required — iOS ATS blocks plaintext in release builds |

Local development needs nothing special: a Bangladeshi connection reaches the
NESCO endpoints directly, so `yarn start:dev` is enough.

Check any of them with:

```bash
curl https://api.yourdomain.com/api/v1/health
# {"status":"ok","database":"up","uptimeSeconds":3600}
```

`uptimeSeconds` is the field worth watching: a value that keeps resetting means
the process manager is restarting a process that dies on startup, which a plain
up/down check reports as healthy.

## Setup

```bash
yarn install
cp .env.example .env      # then fill it in
yarn build
```

`.env` is validated at boot by `src/config/env.validation.ts` — the app refuses
to start on an incomplete configuration rather than failing on the first request
that needs a missing value.

There is no `HOST` setting. The app always binds every interface, which is what
the VPS needs: traffic arrives on the host's external address, so the only other
plausible value — a loopback bind — would make the API unreachable rather than
more private.

## Running

```bash
yarn build
yarn start:prod     # node dist/main
```

`start:prod` runs the compiled output, so `yarn build` after every change.

Keeping it running across crashes and reboots is the host's job — systemd, pm2,
or whatever already supervises services on the VPS. None of that is committed
here, because the deployment host is outside this repository's concern except
for the one constraint that is not negotiable: **it must be in Bangladesh.**

### Hostname and CORS

Add the production hostname to `CORS_ORIGINS` if anything browser-based will
call it. Native Expo builds send no `Origin` header and are unaffected.

TLS is not optional for the mobile app: iOS ATS blocks plaintext in release
builds, so serve the API over HTTPS before pointing a build at it.

### The alerts sweep needs the process alive

`ALERTS_CRON` (default `0 */6 * * *`) polls every saved meter and sends
low-balance notifications. The schedule lives inside the process, so a sweep due
while the app is down simply does not happen — it is not queued and does not
catch up. That is the practical argument for a supervised service rather than a
hand-started one, and for watching `uptimeSeconds` on `/health`.

## Development

```bash
yarn start:dev     # watch mode
yarn test          # unit tests
yarn test:cov      # coverage
yarn lint
```

Local development on a Bangladeshi connection reaches the NESCO endpoints
directly, which is the whole point.

```bash
yarn db:generate   # drizzle migrations from schema changes
yarn db:migrate
yarn db:studio
```

Swagger is served at `/docs` — `SwaggerModule.setup` is not affected by
`setGlobalPrefix`, so it sits outside the `api/v1` prefix the routes use.
