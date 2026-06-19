/**
 * Cloudflare Worker - Zoom Contact Center Variables proxy
 *
 * Endpoints:
 *  GET    /variables
 *  PATCH  /variables/:name
 *
 * Existing editable vars are in:
 *   Eno Solutions Triggers
 *
 * Derived read-only vars:
 *   virtualagentinputs.timePeriod
 *   virtualagentinputs.day
 *
 * Secrets required:
 *  - ZOOM_ACCOUNT_ID
 *  - ZOOM_CLIENT_ID
 *  - ZOOM_CLIENT_SECRET
 *
 * Recommended:
 *  - ADMIN_TOKEN
 *  - ZOOM_VARIABLE_GROUP_ID   (for Eno Solutions Triggers group)
 *
 * Optional vars:
 *  - ALLOW_ORIGIN             e.g. "https://api.eno.solutions"
 */

const MAIN_GROUP_NAME = "Eno Solutions Triggers";
const EDITABLE_VARS = ["holiday", "open", "vip", "flowVertical"];
const DROPDOWN = ["retail","insurance","finance","legal","hotel","restaurant","sales","customer service",
  "automotive","spa","NHS","BOT TEST FLOW","Please select..."];

const WEBLEADS_ADDRESS_BOOK_NAME = "webleads";

// If your "day" variable is actually in group "virtualagentinput" (singular),
// change groupName below for day only.
const DERIVED_VARS = {
  timePeriod: {
    groupName: "virtualagentinputs",
    variableName: "timePeriod"
  },
  day: {
    groupName: "virtualagentinputs",
    variableName: "day"
  }
};

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

function parseEditableValue(variableName, raw) {
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

function parseStringValue(raw) {
  return (raw ?? "").toString();
}

function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return null;
}

function getRawVariableValue(v) {
  return (
    firstValue(v) ??
    v.default_value ??
    v.variable_value ??
    v.value ??
    v.current_value ??
    null
  );
}

/* ------------------------ Helpers: London date/time ---------------------- */

function getLondonDerivedValues() {
  const now = new Date();

  const weekday = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "long"
  }).format(now);

  const hourStr = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    hour12: false
  }).format(now);

  const hour = Number(hourStr);

  let timePeriod = "Morning";
  if (hour >= 12 && hour < 18) timePeriod = "Afternoon";
  if (hour >= 18) timePeriod = "Evening";

  return {
    timePeriod,
    day: weekday
  };
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

async function patchVariableString(token, variableId, valueAsString) {
  const patchBody = {
    default_value: valueAsString,
    values: [valueAsString],
    value: valueAsString,
    variable_value: valueAsString
  };

  return zoomFetch(token, `/contact_center/variables/${encodeURIComponent(variableId)}`, {
    method: "PATCH",
    body: JSON.stringify(patchBody),
  });
}

/* ------------------------- Discovery: main group ------------------------- */

async function discoverEditableIds(token, env) {
  let groupId = env.ZOOM_VARIABLE_GROUP_ID;

  if (!groupId) {
    const groupsResp = await zoomFetch(token, "/contact_center/variables/groups?page_size=100");
    const groups = groupsResp.variable_groups || groupsResp.groups || [];

    const group = groups.find(g =>
      ((g.variable_group_name || g.name || "")).trim().toLowerCase()
        === MAIN_GROUP_NAME.trim().toLowerCase()
    );

    if (!group) throw new Error(`Group not found: "${MAIN_GROUP_NAME}"`);

    groupId = pick(group, "variable_group_id", "id", "variableGroupId");
    if (!groupId) throw new Error("Group ID not found in editable group object");
  }

  const varsResp = await zoomFetch(
    token,
    `/contact_center/variables?variable_group_id=${encodeURIComponent(groupId)}&page_size=100`
  );

  const vars = varsResp.variables || varsResp.variable_list || [];

  const byName = {};
  for (const v of vars) {
    const varName = v.variable_name || v.name;
    const varId = v.variable_id || v.id || v.variableId;

    if (EDITABLE_VARS.includes(varName)) {
      byName[varName] = { id: varId };
    }
  }

  for (const n of EDITABLE_VARS) {
    if (!byName[n]?.id) throw new Error(`Variable "${n}" not found in group "${MAIN_GROUP_NAME}"`);
  }

  return { groupId, byName };
}

/* ------------------------ Discovery: derived groups ---------------------- */

async function findGroupIdByName(token, groupName) {
  const groupsResp = await zoomFetch(token, "/contact_center/variables/groups?page_size=100");
  const groups = groupsResp.variable_groups || groupsResp.groups || [];

  const group = groups.find(g =>
    ((g.variable_group_name || g.name || "")).trim().toLowerCase()
      === groupName.trim().toLowerCase()
  );

  if (!group) throw new Error(`Group not found: "${groupName}"`);

  const groupId = pick(group, "variable_group_id", "id", "variableGroupId");
  if (!groupId) throw new Error(`Group ID not found for group "${groupName}"`);

  return groupId;
}

async function findVariableIdInGroup(token, groupId, variableName) {
  const varsResp = await zoomFetch(
    token,
    `/contact_center/variables?variable_group_id=${encodeURIComponent(groupId)}&page_size=100`
  );

  const vars = varsResp.variables || varsResp.variable_list || [];

  const found = vars.find(v =>
    ((v.variable_name || v.name || "")).trim().toLowerCase()
      === variableName.trim().toLowerCase()
  );

  if (!found) throw new Error(`Variable "${variableName}" not found in group ID "${groupId}"`);

  const variableId = pick(found, "variable_id", "id", "variableId");
  if (!variableId) throw new Error(`Variable ID not found for "${variableName}"`);

  return variableId;
}

async function syncDerivedVars(token) {
  const target = getLondonDerivedValues();
  const result = {
    timePeriod: target.timePeriod,
    day: target.day
  };

  for (const key of Object.keys(DERIVED_VARS)) {
    const cfg = DERIVED_VARS[key];
    const desired = target[key];

    const groupId = await findGroupIdByName(token, cfg.groupName);
    const variableId = await findVariableIdInGroup(token, groupId, cfg.variableName);

    const currentObj = await zoomFetch(token, `/contact_center/variables/${encodeURIComponent(variableId)}`);
    const currentRaw = parseStringValue(getRawVariableValue(currentObj));

    if (currentRaw !== desired) {
      await patchVariableString(token, variableId, desired);
    }
  }

  return result;
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

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, allowOriginEnv),
      });
    }

    if (env.ADMIN_TOKEN) {
      const t = request.headers.get("X-Admin-Token");
      if (t !== env.ADMIN_TOKEN) {
        return json({ error: "Unauthorized" }, { status: 401, origin, allowOriginEnv });
      }
    }

    const url = new URL(request.url);
    // Strip /zoom/api prefix so routes match when served via api.eno.solutions/zoom/api/*
    const pathname = url.pathname.replace(/^\/zoom\/api/, '') || '/';

    try {
      // POST /address-books/webleads/contacts
      if (request.method === "POST" && pathname === "/address-books/webleads/contacts") {
        const body = await request.json().catch(() => ({}));
        const token = await getAccessToken(env);
        const created = await createWebLeadContact(token, env, body);
        return json(
          { ok: true, addressBookName: WEBLEADS_ADDRESS_BOOK_NAME, created },
          { origin, allowOriginEnv }
        );
      }

      // GET /debug/units
      if (request.method === "GET" && url.pathname === "/debug/units") {
        const token = await getAccessToken(env);
        const units = await zoomFetch(token, "/contact_center/address_books/units?page_size=50");
        return json(units, { origin, allowOriginEnv });
      }

      // GET /debug/address-books
      if (request.method === "GET" && url.pathname === "/debug/address-books") {
        const token = await getAccessToken(env);
        const books = await listAddressBooks(token, env);
        return json(books, { origin, allowOriginEnv });
      }

      // GET /debug/webleads
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

      // GET /variables
      if (request.method === "GET" && url.pathname === "/variables") {
        const token = await getAccessToken(env);
        const ids = await discoverEditableIds(token, env);

        // 1) Load editable vars
        const values = {};
        for (const name of EDITABLE_VARS) {
          const id = ids.byName[name].id;
          const v = await zoomFetch(token, `/contact_center/variables/${encodeURIComponent(id)}`);
          values[name] = parseEditableValue(name, getRawVariableValue(v));
        }

        // 2) Compute + sync London-derived vars, then include in response
        const derived = await syncDerivedVars(token);
        values.timePeriod = derived.timePeriod;
        values.day = derived.day;

        return json(
          {
            group: MAIN_GROUP_NAME,
            values,
            dropdownOptions: DROPDOWN
          },
          { origin, allowOriginEnv }
        );
      }

      // PATCH /variables/:name  (editable vars only)
      const m = url.pathname.match(/^\/variables\/([^/]+)$/);
      if (request.method === "PATCH" && m) {
        const name = decodeURIComponent(m[1]);

        if (!EDITABLE_VARS.includes(name)) {
          return json({ error: "Unknown or read-only variable" }, { status: 400, origin, allowOriginEnv });
        }

        const body = await request.json().catch(() => ({}));
        const value = body.value;

        if (["holiday", "open", "vip"].includes(name) && typeof value !== "boolean") {
          return json({ error: "Value must be boolean" }, { status: 400, origin, allowOriginEnv });
        }

        if (name === "flowVertical" && typeof value !== "string") {
          return json({ error: "Value must be string" }, { status: 400, origin, allowOriginEnv });
        }

        const asString =
          typeof value === "boolean" ? (value ? "true" : "false") : String(value);

        const token = await getAccessToken(env);
        const ids = await discoverEditableIds(token, env);
        const id = ids.byName[name].id;

        const updated = await patchVariableString(token, id, asString);

        const after = await zoomFetch(token, `/contact_center/variables/${encodeURIComponent(id)}`);
        const rawAfter = getRawVariableValue(after);
        const actual = parseEditableValue(name, rawAfter);

        return json({ ok: true, requested: value, actual, updated, after }, { origin, allowOriginEnv });
      }

      return json({ error: "Not found" }, { status: 404, origin, allowOriginEnv });
    } catch (e) {
      return json({ error: String(e.message || e) }, { status: 500, origin, allowOriginEnv });
    }
  },
};