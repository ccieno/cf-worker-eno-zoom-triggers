# eno-zoom-triggers — ZCC Variables & Address Book Worker

A Cloudflare Worker that acts as a secure proxy for managing Zoom Contact Centre global variables and address book contacts. Used to control live demo behaviour (open/closed, holiday mode, flow vertical) without needing ZCC admin access.

**Deployed at:** `api.eno.solutions/zoom/api/*`

## What it does

- Exposes a simple REST API to read and update ZCC global variables
- Manages an address book ("webleads") for inbound web lead contacts
- Serves a browser UI (`index.html`) for toggling variables with switches and dropdowns
- Derives read-only computed variables (e.g. `timePeriod`, `day`) from the current time

## Editable variables

| Variable | Type | Description |
|---|---|---|
| `holiday` | boolean | Puts the contact centre into holiday mode |
| `open` | boolean | Overrides open/closed state |
| `vip` | boolean | Flags the next caller as VIP |
| `flowVertical` | dropdown | Sets the industry vertical for the demo flow (retail, insurance, finance, legal, hotel, etc.) |

## API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/variables` | List all editable variables with current values |
| `PATCH` | `/variables/:name` | Update a variable by name |
| `POST` | `/address-books/webleads/contacts` | Add a contact to the webleads address book |
| `GET` | `/debug/units` | Debug: list variable groups |
| `GET` | `/debug/address-books` | Debug: list address books |
| `GET` | `/debug/webleads` | Debug: list webleads contacts |

## How it works

The worker authenticates to Zoom using Server-to-Server OAuth (account credentials flow), caches the token in memory for its lifetime, then proxies requests to the Zoom Contact Centre Variables API (`/v2/contact_center/variables`).

Variable groups and IDs are discovered dynamically by name — no hardcoded IDs needed.

## Secrets required

Set via `wrangler secret put` or the Cloudflare dashboard:

| Secret | Description |
|---|---|
| `ZOOM_ACCOUNT_ID` | Zoom account ID |
| `ZOOM_CLIENT_ID` | Server-to-Server OAuth app client ID |
| `ZOOM_CLIENT_SECRET` | Server-to-Server OAuth app client secret |
| `ADMIN_TOKEN` | Optional bearer token to protect write endpoints |
| `ZOOM_VARIABLE_GROUP_ID` | Optional: hardcode the variable group ID to skip discovery |

## Development

```bash
npm run dev      # local dev with wrangler
npm run deploy   # deploy to Cloudflare
npm test         # run vitest tests
```
