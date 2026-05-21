/**
 * Cloudflare Worker - Zoom Contact Center Variables proxy + Address Book Contact create
 *
 * Endpoints:
 *  GET    /variables
 *  PATCH  /variables/:name
 *
 * Debug endpoints:
 *  GET    /debug/groups
 *  GET    /debug/variables
 *  GET    /debug/units                 -> find Address Book unit_id
 *  GET    /debug/address-books         -> list address books in unit (requires ZOOM_ADDRESS_BOOK_UNIT_ID)
 *  GET    /debug/webleads              -> find address_book_id for "webleads"
 *
 * New production endpoint:
 *  POST   /address-books/webleads/contacts
 *    Body: { "name": "Pat Example", "email": "pat@example.com", "phone": "+447700900123" }
 *
 * Secrets required:
 *  - ZOOM_ACCOUNT_ID
 *  - ZOOM_CLIENT_ID
 *  - ZOOM_CLIENT_SECRET
 *
 * Recommended:
 *  - ADMIN_TOKEN (protects endpoints)
 *  - ZOOM_VARIABLE_GROUP_ID (locks to the right group without name matching)
 *
 * Address book discovery:
 *  - ZOOM_ADDRESS_BOOK_UNIT_ID (needed to list address books)
 *  - ZOOM_WEBLEADS_ADDRESS_BOOK_ID (recommended once you know it; skips lookup)
 *
 * Optional vars:
 *  - ALLOW_ORIGIN (lock CORS to your site e.g. "https://api.eno.solutions")
 */

const GROUP_NAME = "Eno Solutions Triggers";
const WANT = ["holiday", "open", "vip", "flowVertical"];
const DROPDOWN = [
  "retail","insurance","finance","legal","hotel","restaurant","sales","customer service",
  "automotive","spa","NHS","Please select..."
];

const WEBLEADS_ADDRESS_BOOK_NAME = "webleads";

/* ----------------------------- Helpers: CORS ----------------------------- */

function corsHeaders(origin, allowOriginEnv) {
  const allow = allowOriginEnv || "*";
  const finalOrigin = allow === "*" ? (origin || "*") : allow;

  return {
    "Access-Control-Allow-Origin": finalOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Admin-Token",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(data, { status = 200, origin, allowOriginEnv } = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin, allowOriginEnv),
    },
  });
}

/* --------------------------- Helpers: parsing ---------------------------- */

function firstValue(obj) {
  if (obj && Array.isArray(obj.values) && obj.values.length) return obj.values[0];
  return null;
}

function parseValue(variableName, raw) {
  if (["holiday", "open", "vip"].includes(variableName)) {
    if (raw === true) return true;
    if (raw === false) return false;

    const s = (raw ?? "").toString().trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;

    return false;
  }
  return (raw ?? "").toString();
}

function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return null;
}

/* ----------------------------- Zoom helpers ------------------------------ */

async function getAccessToken(env) {
  const url = new URL("https://zoom.us/oauth/token");
  url.searchParams.set("grant_type", "account_credentials");
  url.searchParams.set("account_id", env.ZOOM_ACCOUNT_ID);

  const basic = btoa(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`);

  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: { Authorization: `Basic ${basic}` },
  });

  const text = await resp.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }

  if (!resp.ok) {
    throw new Error(`Zoom token error ${resp.status}: ${JSON.stringify(body)}`);
  }

  return body.access_token;
}

async function zoomFetch(token, path, opts = {}) {
  const resp = await fetch(`https://api.zoom.us/v2${path}`, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  const text = await resp.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }

  if (!resp.ok) {
    throw new Error(`Zoom API ${resp.status} on ${path}: ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Discover variable IDs by listing variables in the group.
 * Uses ZOOM_VARIABLE_GROUP_ID if provided; otherwise finds group by name.
 */
async function discoverIds(token, env) {
  let groupId = env.ZOOM_VARIABLE_GROUP_ID;

  if (!groupId) {
    const groupsResp = await zoomFetch(token, "/contact_center/variables/groups?page_size=100");
    const groups = groupsResp.variable_groups || groupsResp.groups || [];
    const match = groups.find(g => (g.variable_group_name || g.name) === GROUP_NAME);
    if (!match) throw new Error(`Variable group not found: ${GROUP_NAME}`);
    groupId = match.variable_group_id || match.id || match.variableGroupId;
  }

  const varsResp = await zoomFetch(
    token,
    `/contact_center/variables?variable_group_id=${encodeURIComponent(groupId)}&page_size=100`
  );

  const list = varsResp.variables || varsResp.data || [];
  const byName = {};

  for (const v of list) {
    const n = v.variable_name || v.name;
    const id = v.variable_id || v.id;
    if (n && id) byName[n] = { id, raw: v };
  }

  for (const n of WANT) {
    if (!byName[n]) throw new Error(`Missing variable in group "${GROUP_NAME}": ${n}`);
  }

  return { groupId, byName, raw: varsResp };
}

/* ----------------------- Address book helpers ---------------------------- */

function looksLikeE164(s) {
  return /^\+\d{8,16}$/.test((s || "").trim());
}

function splitName(full) {
  const s = (full || "").trim().replace(/\s+/g, " ");
  if (!s) return { first_name: "", last_name: "" };
  const parts = s.split(" ");
  if (parts.length === 1) return { first_name: parts[0], last_name: "" };
  return { first_name: parts[0], last_name: parts.slice(1).join(" ") };
}

async function getWebleadsAddressBookId(token, env) {
  if (env.ZOOM_WEBLEADS_ADDRESS_BOOK_ID) return env.ZOOM_WEBLEADS_ADDRESS_BOOK_ID;

  const unitId = env.ZOOM_ADDRESS_BOOK_UNIT_ID;
  if (!unitId) {
    throw new Error(
      "Missing address book config. Set secret ZOOM_WEBLEADS_ADDRESS_BOOK_ID (recommended) " +
      "or set ZOOM_ADDRESS_BOOK_UNIT_ID so the Worker can list address books and find 'webleads'."
    );
  }

  let next = "";
  const wanted = WEBLEADS_ADDRESS_BOOK_NAME.toLowerCase();

  while (true) {
    const qs = new URLSearchParams();
    qs.set("page_size", "50");
    qs.set("unit_id", unitId);
    if (next) qs.set("next_page_token", next);

    const resp = await zoomFetch(token, `/contact_center/address_books?${qs.toString()}`);
    const books = resp.address_books || resp.addressBooks || resp.address_book_list || [];

    const match = books.find(b => ((b.address_book_name || b.name || "")).toLowerCase() === wanted);
    if (match) return match.address_book_id || match.id;

    next = resp.next_page_token || "";
    if (!next) break;
  }

  throw new Error(`Address book not found by name: ${WEBLEADS_ADDRESS_BOOK_NAME}`);
}

async function listAddressBooks(token, env) {
  const unitId = env.ZOOM_ADDRESS_BOOK_UNIT_ID;
  if (!unitId) {
    throw new Error("Set secret ZOOM_ADDRESS_BOOK_UNIT_ID first, then try /debug/address-books again.");
  }
  const qs = new URLSearchParams();
  qs.set("page_size", "50");
  qs.set("unit_id", unitId);
  return zoomFetch(token, `/contact_center/address_books?${qs.toString()}`);
}

async function createWebLeadContact(token, env, input) {
  const phone = pick(input, "phone", "phone_number", "phoneNumber");
  const email = pick(input, "email", "email_address", "emailAddress");
  const name = pick(input, "name", "full_name", "fullName");
  const displayName = pick(input, "display_name", "displayName");

  if (!phone || typeof phone !== "string") {
    throw new Error("phone is required (E.164 string like +447700900123).");
  }
  if (!looksLikeE164(phone)) {
    throw new Error(`phone must be E.164 (got: ${phone})`);
  }

  let first_name = pick(input, "first_name", "firstName");
  let last_name = pick(input, "last_name", "lastName");

  if ((!first_name && !last_name) && (name || displayName)) {
    const split = splitName(name || displayName);
    first_name = first_name || split.first_name;
    last_name = last_name || split.last_name;
  }

  const finalDisplay =
    (displayName || name || `${first_name || ""} ${last_name || ""}`.trim() || phone).toString();

  const addressBookId = await getWebleadsAddressBookId(token, env);

  const body = {
    display_name: finalDisplay,
    first_name: (first_name || "").toString(),
    last_name: (last_name || "").toString(),
    emails: email ? [email.toString()] : [],
    phone_numbers: [phone],
    phones: [{ phone_number: phone, phone_type: "main" }],
  };

  return zoomFetch(token, `/contact_center/address_books/${encodeURIComponent(addressBookId)}/contacts`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/* -------------------------------- Worker -------------------------------- */

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";
    const allowOriginEnv = env.ALLOW_ORIGIN || "*";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, allowOriginEnv),
      });
    }

    // Optional protection
    if (env.ADMIN_TOKEN) {
      const t = request.headers.get("X-Admin-Token");
      if (t !== env.ADMIN_TOKEN) {
        return json({ error: "Unauthorized" }, { status: 401, origin, allowOriginEnv });
      }
    }

    const url = new URL(request.url);

    try {
      /* -------------------- NEW: add contact to webleads -------------------- */
      if (request.method === "POST" && url.pathname === "/address-books/webleads/contacts") {
        const body = await request.json().catch(() => ({}));
        const token = await getAccessToken(env);
        const created = await createWebLeadContact(token, env, body);

        return json(
          { ok: true, addressBookName: WEBLEADS_ADDRESS_BOOK_NAME, created },
          { origin, allowOriginEnv }
        );
      }

      /* ----------------------------- DEBUG routes ---------------------------- */

      if (request.method === "GET" && url.pathname === "/debug/units") {
        const token = await getAccessToken(env);
        // FIX: address book "units" live under /contact_center/address_books/units
        const units = await zoomFetch(token, "/contact_center/address_books/units?page_size=50");
        return json(units, { origin, allowOriginEnv });
      }

      if (request.method === "GET" && url.pathname === "/debug/address-books") {
        const token = await getAccessToken(env);
        const books = await listAddressBooks(token, env);
        return json(books, { origin, allowOriginEnv });
      }

      if (request.method === "GET" && url.pathname === "/debug/webleads") {
        const token = await getAccessToken(env);
        const id = await getWebleadsAddressBookId(token, env);
        return json(
          {
            address_book_name: WEBLEADS_ADDRESS_BOOK_NAME,
            address_book_id: id,
            tip: "Recommended: set this as secret ZOOM_WEBLEADS_ADDRESS_BOOK_ID to skip lookup calls."
          },
          { origin, allowOriginEnv }
        );
      }

      // Existing debug: list groups
      if (request.method === "GET" && url.pathname === "/debug/groups") {
        const token = await getAccessToken(env);
        const groupsResp = await zoomFetch(token, "/contact_center/variables/groups?page_size=100");
        const groups = groupsResp.variable_groups || groupsResp.groups || [];
        return json({
          raw: groupsResp,
          simplified: groups.map(g => ({
            name: g.variable_group_name || g.name,
            id: g.variable_group_id || g.id || g.variableGroupId
          }))
        }, { origin, allowOriginEnv });
      }

      // Existing debug: list variables for configured group id
      if (request.method === "GET" && url.pathname === "/debug/variables") {
        const token = await getAccessToken(env);
        const groupId = env.ZOOM_VARIABLE_GROUP_ID;
        if (!groupId) {
          return json(
            { error: "Set ZOOM_VARIABLE_GROUP_ID secret first for /debug/variables" },
            { status: 400, origin, allowOriginEnv }
          );
        }
        const varsResp = await zoomFetch(
          token,
          `/contact_center/variables?variable_group_id=${encodeURIComponent(groupId)}&page_size=100`
        );
        return json(varsResp, { origin, allowOriginEnv });
      }

      /* --------------------------- Existing variables API --------------------------- */

      // GET /variables
      if (request.method === "GET" && url.pathname === "/variables") {
        const token = await getAccessToken(env);
        const ids = await discoverIds(token, env);

        const values = {};
        for (const name of WANT) {
          const id = ids.byName[name].id;
          const v = await zoomFetch(token, `/contact_center/variables/${encodeURIComponent(id)}`);

          const raw =
            firstValue(v) ??
            v.default_value ??
            v.variable_value ??
            v.value ??
            null;

          values[name] = parseValue(name, raw);
        }

        return json({ group: GROUP_NAME, values, dropdownOptions: DROPDOWN }, { origin, allowOriginEnv });
      }

      // PATCH /variables/:name
      const m = url.pathname.match(/^\/variables\/([^/]+)$/);
      if (request.method === "PATCH" && m) {
        const name = decodeURIComponent(m[1]);
        if (!WANT.includes(name)) {
          return json({ error: "Unknown variable" }, { status: 400, origin, allowOriginEnv });
        }

        const body = await request.json().catch(() => ({}));
        const value = body.value;

        // Validate input
        if (["holiday", "open", "vip"].includes(name) && typeof value !== "boolean") {
          return json({ error: "Value must be boolean" }, { status: 400, origin, allowOriginEnv });
        }
        if (name === "flowVertical" && typeof value !== "string") {
          return json({ error: "Value must be string" }, { status: 400, origin, allowOriginEnv });
        }

        const asString = typeof value === "boolean" ? (value ? "true" : "false") : String(value);

        const token = await getAccessToken(env);
        const ids = await discoverIds(token, env);
        const id = ids.byName[name].id;

        const patchBody = {
          default_value: asString,
          values: [asString],
          value,
          variable_value: value
        };

        const updated = await zoomFetch(token, `/contact_center/variables/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(patchBody),
        });

        const after = await zoomFetch(token, `/contact_center/variables/${encodeURIComponent(id)}`);
        const rawAfter =
          firstValue(after) ??
          after.default_value ??
          after.variable_value ??
          after.value ??
          null;

        const actual = parseValue(name, rawAfter);

        return json({ ok: true, requested: value, actual, updated, after }, { origin, allowOriginEnv });
      }

      return json({ error: "Not found" }, { status: 404, origin, allowOriginEnv });
    } catch (e) {
      return json({ error: String(e.message || e) }, { status: 500, origin, allowOriginEnv });
    }
  },
};