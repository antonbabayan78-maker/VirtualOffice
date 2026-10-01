# Virtual Office

A drag-and-drop workspace where every employee is an LLM agent, departments are configurable zones, work flows through real-office style review and approval, and every token is metered.

Status: P0 Foundations. See `CLAUDE.md` for the working rules and the Notion plan for the roadmap.

```bash
pnpm install
pnpm check
```

## Running one

An office is two processes — the server and a worker — and a volume to keep it in.
[`deploy/README.md`](deploy/README.md) has the kit: an image for each, a compose file that
puts them behind TLS, and what to fill in.

```bash
cp deploy/.env.example deploy/.env
docker compose -f deploy/compose.yaml up -d --build
```
