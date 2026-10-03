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

## Tools that act

An office reaches outside itself through connectors, and an MCP server is one of
them: either a command this office runs, or an `https` address it posts to. Add
one on the canvas, press **Find its tools**, and grant them to a department or a
person.

Two things a deployment has to arrange:

- **A command has to exist in the images.** `command: node` with
  `args: ["/srv/mcp/post-room.mjs"]` means exactly that path inside the container —
  both of them, because the worker runs the tool and the office runs the same
  server once when you press Find its tools. Build it into the image, or mount it
  into both services. A server reached over `https` needs none of this.
- **A credential is named, never stored.** An HTTP server's token comes from an
  environment variable the connector names (`tokenEnv: ACME_MCP_TOKEN`), read at
  the moment of the call. Pass it to the office and the worker in `.env`; nothing
  secret goes into the office's database.

**Every tool stops for a person until you say otherwise.** That is the default on
purpose — the alternative is that the first tool anybody adds can send mail with
nobody asked. A run that reaches one stops before the call, the work shows as
blocked with the tool and its arguments named, and it waits. Clear **Needs a
person** beside a tool that only reads, and it stops asking.

Answering is an API call for now, until the canvas grows an approvals inbox:

```bash
curl -X POST https://$VO_DOMAIN/tasks/$TASK/events \
  -H "authorization: Bearer $VO_API_TOKEN" -H 'content-type: application/json' \
  -d '{"type":"call_decided","key":"toolu_01…","decision":"approved","decidedBy":"you"}'
```

The key is the held call's, which `GET /tasks/$TASK/run-checkpoint` lists along
with where the run got to. A refusal (`"decision":"declined"`, with a `reason`)
is not a cancellation: the run is told, and carries on without that call.

A parked run is kept at the office rather than in the worker, so the answer can
arrive after the worker that asked has been restarted or replaced.

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
- **Not an approvals inbox.** Work waiting for a person shows as blocked on the
  canvas and is answered over the API; the inbox that lists them is its own task.
