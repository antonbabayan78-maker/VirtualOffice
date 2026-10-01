# Running an office somewhere

Two processes and a volume: the **office** (the API and the event stream) and one
**worker** (the thing that actually does the work), with **Caddy** in front
holding the certificate.

```bash
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env
docker compose -f deploy/compose.yaml up -d --build
```

The office is then on `https://$VO_DOMAIN`. Nothing else is published: the API
port exists only inside the compose network, because a bearer token over plain
HTTP is a token anybody on the path can read.

## The first office

A fresh deployment has no office in it, and the worker needs to be told which one
it works for. Make one, then tell it:

```bash
curl -s https://$VO_DOMAIN/offices \
  -H "authorization: Bearer $VO_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"Northwind Studio"}'
```

Put the `id` that comes back into `VO_OFFICE_ID` in `.env`, then:

```bash
docker compose -f deploy/compose.yaml up -d worker
```

Until it is set, the worker ticks and says it cannot read an office. That is a
worker waiting, not a worker broken.

## Seeing it

The canvas is **not** served by this kit. It is built with the office token
inside it, so publishing it would publish the token; it runs on your own machine
and talks to the deployed office:

```bash
# apps/web/.env.local
VITE_VO_API_URL=https://office.example.com
VITE_VO_API_TOKEN=the same token
VITE_VO_OFFICE_ID=the id from above
```

and the office has to allow the browser to call it, which is what
`VO_ALLOWED_ORIGINS` is for:

```
VO_ALLOWED_ORIGINS=http://localhost:5173
```

Then `pnpm --filter @vo/web dev` and open it. Serving the canvas from the office
itself waits on a sign-in, so that a browser can be handed a token instead of
having one built into it.

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
- **Not a canvas.** See above.
- **Not a backup schedule, and not monitoring.** One command to copy the volume
  is in here; deciding when to run it is operations.
- **Not an office you can import.** There is no route that takes an `office.yaml`
  yet, so a fresh office is configured through the API or from the canvas.
