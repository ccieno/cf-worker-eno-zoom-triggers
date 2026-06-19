# eno-zoom-triggers — ZCC Variables & Address Book Worker

A Cloudflare Worker acting as a secure proxy for managing Zoom Contact Centre global variables and address book contacts. Used to control live demo behaviour (open/closed, holiday mode, flow vertical) without needing ZCC admin access.

**Deployed at:** `app.eno.solutions/zoom/api/*` and `app.eno.solutions/address-books/*`

The browser UI is served from `app.eno.solutions/triggers`, protected by Google SSO via Cloudflare Access.

> **Note on Cloudflare Access + API calls:** Both the UI and API routes are under `app.eno.solutions`, so CF Access cookies are forwarded automatically by the browser. Write endpoints are additionally protected by the `X-Admin-Token` header.

## Routes

All paths are relative to the `/zoom/api` prefix (the worker strips it internally).

| Method | Path | Description |
|---|---|---|
| `GET` | `/variables` | List all editable variables with current values |
| `PATCH` | `/variables/:name` | Update a variable by name |
| `POST` | `/address-books/webleads/contacts` | Add a contact to the webleads address book |
| `GET` | `/debug/units` | Debug: list variable groups |
| `GET` | `/debug/address-books` | Debug: list address books |
| `GET` | `/debug/webleads` | Debug: webleads address book info |

CORS is locked to `https://app.eno.solutions`.

## Editable variables

| Variable | Type | Description |
|---|---|---|
| `holiday` | boolean | Puts the contact centre into holiday mode |
| `open` | boolean | Overrides open/closed state |
| `vip` | boolean | Flags the next caller as VIP |
| `flowVertical` | dropdown | Sets the industry vertical for the demo flow |

## How it works

1. Authenticates to Zoom using Server-to-Server OAuth (token cached in memory)
2. Discovers variable group IDs dynamically by name — no hardcoded IDs
3. Proxies read/write requests to the ZCC Variables API (`/v2/contact_center/variables`)
4. Computes derived read-only vars (`timePeriod`, `day`) from current London time

## Secrets required

| Secret | Description |
|---|---|
| `ZOOM_ACCOUNT_ID` | Zoom account ID |
| `ZOOM_CLIENT_ID` | Server-to-Server OAuth app client ID |
| `ZOOM_CLIENT_SECRET` | Server-to-Server OAuth app client secret |
| `ADMIN_TOKEN` | Protects write endpoints (`X-Admin-Token` header) |
| `ZOOM_VARIABLE_GROUP_ID` | Optional: hardcode group ID to skip discovery |

## Development

```bash
npm run dev      # local dev with wrangler
npm run deploy   # deploy to Cloudflare
npm test         # run vitest tests
```
