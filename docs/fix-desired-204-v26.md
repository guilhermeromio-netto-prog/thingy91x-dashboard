# Fix desired PATCH empty 204 — v26

nRF Cloud `PATCH /v1/devices/{id}/state` often returns **HTTP 204 No Content** (empty body).

**Bug:** Express `res.status(204).json(...)` strips the body; frontend `nrfFetch` always called `res.json()` → `Unexpected end of JSON input`. Catch wrongly hinted only 401/Simple Token.

**Fix (v26):**
- `app.js` `nrfFetch`: read `res.text()`, parse JSON only if non-empty; else `{ ok: true, empty: true }`.
- `proxy.js` / Netlify: for `nrf-state` / `nrf-c2d` success with 204 or empty body → **200** + `{ ok: true, kind, deviceId, desired? }`. Never forward bare 204 to the SPA (OPTIONS still 204).

Test: `https://guilhermeromio-netto-prog.github.io/thingy91x-dashboard/?v=26` or localhost after restart + hard refresh.
