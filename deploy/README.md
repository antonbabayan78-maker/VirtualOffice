# Running an office somewhere

Two processes and a volume: the **office** (the API and the event stream) and one
**worker** (the thing that actually does the work), with **Caddy** in front
holding the certificate.

```bash
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env
docker compose -f deploy/compose.yaml up -d --build
```

Open `https://$VO_DOMAIN` in a browser: the office serves its own canvas, asks
for the token once, and keeps you signed in with a cookie the page cannot read.
Nothing else is published — the API port exists only inside the compose network,
because a bearer token over plain HTTP is a token anybody on the path can read.

## The first office

A fresh deployment has none. Sign in and the canvas offers to make one; the only
thing left is to tell the worker which office it works for, by putting that
office's id into `VO_OFFICE_ID` in `.env`:

```bash
docker compose -f deploy/compose.yaml up -d worker
```

Until it is set, the worker ticks and says it cannot read an office. That is a
worker waiting, not a worker broken.

## Signing in

The token in `.env` is what the canvas asks for. The browser never holds it after
that: the office answers with an `HttpOnly` cookie, so nothing in the page, in
storage or in the event stream's address carries a credential. **Sign out** gives
the cookie back.

It is the office's one token rather than an account, so signing out clears that
browser and nothing else, and everybody who signs in is the same owner.

## Running the canvas yourself

Still possible, against a deployed office, and then it does carry a token:

```bash
# apps/web/.env.local
VITE_VO_API_URL=https://office.example.com
VITE_VO_API_TOKEN=the same token
VITE_VO_OFFICE_ID=the id of the office
```

That canvas is on another origin, so the office has to be told the browser may
call it — which is the only thing `VO_ALLOWED_ORIGINS` is for:

```
VO_ALLOWED_ORIGINS=http://localhost:5173
```

## Upgrading

```bash
git pull
docker compose -f deploy/compose.yaml up -d --build
```

The images are rebuilt and the containers replaced. The volume is untouched, and
the SQLite store applies any pending migrations when it opens — there is no
migration step to remember.

## Where the office actually is

Everything that matters lives in the `office-data` volume: `office.db` holds
every office, department, person and piece of work, and `blobs/` holds the
documents. The containers hold nothing else worth keeping.

To copy it somewhere safe:

```bash
docker compose -f deploy/compose.yaml stop office
docker run --rm -v virtual-office_office-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/office-backup.tgz -C /data .
docker compose -f deploy/compose.yaml start office
```

Stopped first on purpose: copying a SQLite file while something is writing to it
copies a database halfway through a write.

## What this kit is not

- **Not more than one machine.** The job queue is in-process, so a second worker
  would not share the work, it would do it twice. Postgres and Redis adapters are
  what would change that, and neither exists yet.
- **Not accounts.** One office token, one owner, and a cookie that carries it.
  Sessions with an id of their own, an expiry and a way to revoke one — and more
  than one person — are a task about identity.
- **Not a backup schedule, and not monitoring.** One command to copy the volume
  is in here; deciding when to run it is operations.
- **Not an office you can import.** There is no route that takes an `office.yaml`
  yet, so a fresh office is configured through the API or from the canvas.
