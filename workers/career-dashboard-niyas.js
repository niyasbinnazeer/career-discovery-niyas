// career-dashboard-niyas.js
// Cloudflare Worker serving the interactive Career Intelligence Dashboard for Niyas N.
// Provides paginated KV reads, status pipeline updates, direct-apply link resolution,
// client-side deduping, and CSV export.

const SECRET_KEY = "niyas-2026";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    const key = url.searchParams.get("key");
    if (key !== SECRET_KEY) {
      return new Response("Unauthorized. Add ?key=YOUR_SECRET to the URL.", {
        status: 401,
        headers: { "Content-Type": "text/plain" }
      });
    }

    if (url.pathname === "/api/jobs" && request.method === "GET") {
      try {
        // Cutoff: Only return jobs created >= 1788751321543 (the single preserved Siemens job
        // and all subsequent new jobs). This completely ignores the 3,786 historical jobs from
        // 65 days ago that cause 15s loading lag and expired/unreachable links.
        const CUTOFF = 1788751321543;
        let matchedKeys = [];
        let cursor = undefined;
        do {
          const page = await env.JOBS_KV.list({ prefix: "jobs:", limit: 1000, cursor });
          for (const k of page.keys) {
            const parts = k.name.replace("jobs:", "").split("-");
            const ts = parseInt(parts[0], 10);
            if (!isNaN(ts)) {
              if (ts >= CUTOFF) matchedKeys.push(k);
            } else {
              matchedKeys.push(k);
            }
          }
          cursor = page.list_complete ? null : page.cursor;
        } while (cursor);

        const jobs = [];
        const BATCH = 64;
        for (let i = 0; i < matchedKeys.length; i += BATCH) {
          const values = await Promise.all(matchedKeys.slice(i, i + BATCH).map(k => env.JOBS_KV.get(k.name)));
          for (const value of values) {
            if (value) { try { jobs.push(JSON.parse(value)); } catch {} }
          }
        }
        return jsonResponse({
          jobs,
          count: jobs.length,
          cursor: null,
          list_complete: true
        });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    if (url.pathname.startsWith("/api/jobs/") && request.method === "PUT") {
      try {
        const id = url.pathname.split("/").pop();
        const updates = await request.json();
        const existing = await env.JOBS_KV.get(`jobs:${id}`);
        if (!existing) return jsonResponse({ error: "Not found" }, 404);
        const record = JSON.parse(existing);
        Object.assign(record, updates);
        if (updates.status === "applied" && !record.appliedAt) {
          record.appliedAt = Date.now();
        }
        await env.JOBS_KV.put(`jobs:${id}`, JSON.stringify(record));
        return jsonResponse({ ok: true, record });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    if (url.pathname.startsWith("/api/jobs/") && request.method === "DELETE") {
      try {
        const id = url.pathname.split("/").pop();
        await env.JOBS_KV.delete(`jobs:${id}`);
        return jsonResponse({ ok: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // Resolve the real destination of an aggregator's "Apply" button (Adzuna / Jooble)
    // and cache it on the record. Called lazily by the dashboard when an international
    // job is opened. Browsers can't read cross-origin, so this runs server-side.
    if (url.pathname === "/api/resolve" && request.method === "GET") {
      try {
        const id = url.searchParams.get("id");
        if (!id) return jsonResponse({ error: "id required" }, 400);
        const existing = await env.JOBS_KV.get(`jobs:${id}`);
        if (!existing) return jsonResponse({ error: "Not found" }, 404);
        const record = JSON.parse(existing);
        if (record.directApplyUrl) return jsonResponse({ directApplyUrl: record.directApplyUrl });
        const u = record.url || "";
        if (!/adzuna\.|jooble\.org/i.test(u)) return jsonResponse({ directApplyUrl: "" });
        const dest = await resolveApplyLink(u);
        if (dest && dest !== u) {
          record.directApplyUrl = dest;
          await env.JOBS_KV.put(`jobs:${id}`, JSON.stringify(record));
          return jsonResponse({ directApplyUrl: dest });
        }
        return jsonResponse({ directApplyUrl: "" });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    if (url.pathname === "/api/dedup" && request.method === "POST") {
      try {
        let keys = [], cursor;
        do {
          const page = await env.JOBS_KV.list({ prefix: "jobs:", cursor });
          keys.push(...page.keys);
          cursor = page.list_complete ? null : page.cursor;
        } while (cursor);
        const records = [];
        const BATCH = 64;
        for (let i = 0; i < keys.length; i += BATCH) {
          const vals = await Promise.all(keys.slice(i, i + BATCH).map(k => env.JOBS_KV.get(k.name).then(v => ({ name: k.name, v }))));
          for (const { name, v } of vals) {
            if (v) { try { records.push({ key: name, rec: JSON.parse(v) }); } catch {} }
          }
        }
        const groups = {};
        for (const r of records) {
          const u = (r.rec.url || "").split("?")[0];
          if (!u) continue;
          (groups[u] = groups[u] || []).push(r);
        }
        let deleted = 0;
        for (const u in groups) {
          const grp = groups[u];
          if (grp.length <= 1) continue;
          grp.sort((a, b) => (b.rec.timestamp || 0) - (a.rec.timestamp || 0));
          for (let i = 1; i < grp.length; i++) {
            await env.JOBS_KV.delete(grp[i].key);
            deleted++;
          }
        }
        return jsonResponse({ ok: true, deleted, scanned: records.length });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // Batch purge endpoint for database cleanup (deletes in safe batches, preserving keepId)
    if (url.pathname === "/api/purge-batch" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const keepId = body.keepId || url.searchParams.get("keepId") || "";
        const limit = Math.min(parseInt(body.limit || url.searchParams.get("limit") || "300", 10), 400);
        const cursor = body.cursor || url.searchParams.get("cursor") || undefined;

        const page = await env.JOBS_KV.list({ prefix: "jobs:", limit, cursor });
        let deleted = 0;
        const toDelete = page.keys.filter(k => !keepId || k.name !== `jobs:${keepId}`);
        const BATCH = 32;
        for (let i = 0; i < toDelete.length; i += BATCH) {
          const slice = toDelete.slice(i, i + BATCH);
          await Promise.all(slice.map(k => env.JOBS_KV.delete(k.name)));
          deleted += slice.length;
        }
        return jsonResponse({
          ok: true,
          deleted,
          cursor: page.list_complete ? null : page.cursor,
          list_complete: !!page.list_complete,
          scanned: page.keys.length
        });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // 15-day unattended auto-delete endpoint
    // Deletes jobs where status is "new" (unattended, no notes, no checklist) and timestamp > maxDays (default 15)
    if ((url.pathname === "/api/cleanup-stale" || url.pathname === "/api/purge-stale") && request.method === "POST") {
      try {
        const maxDays = parseInt(url.searchParams.get("days") || "15", 10);
        const cutoffMs = Date.now() - (maxDays * 86400000);
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "300", 10), 400);
        const cursor = url.searchParams.get("cursor") || undefined;

        const page = await env.JOBS_KV.list({ prefix: "jobs:", limit, cursor });
        let deleted = 0;
        let examined = 0;
        const BATCH = 32;
        for (let i = 0; i < page.keys.length; i += BATCH) {
          const slice = page.keys.slice(i, i + BATCH);
          const vals = await Promise.all(slice.map(k => env.JOBS_KV.get(k.name).then(v => ({ name: k.name, v }))));
          for (const item of vals) {
            examined++;
            if (!item.v) continue;
            try {
              const rec = JSON.parse(item.v);
              const ts = rec.timestamp || 0;
              const status = rec.status || "new";
              const notes = (rec.notes || "").trim();
              const hasChecklist = Object.values(rec.checklistState || {}).some(Boolean);
              const isAttended = status !== "new" || notes.length > 0 || hasChecklist;
              if (!isAttended && ts > 0 && ts < cutoffMs) {
                await env.JOBS_KV.delete(item.name);
                deleted++;
              }
            } catch {}
          }
        }
        return jsonResponse({
          ok: true,
          deleted,
          examined,
          cursor: page.list_complete ? null : page.cursor,
          list_complete: !!page.list_complete
        });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    return new Response(DASHBOARD_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

const RESOLVE_UA = "Mozilla/5.0 (compatible; CareerDashboard/1.0)";

async function followRedirects(url, maxHops = 6) {
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    let res;
    try {
      res = await fetch(current, { method: "GET", redirect: "manual", headers: { "User-Agent": RESOLVE_UA }, signal: AbortSignal.timeout(7000) });
    } catch { return current; }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return current;
      try { current = new URL(loc, current).href; } catch { return current; }
      continue;
    }
    return current;
  }
  return current;
}

function adzunaLandForm(u) {
  const m = u.match(/^(https?:\/\/[^/]+adzuna\.[^/]+)\/(?:[^?]*\/)?(?:details|land\/ad)\/(\d+)/i);
  return m ? m[1] + "/land/ad/" + m[2] : u;
}

async function extractJoobleApplyLink(jdpUrl) {
  let html;
  try {
    const res = await fetch(jdpUrl, { headers: { "User-Agent": RESOLVE_UA }, signal: AbortSignal.timeout(7000) });
    if (!res.ok) return "";
    html = await res.text();
  } catch { return ""; }
  let m = html.match(/https?:\/\/[a-z]*\.?jooble\.org\/away\/[^"'\\\s]+/i) || html.match(/\/away\/[A-Za-z0-9_%\-]+/i);
  if (m) { try { return new URL(m[0], jdpUrl).href; } catch { return ""; } }
  m = html.match(/"@type"\s*:\s*"JobPosting"[\s\S]{0,3000}?"url"\s*:\s*"([^"]+)"/i);
  if (m && !/jooble\.org/i.test(m[1])) return m[1].replace(/\\\//g, "/");
  return "";
}

async function resolveApplyLink(url) {
  try {
    if (/jooble\.org/i.test(url)) {
      const away = await extractJoobleApplyLink(url);
      if (!away) return "";
      const dest = await followRedirects(away);
      return /jooble\.org/i.test(dest) ? "" : dest;
    }
    if (/adzuna\./i.test(url)) {
      const dest = await followRedirects(adzunaLandForm(url));
      return /adzuna\./i.test(dest) ? "" : dest;
    }
    return "";
  } catch { return ""; }
}

const DASHBOARD_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Career Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/tabler-icons.min.css">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#fafafa; --card:#ffffff; --border:#e5e5e5; --border-strong:#d4d4d8;
  --text:#18181b; --muted:#71717a; --subtle:#a1a1aa;
  --accent:#4f46e5; --accent-light:#eef2ff;
  --success:#16a34a; --success-light:#dcfce7;
  --warn:#d97706; --warn-light:#fef3c7;
  --danger:#dc2626; --danger-light:#fee2e2;
  --info:#0891b2; --info-light:#cffafe;
}
html,body{height:100%}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;
  background:var(--bg); color:var(--text); line-height:1.5;
  font-size:14px; -webkit-font-smoothing:antialiased;
}
.wrap{max-width:1280px; margin:0 auto; padding:32px 24px 60px}
.header{display:flex; align-items:center; justify-content:space-between; margin-bottom:24px; gap:16px; flex-wrap:wrap}
.brand{display:flex; align-items:center; gap:12px; cursor:pointer}
.brand-icon{width:42px;height:42px;border-radius:11px;background:linear-gradient(135deg,#4f46e5,#7c3aed);display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;box-shadow:0 1px 3px rgba(79,70,229,0.3)}
.brand-text h1{font-size:20px;font-weight:600;letter-spacing:-0.02em;color:var(--text)}
.brand-text p{font-size:13px;color:var(--muted);margin-top:1px}
.header-actions{display:flex;gap:8px;align-items:center}
.btn-ghost{display:inline-flex; align-items:center; gap:6px; padding:8px 14px; background:var(--card); border:0.5px solid var(--border); border-radius:9px; font-size:13px; font-weight:500; color:var(--text); cursor:pointer; transition:all 0.15s}
.btn-ghost:hover{background:#f4f4f5; border-color:var(--border-strong)}
.btn-ghost i{font-size:14px; color:var(--muted)}
.breadcrumb{display:flex; align-items:center; gap:7px; font-size:13px; color:var(--muted); margin-bottom:20px}
.breadcrumb a{color:var(--accent); text-decoration:none; cursor:pointer}
.breadcrumb a:hover{text-decoration:underline}
.breadcrumb i{font-size:13px; color:var(--subtle)}
.landing-hero{text-align:center; padding:24px 0 36px}
.landing-hero h2{font-size:26px; font-weight:700; letter-spacing:-0.03em; margin-bottom:8px}
.landing-hero p{font-size:14px; color:var(--muted); max-width:520px; margin:0 auto}
.section-cards{display:grid; grid-template-columns:repeat(2,1fr); gap:16px; margin-bottom:32px}
.section-card{background:var(--card); border:0.5px solid var(--border); border-radius:18px; padding:26px 24px; cursor:pointer; transition:all 0.2s ease; position:relative; overflow:hidden; display:flex; flex-direction:column; gap:16px; min-height:200px}
.section-card:hover{border-color:var(--border-strong); box-shadow:0 4px 16px rgba(0,0,0,0.06); transform:translateY(-2px)}
.section-card::after{content:''; position:absolute; inset:0; opacity:0.04; pointer-events:none}
.sc-india::after{background:radial-gradient(circle at 80% 20%, #16a34a, transparent 60%)}
.sc-intl::after{background:radial-gradient(circle at 80% 20%, #4f46e5, transparent 60%)}
.sc-icon{width:48px; height:48px; border-radius:13px; display:flex; align-items:center; justify-content:center; font-size:24px}
.sc-india .sc-icon{background:var(--success-light); color:var(--success)}
.sc-intl .sc-icon{background:var(--accent-light); color:var(--accent)}
.sc-body{flex:1}
.sc-title{font-size:18px; font-weight:600; letter-spacing:-0.02em; margin-bottom:4px}
.sc-sub{font-size:13px; color:var(--muted); line-height:1.5}
.sc-foot{display:flex; align-items:center; justify-content:space-between; padding-top:14px; border-top:0.5px solid var(--border)}
.sc-count{font-size:13px; color:var(--text); font-weight:600}
.sc-count span{color:var(--muted); font-weight:400}
.sc-arrow{color:var(--subtle); font-size:18px; transition:transform 0.15s}
.section-card:hover .sc-arrow{transform:translateX(3px); color:var(--accent)}
.stats-bar{background:var(--card); border:0.5px solid var(--border); border-radius:16px; padding:22px 24px; margin-bottom:24px; display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:0; position:relative; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.02)}
.stat{padding:0 22px; position:relative}
.stat:not(:last-child)::after{content:''; position:absolute; right:0; top:50%; transform:translateY(-50%); width:1px; height:42px; background:var(--border)}
.stat-label{font-size:11px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:0.09em; margin-bottom:8px}
.stat-value{font-size:26px; font-weight:700; color:var(--text); letter-spacing:-0.03em; line-height:1}
.stat-change{font-size:11px; color:var(--subtle); margin-top:5px; font-weight:500}
.stat-apply .stat-value{color:var(--success)}
.stat-consider .stat-value{color:var(--warn)}
.stat-reject .stat-value{color:var(--danger)}
.country-tabs{display:flex; gap:6px; margin-bottom:18px; flex-wrap:wrap; border-bottom:0.5px solid var(--border); padding-bottom:0}
.country-tab{padding:9px 15px; border:none; background:transparent; border-radius:9px 9px 0 0; font-size:13px; font-weight:500; color:var(--muted); cursor:pointer; display:inline-flex; align-items:center; gap:7px; transition:all 0.15s; position:relative; bottom:-0.5px; border-bottom:2px solid transparent}
.country-tab:hover{color:var(--text); background:#f4f4f5}
.country-tab.active{color:var(--accent); border-bottom-color:var(--accent); font-weight:600}
.country-tab .flag{font-size:15px}
.country-tab .count{font-size:11px; background:#f4f4f5; color:var(--muted); padding:1px 7px; border-radius:99px; font-weight:600}
.country-tab.active .count{background:var(--accent-light); color:var(--accent)}
.controls-card{background:var(--card); border:0.5px solid var(--border); border-radius:14px; padding:12px 16px; margin-bottom:18px; display:flex; flex-direction:column; gap:10px; box-shadow:0 1px 2px rgba(0,0,0,0.02)}
.controls-row-main{display:flex; gap:10px; flex-wrap:wrap; align-items:center}
.controls-row-filters{display:flex; gap:12px; flex-wrap:wrap; align-items:center; padding-top:8px; border-top:0.5px solid var(--border)}
.search-wrap{position:relative; flex:1; min-width:220px}
.search-wrap i{position:absolute; left:13px; top:50%; transform:translateY(-50%); color:var(--subtle); font-size:15px; pointer-events:none}
.search-input{width:100%; padding:9px 14px 9px 38px; background:#fafafa; border:0.5px solid var(--border); border-radius:9px; font-size:13px; color:var(--text); transition:all 0.15s; font-family:inherit}
.search-input:focus{outline:none; border-color:var(--accent); background:#fff}
.search-input::placeholder{color:var(--subtle)}
.filter-group-inline{display:inline-flex; align-items:center; gap:5px; flex-wrap:wrap}
.filter-group-label{font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); margin-right:2px}
.filter-pill-check{padding:5px 10px; border:0.5px solid var(--border); background:var(--card); border-radius:7px; font-size:12px; font-weight:500; color:var(--muted); cursor:pointer; display:inline-flex; align-items:center; gap:4px; transition:all 0.15s; user-select:none}
.filter-pill-check:hover{border-color:var(--border-strong); color:var(--text)}
.filter-pill-check.active{background:var(--text); color:#fff; border-color:var(--text)}
.filter-pill-check.active-apply{background:var(--success-light); border-color:#86efac; color:#15803d; font-weight:600}
.filter-pill-check.active-consider{background:var(--warn-light); border-color:#fde68a; color:#a16207; font-weight:600}
.filter-pill-check.active-reject{background:var(--danger-light); border-color:#fca5a5; color:#b91c1c; font-weight:600}
.filter-select-custom{padding:7px 26px 7px 10px; background:var(--card) url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2.5'><polyline points='6 9 12 15 18 9'/></svg>") no-repeat right 8px center; border:0.5px solid var(--border); border-radius:8px; font-size:12px; font-weight:500; color:var(--text); cursor:pointer; appearance:none; font-family:inherit}
.filter-select-custom:focus{outline:none; border-color:var(--accent)}
.reset-btn{padding:4px 8px; background:transparent; border:none; font-size:11.5px; color:var(--danger); cursor:pointer; display:inline-flex; align-items:center; gap:4px; font-weight:500; border-radius:6px; margin-left:auto}
.reset-btn:hover{background:var(--danger-light)}
.day-chip{display:inline-flex; align-items:center; gap:4px; font-size:11px; font-weight:600; padding:2px 7px; border-radius:6px; border:0.5px solid}
.day-today{background:#dcfce7; color:#15803d; border-color:#86efac}
.day-recent{background:#e0f2fe; color:#0369a1; border-color:#bae6fd}
.day-older{background:#f4f4f5; color:#52525b; border-color:#e4e4e7}
.sort-select{padding:8px 28px 8px 11px; background:var(--card) url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2.5'><polyline points='6 9 12 15 18 9'/></svg>") no-repeat right 8px center; border:0.5px solid var(--border); border-radius:8px; font-size:12px; font-weight:500; color:var(--text); cursor:pointer; appearance:none; font-family:inherit}
.sort-select:focus{outline:none; border-color:var(--accent)}
.jobs{display:flex; flex-direction:column; gap:8px}
.job{background:var(--card); border:0.5px solid var(--border); border-radius:14px; padding:16px 20px; display:grid; grid-template-columns:64px 1fr auto; gap:16px; align-items:center; cursor:pointer; transition:all 0.2s ease; position:relative}
.job:hover{border-color:var(--border-strong); box-shadow:0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.02); transform:translateY(-1px)}
.score-badge{width:60px; height:60px; border-radius:50%; display:flex; flex-direction:column; align-items:center; justify-content:center; flex-shrink:0; font-weight:700; font-size:19px; letter-spacing:-0.02em; border:3px solid}
.score-apply{background:#f0fdf4; color:#15803d; border-color:#86efac}
.score-consider{background:#fefce8; color:#a16207; border-color:#fde68a}
.score-reject{background:#fef2f2; color:#b91c1c; border-color:#fecaca}
.score-badge .score-pct{font-size:8px; opacity:0.75; font-weight:600; letter-spacing:0.06em; margin-top:-2px}
.job-main{min-width:0}
.job-title{font-size:15px; font-weight:600; color:var(--text); margin-bottom:6px; letter-spacing:-0.015em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.job-meta{display:flex; flex-wrap:wrap; gap:12px; font-size:12px; color:var(--muted); align-items:center}
.job-company{display:inline-flex; align-items:center; gap:5px; font-size:12.5px; color:var(--text); font-weight:600; letter-spacing:-0.005em}
.job-company i{font-size:13px; color:var(--accent); opacity:0.7}
.job-meta-item{display:inline-flex; align-items:center; gap:4px}
.job-meta-item i{font-size:12px; opacity:0.65}
.visa-chip{font-size:10.5px; padding:2px 8px; border-radius:99px; font-weight:600; display:inline-flex; align-items:center; gap:3px; border:0.5px solid}
.visa-Offered{background:var(--success-light); color:#15803d; border-color:#86efac}
.visa-Notoffered{background:var(--danger-light); color:#b91c1c; border-color:#fca5a5}
.visa-Notstated{background:#f4f4f5; color:var(--muted); border-color:var(--border)}
.job-tags{display:flex; gap:5px; margin-top:9px; flex-wrap:wrap}
.mini-tag{font-size:11px; padding:3px 8px; border-radius:6px; line-height:1.3; font-weight:500; display:inline-flex; align-items:center; gap:3px}
.mini-tag-s{background:#f0fdf4; color:#15803d}
.mini-tag-g{background:#fefce8; color:#a16207}
.job-side{display:flex; align-items:center; gap:8px; flex-shrink:0}
.status-select{padding:6px 24px 6px 10px; border-radius:7px; font-size:11px; font-weight:500; cursor:pointer; appearance:none; border:0.5px solid; font-family:inherit; background-position:right 7px center; background-repeat:no-repeat; background-size:9px; background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.5'><polyline points='6 9 12 15 18 9'/></svg>")}
.status-new{background:#fafafa; color:#71717a; border-color:#e5e5e5}
.status-applied{background:#eef2ff; color:#4338ca; border-color:#c7d2fe}
.status-interview{background:#fef3c7; color:#a16207; border-color:#fde68a}
.status-offered{background:#dcfce7; color:#15803d; border-color:#86efac}
.status-rejected{background:#fee2e2; color:#b91c1c; border-color:#fecaca}
.icon-btn{width:30px; height:30px; border:0.5px solid var(--border); border-radius:7px; background:var(--card); cursor:pointer; display:flex; align-items:center; justify-content:center; color:var(--muted); transition:all 0.15s}
.icon-btn:hover{background:#f4f4f5; color:var(--text)}
.icon-btn i{font-size:14px}
.empty{text-align:center; padding:70px 20px; color:var(--muted)}
.empty-icon{width:64px;height:64px;background:#f4f4f5;border-radius:16px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;color:var(--subtle);font-size:30px}
.empty h3{font-size:15px; color:var(--text); font-weight:500; margin-bottom:6px}
.empty p{font-size:13px; line-height:1.6}
.loading{text-align:center; padding:80px 20px}
.spin{width:36px; height:36px; border:3px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:spin 0.7s linear infinite; margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
.loading p{font-size:13px; color:var(--muted)}
.drawer-bg{position:fixed; inset:0; background:rgba(24,24,27,0.45); backdrop-filter:blur(6px); display:none; z-index:100; opacity:0; transition:opacity 0.2s; align-items:flex-start; justify-content:center; padding:40px 20px; overflow-y:auto}
.drawer-bg.open{display:flex; opacity:1}
.drawer{background:var(--card); width:100%; max-width:600px; max-height:calc(100vh - 80px); overflow-y:auto; border-radius:18px; box-shadow:0 20px 50px rgba(0,0,0,0.15), 0 8px 16px rgba(0,0,0,0.08); transform:scale(0.96) translateY(10px); opacity:0; transition:all 0.22s ease-out; display:flex; flex-direction:column; margin:auto 0}
.drawer-bg.open .drawer{transform:scale(1) translateY(0); opacity:1}
.drawer-header{padding:32px 28px 24px; border-bottom:0.5px solid var(--border); background:linear-gradient(180deg, #fafafa 0%, #ffffff 100%); border-radius:18px 18px 0 0; text-align:center; position:relative}
.drawer-close{position:absolute; top:16px; right:16px; width:32px; height:32px; background:transparent; border:none; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; color:var(--muted); transition:all 0.15s}
.drawer-close:hover{background:#f4f4f5; color:var(--text)}
.drawer-close i{font-size:18px}
.score-ring-wrap{position:relative; width:128px; height:128px; margin:0 auto 16px}
.score-ring-bg{fill:none; stroke:#f4f4f5; stroke-width:8}
.score-ring-fg{fill:none; stroke-width:8; stroke-linecap:round; transform:rotate(-90deg); transform-origin:center; transition:stroke-dashoffset 0.8s ease-out}
.score-ring-num{position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center}
.score-ring-val{font-size:34px; font-weight:700; line-height:1; letter-spacing:-0.03em; color:var(--text)}
.score-ring-lbl{font-size:10px; color:var(--subtle); margin-top:3px; text-transform:uppercase; letter-spacing:0.08em; font-weight:600}
.drawer-rec-row{display:flex; justify-content:center; margin-bottom:14px}
.drawer-title{font-size:20px; font-weight:600; letter-spacing:-0.025em; line-height:1.25; color:var(--text); margin-bottom:5px}
.drawer-subtitle{font-size:12px; color:var(--muted); line-height:1.5}
.rec-pill{display:inline-flex; align-items:center; gap:5px; padding:4px 10px; border-radius:999px; font-size:11px; font-weight:500; border:0.5px solid; margin-top:6px}
.rec-Apply{background:var(--success-light); color:#166534; border-color:#86efac}
.rec-Consider{background:var(--warn-light); color:#92400e; border-color:#fcd34d}
.rec-Reject{background:var(--danger-light); color:#991b1b; border-color:#fca5a5}
.drawer-body{padding:20px 24px 80px}
.facts-grid{display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:14px}
.fact{background:linear-gradient(180deg, #fafafa 0%, #f4f4f5 100%); border:0.5px solid var(--border); border-radius:12px; padding:14px 16px; transition:all 0.15s}
.fact:hover{border-color:var(--border-strong)}
.fact-label{font-size:10px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:0.09em; margin-bottom:6px; display:flex; align-items:center; gap:5px}
.fact-label i{font-size:12px; color:var(--accent)}
.fact-value{font-size:14px; font-weight:500; color:var(--text); line-height:1.35; letter-spacing:-0.005em}
.fact-value.empty{color:var(--subtle); font-weight:400; font-style:italic; font-size:13px}
.signal-row{display:flex; gap:12px; align-items:flex-start; background:linear-gradient(180deg, #fafaff 0%, #f5f3ff 100%); border:0.5px solid #e9d5ff; border-radius:12px; padding:14px 16px; margin-bottom:22px}
.signal-row-icon{width:32px; height:32px; border-radius:9px; background:#ffffff; border:0.5px solid #d8b4fe; display:flex; align-items:center; justify-content:center; color:#7c3aed; font-size:16px; flex-shrink:0}
.signal-row-body{flex:1; min-width:0}
.signal-row-label{font-size:10px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:0.09em; margin-bottom:5px}
.signal-row-value{margin-bottom:6px}
.signal-row-note{font-size:12px; color:#52525b; line-height:1.55}
.section-d{margin-bottom:24px}
.section-d-title{font-size:11px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:0.1em; margin-bottom:12px; display:flex; align-items:center; gap:7px}
.section-d-title i{font-size:13px; color:var(--accent)}
.section-body{font-size:13px; color:var(--text); line-height:1.65}
.tag-list{display:flex; flex-wrap:wrap; gap:6px}
.tag{display:inline-flex; align-items:center; gap:5px; font-size:12px; padding:6px 11px; border-radius:8px; line-height:1.3; border:0.5px solid; font-weight:500}
.tag i{font-size:11px}
.tag-s{background:#f0fdf4; color:#15803d; border-color:#bbf7d0}
.tag-g{background:#fefce8; color:#a16207; border-color:#fde68a}
.tip-list{display:flex; flex-direction:column; gap:8px}
.tip{display:flex; gap:12px; padding:12px 14px; background:var(--card); border-radius:11px; border:0.5px solid var(--border); transition:all 0.15s}
.tip:hover{border-color:var(--border-strong); background:#fafafa}
.tip-num{width:22px; height:22px; border-radius:50%; background:linear-gradient(135deg, var(--accent), #7c3aed); color:#fff; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:600; flex-shrink:0; margin-top:1px; box-shadow:0 1px 2px rgba(79,70,229,0.2)}
.tip-text{font-size:13px; color:var(--text); line-height:1.55}
.checklist{display:flex; flex-direction:column; gap:6px}
.check-item{display:flex; gap:11px; padding:11px 14px; background:var(--card); border-radius:10px; border:0.5px solid var(--border); cursor:pointer; transition:all 0.15s; align-items:flex-start}
.check-item:hover{border-color:var(--border-strong); background:#fafafa}
.check-item.done{background:#f0fdf4; border-color:#bbf7d0}
.check-item.done .check-text{color:#15803d; text-decoration:line-through; opacity:0.7}
.check-box{width:19px; height:19px; border:1.5px solid var(--border-strong); border-radius:6px; flex-shrink:0; display:flex; align-items:center; justify-content:center; margin-top:1px; transition:all 0.15s}
.check-item.done .check-box{background:var(--success); border-color:var(--success); color:#fff}
.check-box i{font-size:12px; opacity:0; transition:opacity 0.15s}
.check-item.done .check-box i{opacity:1}
.check-text{font-size:13px; color:var(--text); line-height:1.5; flex:1}
.notes-textarea{width:100%; min-height:80px; padding:12px 14px; background:var(--card); border:0.5px solid var(--border); border-radius:10px; font-family:inherit; font-size:13px; line-height:1.5; color:var(--text); resize:vertical}
.notes-textarea:focus{outline:none; border-color:var(--accent)}
.notes-status{font-size:11px; color:var(--muted); margin-top:6px; height:14px}
.signal-badge{display:inline-flex; align-items:center; gap:5px; padding:4px 10px; border-radius:7px; font-size:12px; font-weight:500; border:0.5px solid}
.signal-Top{background:#dcfce7; color:#15803d; border-color:#86efac}
.signal-Good{background:#dbeafe; color:#1e40af; border-color:#93c5fd}
.signal-Unknown{background:#f4f4f5; color:#52525b; border-color:#d4d4d8}
.signal-Caution{background:#fee2e2; color:#b91c1c; border-color:#fecaca}
.drawer-footer{position:sticky; bottom:0; background:var(--card); border-top:0.5px solid var(--border); padding:14px 24px; display:flex; gap:8px; flex-wrap:wrap; border-radius:0 0 18px 18px}
.btn-view{padding:11px 14px; background:var(--card); color:var(--text); border:0.5px solid var(--border); border-radius:10px; font-size:13px; font-weight:500; cursor:pointer; display:inline-flex; align-items:center; gap:6px; transition:all 0.15s; font-family:inherit; white-space:nowrap}
.btn-apply-direct{padding:11px 14px; background:var(--accent); color:#fff; border:none; border-radius:10px; font-size:13px; font-weight:500; cursor:pointer; display:inline-flex; align-items:center; gap:6px; transition:opacity 0.15s; font-family:inherit; white-space:nowrap}
.btn-apply-direct:hover{opacity:0.88}
.btn-apply-direct i{font-size:14px}
.btn-view:hover{background:#f4f4f5; border-color:var(--border-strong)}
.btn-view i{font-size:14px; color:var(--muted)}
.btn-primary{flex:1; padding:11px 16px; background:var(--text); color:#fff; border:none; border-radius:10px; font-size:13px; font-weight:500; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; gap:6px; transition:opacity 0.15s; font-family:inherit}
.btn-primary:hover{opacity:0.85}
.btn-primary i{font-size:14px}
.btn-danger{padding:11px 14px; background:var(--card); color:var(--danger); border:0.5px solid #fca5a5; border-radius:10px; font-size:13px; font-weight:500; cursor:pointer; display:inline-flex; align-items:center; gap:6px; transition:all 0.15s; font-family:inherit}
.btn-danger:hover{background:var(--danger-light)}
@media (max-width: 860px){
  .section-cards{grid-template-columns:1fr}
  .stats-bar{grid-template-columns:repeat(2, 1fr); gap:14px}
  .stat:not(:last-child)::after{display:none}
  .stat{padding:0}
  .job{grid-template-columns:48px 1fr; gap:12px}
  .job-side{grid-column:1/-1; justify-content:flex-end}
  .facts-grid{grid-template-columns:1fr}
  .drawer{max-width:100%}
}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="brand" onclick="goHome()">
      <div class="brand-icon"><i class="ti ti-sparkles"></i></div>
      <div class="brand-text">
        <h1>Career Dashboard</h1>
        <p>Niyas N</p>
      </div>
    </div>
    <div class="header-actions">
      <button class="btn-ghost" onclick="load()" title="Refresh"><i class="ti ti-refresh"></i>Refresh</button>
      <button class="btn-ghost" onclick="cleanStaleJobs()" title="Auto-delete unattended jobs older than 15 days"><i class="ti ti-clock-x"></i>Clean unattended (&gt;15d)</button>
      <button class="btn-ghost" onclick="dedupJobs()" title="Remove duplicate entries"><i class="ti ti-copy-off"></i>Remove duplicates</button>
      <button class="btn-ghost" onclick="exportCSV()"><i class="ti ti-download"></i>Export</button>
    </div>
  </div>
  <div id="view"></div>
</div>
<div class="drawer-bg" id="drawer-bg" onclick="if(event.target===this)closeDrawer()">
  <div class="drawer" id="drawer"></div>
</div>
<script>
const KEY = new URLSearchParams(location.search).get('key');
let allJobs = [];
let currentDetailId = null;
let route = 'home';
let section = null;
let activeCountry = null;
let selectedRecs = new Set();
let selectedStatuses = new Set();
let selectedCategories = new Set();
let selectedRecency = 'all';
const FLAGS = {India:'🇮🇳', USA:'🇺🇸', Canada:'🇨🇦', UK:'🇬🇧', Germany:'🇩🇪', Europe:'🇪🇺', Australia:'🇦🇺', 'South Korea':'🇰🇷', China:'🇨🇳', UAE:'🇦🇪', Singapore:'🇸🇬', Remote:'🌐', Other:'📍'};
const INTL_COUNTRIES = ['USA','Canada','UK','Germany','Europe','Australia','South Korea','China','UAE','Singapore','Remote','Other'];
function jobCountry(j){
  let c = (j.analysis && j.analysis.country) || '';
  const EURO = ['austria','finland','sweden','netherlands','italy','spain','switzerland','belgium','denmark','norway','poland','ireland','portugal','czechia','czech republic','greece','hungary','romania','france','luxembourg','iceland','estonia','slovenia'];
  if (c && EURO.includes(c.toLowerCase())) return 'Europe';
  if (c) return c;
  const loc = ((j.analysis && j.analysis.location) || '').toLowerCase();
  if (/bangalore|bengaluru|hyderabad|mumbai|delhi|pune|chennai|india|kolkata|noida/.test(loc)) return 'India';
  if (/dubai|abu dhabi|sharjah|uae|emirates/.test(loc)) return 'UAE';
  if (/singapore/.test(loc)) return 'Singapore';
  if (/london|cambridge, uk|oxford|manchester|uk|united kingdom|england|scotland/.test(loc)) return 'UK';
  if (/munich|berlin|germany|heidelberg|frankfurt/.test(loc)) return 'Germany';
  if (/seoul|korea/.test(loc)) return 'South Korea';
  if (/china|shanghai|beijing|suzhou|apac/.test(loc)) return 'China';
  if (/sydney|melbourne|australia|brisbane/.test(loc)) return 'Australia';
  if (/toronto|vancouver|montreal|canada|ottawa|, bc|, on/.test(loc)) return 'Canada';
  if (/boston|san francisco|new york|usa|united states|california|, ma|, ca|, or|, tx|, nj|, ny|, wa|, pa|, md|san diego|seattle|wilsonville|quincy|redwood|cambridge, ma|south san/.test(loc)) return 'USA';
  if (/paris|amsterdam|zurich|geneva|stockholm|copenhagen|madrid|barcelona|milan|italy|france|spain|netherlands|sweden|switzerland|belgium|denmark|austria|dublin|ireland|europe/.test(loc)) return 'Europe';
  if (/remote/.test(loc)) return 'Remote';
  return 'Other';
}
function sectionOf(j){
  return jobCountry(j) === 'India' ? 'india' : 'international';
}
async function load() {
  document.getElementById('view').innerHTML = '<div class="loading"><div class="spin"></div><p>Loading saved jobs…</p></div>';
  try {
    let all = [], cursor = null, guard = 0;
    do {
      const u = '/api/jobs?key=' + encodeURIComponent(KEY) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const res = await fetch(u);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      all = all.concat(data.jobs || []);
      cursor = data.list_complete ? null : data.cursor;
    } while (cursor && ++guard < 50);
    all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    allJobs = all;
    render();
  } catch (e) {
    document.getElementById('view').innerHTML = '<div class="empty"><div class="empty-icon"><i class="ti ti-alert-circle"></i></div><h3>Could not load</h3><p>' + escapeHtml(e.message) + '</p></div>';
  }
}
function goHome(){ route='home'; section=null; activeCountry=null; render(); }
function openSection(s){
  route='section'; section=s; currentFilter='all';
  const countries = s==='india' ? ['India'] : INTL_COUNTRIES;
  const counts = sectionCountsByCountry(s);
  activeCountry = countries.find(c => counts[c] > 0) || countries[0];
  render();
}
function sectionJobs(s){ return allJobs.filter(j => sectionOf(j) === s); }
function sectionCountsByCountry(s){
  const out = {};
  for (const j of sectionJobs(s)){ const c = jobCountry(j); out[c] = (out[c]||0)+1; }
  return out;
}
function render(){
  if (route === 'home') return renderHome();
  return renderSection();
}
function renderHome(){
  const india = sectionJobs('india').length;
  const intl = sectionJobs('international').length;
  const total = allJobs.length;
  const applied = allJobs.filter(j => ['applied','interview','offered'].includes(j.status)).length;
  const apply = allJobs.filter(j => j.analysis?.recommendation === 'Apply').length;
  document.getElementById('view').innerHTML =
    '<div class="landing-hero">' +
      '<h2>Where do you want to look?</h2>' +
      '<p>' + total + ' roles analyzed across India and international markets. Pick a track to explore by country.</p>' +
    '</div>' +
    '<div class="section-cards">' +
      sectionCard('india','ti-map-pin-filled','India','Learning, design & tech roles across Bengaluru and beyond.', india) +
      sectionCard('international','ti-world','International','US, Canada, UK, Germany, Australia, UAE, Singapore & remote.', intl) +
    '</div>' +
    '<div class="stats-bar">' +
      statBlock('Total analyzed', total, 'all jobs scored', '') +
      statBlock('Apply-tier', apply, 'high match (70+)', 'apply') +
      statBlock('Applied', applied, 'tracked in pipeline', '') +
    '</div>';
}
function sectionCard(s, icon, title, sub, count){
  return '<div class="section-card sc-' + (s==='international'?'intl':s) + '" onclick="openSection(\'' + s + '\')">' +
    '<div class="sc-icon"><i class="ti ' + icon + '"></i></div>' +
    '<div class="sc-body"><div class="sc-title">' + title + '</div><div class="sc-sub">' + sub + '</div></div>' +
    '<div class="sc-foot"><div class="sc-count">' + count + ' <span>role' + (count===1?'':'s') + '</span></div><i class="ti ti-arrow-right sc-arrow"></i></div>' +
  '</div>';
}
function renderSection(){
  const titles = {india:'India', international:'International'};
  const countries = section==='india' ? ['India'] : INTL_COUNTRIES;
  const counts = sectionCountsByCountry(section);
  const visible = countries.filter(c => counts[c] > 0);
  const tabsHtml = (visible.length ? visible : countries.slice(0,1)).map(c =>
    '<button class="country-tab' + (c===activeCountry?' active':'') + '" onclick="setCountry(\'' + c.replace(/'/g,"\\'") + '\')">' +
      '<span class="flag">' + (FLAGS[c]||'📍') + '</span>' + c +
      '<span class="count">' + (counts[c]||0) + '</span>' +
    '</button>'
  ).join('');

  const allCats = [...new Set(sectionJobs(section).map(j => j.analysis?.jobCategory).filter(Boolean))].sort();
  const catOptions = allCats.map(cat =>
    '<option value="' + escapeHtml(cat) + '"' + (selectedCategories.has(cat) ? ' selected' : '') + '>' +
      (selectedCategories.has(cat) ? '✓ ' : '') + escapeHtml(cat) +
    '</option>'
  ).join('');

  const hasActiveFilters = selectedRecs.size > 0 || selectedStatuses.size > 0 || selectedCategories.size > 0 || selectedRecency !== 'all';

  document.getElementById('view').innerHTML =
    '<div class="breadcrumb"><a onclick="goHome()">Home</a><i class="ti ti-chevron-right"></i><span>' + titles[section] + '</span></div>' +
    (section!=='india' ? '<div class="country-tabs">' + tabsHtml + '</div>' : '') +
    '<div class="controls-card">' +
      '<div class="controls-row-main">' +
        '<div class="search-wrap"><i class="ti ti-search"></i><input class="search-input" id="search" placeholder="Search role, company, skills, or location…"></div>' +
        '<select class="filter-select-custom" id="recency-select" onchange="setRecency(this.value)" title="Filter by job posting date">' +
          '<option value="all"' + (selectedRecency==='all'?' selected':'') + '>📅 Any posting date</option>' +
          '<option value="1"' + (selectedRecency==='1'?' selected':'') + '>⚡ Posted: Today (24h)</option>' +
          '<option value="3"' + (selectedRecency==='3'?' selected':'') + '>🕒 Posted: Past 3 days</option>' +
          '<option value="7"' + (selectedRecency==='7'?' selected':'') + '>📆 Posted: Past 7 days</option>' +
          '<option value="14"' + (selectedRecency==='14'?' selected':'') + '>🗓️ Posted: Past 14 days</option>' +
          '<option value="30"' + (selectedRecency==='30'?' selected':'') + '>📅 Posted: Past 30 days</option>' +
        '</select>' +
        '<select class="sort-select" id="sort" onchange="renderList()">' +
          '<option value="score-desc">Highest score</option>' +
          '<option value="posted-desc">Newest posting first</option>' +
          '<option value="date-desc">Recently analyzed</option>' +
          '<option value="score-asc">Lowest score</option>' +
        '</select>' +
      '</div>' +
      '<div class="controls-row-filters">' +
        '<div class="filter-group-inline">' +
          '<span class="filter-group-label">Match:</span>' +
          '<button class="filter-pill-check' + (selectedRecs.has('Apply')?' active active-apply':'') + '" onclick="toggleRec(\'Apply\')"><i class="ti ti-circle-check"></i>Apply</button>' +
          '<button class="filter-pill-check' + (selectedRecs.has('Consider')?' active active-consider':'') + '" onclick="toggleRec(\'Consider\')"><i class="ti ti-circle-dashed"></i>Consider</button>' +
          '<button class="filter-pill-check' + (selectedRecs.has('Reject')?' active active-reject':'') + '" onclick="toggleRec(\'Reject\')"><i class="ti ti-circle-x"></i>Reject</button>' +
        '</div>' +
        '<div class="filter-group-inline">' +
          '<span class="filter-group-label">Status:</span>' +
          '<button class="filter-pill-check' + (selectedStatuses.has('new')?' active':'') + '" onclick="toggleStatus(\'new\')">Not Applied</button>' +
          '<button class="filter-pill-check' + (selectedStatuses.has('applied')?' active':'') + '" onclick="toggleStatus(\'applied\')">Applied</button>' +
          '<button class="filter-pill-check' + (selectedStatuses.has('interview')?' active':'') + '" onclick="toggleStatus(\'interview\')">Interview</button>' +
        '</div>' +
        (allCats.length ?
          '<select class="filter-select-custom" id="cat-select" onchange="toggleCategory(this.value)">' +
            '<option value="">' + (selectedCategories.size ? '(' + selectedCategories.size + ' selected) Categories' : '📂 All Categories') + '</option>' +
            catOptions +
          '</select>' : '') +
        (hasActiveFilters ? '<button class="reset-btn" onclick="resetAllFilters()"><i class="ti ti-rotate"></i>Reset filters</button>' : '') +
      '</div>' +
    '</div>' +
    '<div id="jobs" class="jobs"></div>';
  document.getElementById('search').addEventListener('input', renderList);
  renderList();
}
function toggleRec(r){
  if (selectedRecs.has(r)) selectedRecs.delete(r);
  else selectedRecs.add(r);
  renderSection();
}
function toggleStatus(s){
  if (selectedStatuses.has(s)) selectedStatuses.delete(s);
  else selectedStatuses.add(s);
  renderSection();
}
function setRecency(val){
  selectedRecency = val;
  renderSection();
}
function toggleCategory(cat){
  if (!cat) selectedCategories.clear();
  else if (selectedCategories.has(cat)) selectedCategories.delete(cat);
  else selectedCategories.add(cat);
  renderSection();
}
function resetAllFilters(){
  selectedRecs.clear();
  selectedStatuses.clear();
  selectedCategories.clear();
  selectedRecency = 'all';
  renderSection();
}
function setCountry(c){ activeCountry = c; renderSection(); }
function currentList(){
  let list = sectionJobs(section);
  if (section !== 'india') list = list.filter(j => jobCountry(j) === activeCountry);
  if (selectedRecs.size > 0) list = list.filter(j => selectedRecs.has(j.analysis?.recommendation));
  if (selectedStatuses.size > 0) list = list.filter(j => selectedStatuses.has(j.status || 'new'));
  if (selectedCategories.size > 0) list = list.filter(j => selectedCategories.has(j.analysis?.jobCategory));
  if (selectedRecency !== 'all') {
    const maxDays = parseInt(selectedRecency, 10);
    const now = Date.now();
    list = list.filter(j => {
      const pts = getJobPostedTimestamp(j);
      if (!pts) return false;
      return ((now - pts) / 86400000) <= maxDays;
    });
  }
  const searchEl = document.getElementById('search');
  const search = searchEl ? searchEl.value.toLowerCase().trim() : '';
  if (search) list = list.filter(j => {
    const a = j.analysis || {};
    return ((a.actualRole||'')+' '+(a.company||'')+' '+(a.location||'')+' '+(a.jobCategory||'')+' '+(j.pageTitle||'')+' '+(a.strengths||[]).join(' ')).toLowerCase().includes(search);
  });
  const sortEl = document.getElementById('sort');
  const sort = sortEl ? sortEl.value : 'score-desc';
  list.sort((a,b)=>{
    if (sort==='posted-desc') return (getJobPostedTimestamp(b)||0) - (getJobPostedTimestamp(a)||0);
    if (sort==='date-desc') return (b.timestamp||0)-(a.timestamp||0);
    if (sort==='date-asc') return (a.timestamp||0)-(b.timestamp||0);
    if (sort==='score-desc') return (b.analysis?.matchScore||0)-(a.analysis?.matchScore||0);
    if (sort==='score-asc') return (a.analysis?.matchScore||0)-(b.analysis?.matchScore||0);
    return 0;
  });
  return list;
}
function renderList(){
  const jobs = currentList();
  const host = document.getElementById('jobs');
  if (!host) return;
  if (jobs.length === 0){
    host.innerHTML = '<div class="empty"><div class="empty-icon"><i class="ti ti-inbox"></i></div><h3>Nothing here yet</h3><p>No roles in this view matching the active filters. Try resetting filters or choosing another country tab.</p></div>';
    return;
  }
  host.innerHTML = jobs.map(j => {
    const a = j.analysis || {};
    const score = a.matchScore || 0;
    const scoreClass = score >= 70 ? 'apply' : score >= 45 ? 'consider' : 'reject';
    const status = j.status || 'new';
    const company = a.company || '';
    const location = a.location || '';
    const exp = a.experienceRequired || '';
    const visa = a.visaSponsorship || '';
    const visaClass = visa.replace(/\s/g,'');
    const topStrength = (a.strengths || [])[0];
    const topGap = (a.gaps || [])[0];
    const postedBadge = postedDayBadge(j);
    return '<div class="job" onclick="openDetail(\'' + j.id + '\')">' +
      '<div class="score-badge score-' + scoreClass + '">' + score + '<span class="score-pct">MATCH</span></div>' +
      '<div class="job-main">' +
        '<div class="job-title">' + escapeHtml(a.actualRole || 'Unknown role') + '</div>' +
        '<div class="job-meta">' +
          (company ? '<span class="job-company"><i class="ti ti-building"></i>' + escapeHtml(company) + '</span>' : '') +
          (location ? '<span class="job-meta-item"><i class="ti ti-map-pin"></i>' + escapeHtml(location) + '</span>' : '') +
          (exp ? '<span class="job-meta-item"><i class="ti ti-briefcase"></i>' + escapeHtml(exp) + '</span>' : '') +
          (postedBadge ? postedBadge : '') +
          (visa ? '<span class="visa-chip visa-' + visaClass + '"><i class="ti ti-plane"></i>' + escapeHtml(visa) + '</span>' : '') +
        '</div>' +
        ((topStrength||topGap) ? '<div class="job-tags">' +
          (topStrength ? '<span class="mini-tag mini-tag-s">✓ ' + escapeHtml(topStrength) + '</span>' : '') +
          (topGap ? '<span class="mini-tag mini-tag-g">! ' + escapeHtml(topGap) + '</span>' : '') +
        '</div>' : '') +
      '</div>' +
      '<div class="job-side" onclick="event.stopPropagation()">' +
        '<select class="status-select status-' + status + '" onchange="updateStatus(\'' + j.id + '\', this.value)" title="Update status">' +
          '<option value="new"' + (status==='new'?' selected':'') + '>Not Applied</option>' +
          '<option value="applied"' + (status==='applied'?' selected':'') + '>Applied</option>' +
          '<option value="interview"' + (status==='interview'?' selected':'') + '>Interview</option>' +
          '<option value="offered"' + (status==='offered'?' selected':'') + '>Offered</option>' +
          '<option value="rejected"' + (status==='rejected'?' selected':'') + '>Rejected</option>' +
        '</select>' +
        (j.url ? '<button class="icon-btn" title="' + applyTooltip(j) + '" onclick="window.open(\'' + escapeHtml(applyUrl(j)) + '\', \'_blank\')"><i class="ti ti-external-link"></i></button>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}
function statBlock(label, value, sub, variant) {
  return '<div class="stat stat-' + variant + '"><div class="stat-label">' + label + '</div><div class="stat-value">' + value + '</div><div class="stat-change">' + sub + '</div></div>';
}
function openDetail(id) {
  const job = allJobs.find(j => j.id === id);
  if (!job) return;
  currentDetailId = id;
  const a = job.analysis || {};
  const score = a.matchScore || 0;
  const rec = a.recommendation || 'Unknown';
  const checkState = job.checklistState || {};
  const ringColor = score >= 70 ? '#16a34a' : score >= 45 ? '#f59e0b' : '#ef4444';
  const circumference = 2 * Math.PI * 50;
  const dashOffset = circumference - (score / 100) * circumference;
  document.getElementById('drawer').innerHTML =
    '<div class="drawer-header">' +
      '<button class="drawer-close" onclick="closeDrawer()"><i class="ti ti-x"></i></button>' +
      '<div class="score-ring-wrap"><svg width="128" height="128" viewBox="0 0 128 128">' +
        '<circle class="score-ring-bg" cx="64" cy="64" r="50"></circle>' +
        '<circle class="score-ring-fg" cx="64" cy="64" r="50" stroke="' + ringColor + '" stroke-dasharray="' + circumference + '" stroke-dashoffset="' + dashOffset + '"></circle>' +
      '</svg><div class="score-ring-num"><div class="score-ring-val">' + score + '</div><div class="score-ring-lbl">match</div></div></div>' +
      '<div class="drawer-rec-row"><div class="rec-pill rec-' + rec + '"><i class="ti ' + (rec==='Apply'?'ti-circle-check':rec==='Consider'?'ti-circle-dashed':'ti-circle-x') + '"></i>' + rec + '</div></div>' +
      '<div class="drawer-title">' + escapeHtml(a.actualRole || 'Unknown role') + '</div>' +
      '<div class="drawer-subtitle">' + escapeHtml(a.jobCategory || '') + ' · ' + (FLAGS[jobCountry(job)]||'') + ' ' + escapeHtml(jobCountry(job)) + ' · Analyzed ' + formatDate(job.timestamp) + '</div>' +
    '</div>' +
    '<div class="drawer-body">' +
      '<div class="facts-grid">' +
        factCell('Company', a.company, 'ti-building') +
        factCell('Location', a.location, 'ti-map-pin') +
        factCell('Experience', a.experienceRequired, 'ti-briefcase') +
        factCell('Posted', postedLabel(job.postedDate, job).replace(/^Posted /,''), 'ti-calendar') +
        factCell('Visa / sponsorship', a.visaSponsorship, 'ti-plane') +
      '</div>' +
      (a.companySignal ? '<div class="signal-row"><div class="signal-row-icon"><i class="ti ti-shield-check"></i></div><div class="signal-row-body">' +
        '<div class="signal-row-label">Company signal</div>' +
        '<div class="signal-row-value"><span class="signal-badge signal-' + (a.companySignal.includes('Top')?'Top':a.companySignal.includes('Good')?'Good':a.companySignal.includes('Caution')?'Caution':'Unknown') + '">' + escapeHtml(a.companySignal) + '</span></div>' +
        (a.companyNote ? '<div class="signal-row-note">' + escapeHtml(a.companyNote) + '</div>' : '') +
      '</div></div>' : '') +
      (a.reasoning ? sec('Why this score','ti-message-circle-2','<div class="section-body">' + escapeHtml(a.reasoning) + '</div>') : '') +
      ((a.strengths||[]).length ? sec('Strengths matched','ti-circle-check','<div class="tag-list">' + a.strengths.map(s=>'<span class="tag tag-s"><i class="ti ti-check"></i>' + escapeHtml(s) + '</span>').join('') + '</div>') : '') +
      ((a.gaps||[]).length ? sec('Gaps to address','ti-alert-triangle','<div class="tag-list">' + a.gaps.map(g=>'<span class="tag tag-g"><i class="ti ti-alert-circle"></i>' + escapeHtml(g) + '</span>').join('') + '</div>') : '') +
      (a.careerGrowth ? sec('Career growth','ti-trending-up','<div class="section-body">' + escapeHtml(a.careerGrowth) + '</div>') : '') +
      ((a.applicationTips||[]).length ? sec('Application tips','ti-bulb','<div class="tip-list">' + a.applicationTips.map((t,i)=>'<div class="tip"><div class="tip-num">' + (i+1) + '</div><div class="tip-text">' + escapeHtml(t) + '</div></div>').join('') + '</div>') : '') +
      ((a.actionChecklist||[]).length ? sec('Action checklist','ti-list-check','<div class="checklist">' + a.actionChecklist.map((item,i)=>{const done=!!checkState[i];return '<div class="check-item' + (done?' done':'') + '" onclick="toggleCheck(\'' + job.id + '\', ' + i + ')"><div class="check-box"><i class="ti ti-check"></i></div><div class="check-text">' + escapeHtml(item) + '</div></div>';}).join('') + '</div>') : '') +
      sec('Personal notes','ti-notes','<textarea class="notes-textarea" id="notes-area" placeholder="Add your thoughts, contacts, or next steps…" oninput="saveNotes(\'' + job.id + '\', this.value)">' + escapeHtml(job.notes || '') + '</textarea><div class="notes-status" id="notes-status"></div>') +
    '</div>' +
    '<div class="drawer-footer">' +
      applyButtons(job) +
      '<button class="btn-danger" onclick="deleteJob(\'' + job.id + '\')"><i class="ti ti-trash"></i></button>' +
    '</div>';
  document.getElementById('drawer-bg').classList.add('open');
  maybeResolveApply(job);
}
function factCell(label, value, icon) {
  const empty = !value || value === '';
  return '<div class="fact"><div class="fact-label"><i class="ti ' + icon + '"></i>' + label + '</div><div class="fact-value' + (empty?' empty':'') + '">' + (empty ? 'Not specified' : escapeHtml(value)) + '</div></div>';
}
function sec(title, icon, body) {
  return '<div class="section-d"><div class="section-d-title"><i class="ti ' + icon + '"></i>' + title + '</div>' + body + '</div>';
}
function closeDrawer(){ document.getElementById('drawer-bg').classList.remove('open'); currentDetailId = null; }
let notesTimer;
function saveNotes(id, value) {
  document.getElementById('notes-status').textContent = 'Saving…';
  clearTimeout(notesTimer);
  notesTimer = setTimeout(async () => {
    await updateJob(id, { notes: value });
    document.getElementById('notes-status').textContent = 'Saved';
    setTimeout(() => { const el = document.getElementById('notes-status'); if (el) el.textContent = ''; }, 1500);
  }, 600);
}
async function updateStatus(id, status) {
  await updateJob(id, { status });
  const j = allJobs.find(j => j.id === id);
  if (j) j.status = status;
  if (route==='home') renderHome();
}
async function toggleCheck(jobId, idx) {
  const j = allJobs.find(j => j.id === jobId);
  if (!j) return;
  const state = j.checklistState || {};
  state[idx] = !state[idx];
  j.checklistState = state;
  await updateJob(jobId, { checklistState: state });
  if (currentDetailId === jobId) openDetail(jobId);
}
async function updateJob(id, updates) {
  try {
    await fetch('/api/jobs/' + id + '?key=' + encodeURIComponent(KEY), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
    const j = allJobs.find(j => j.id === id);
    if (j) Object.assign(j, updates);
  } catch (e) { console.error('Update failed:', e); }
}
async function deleteJob(id) {
  if (!confirm('Delete this job entry permanently?')) return;
  try {
    await fetch('/api/jobs/' + id + '?key=' + encodeURIComponent(KEY), { method: 'DELETE' });
    allJobs = allJobs.filter(j => j.id !== id);
    closeDrawer();
    render();
  } catch (e) { alert('Failed to delete: ' + e.message); }
}
async function dedupJobs() {
  if (!confirm('Remove duplicate job entries? Keeps the newest copy of each posting and deletes the rest. This cannot be undone.')) return;
  const groups = {};
  for (const j of allJobs) {
    const u = (j.url || '').split('?')[0];
    if (!u) continue;
    (groups[u] = groups[u] || []).push(j);
  }
  const toDelete = [];
  for (const u in groups) {
    const g = groups[u];
    if (g.length <= 1) continue;
    g.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    for (let i = 1; i < g.length; i++) toDelete.push(g[i].id);
  }
  if (!toDelete.length) { alert('No duplicates found.'); return; }
  if (!confirm('Found ' + toDelete.length + ' duplicate' + (toDelete.length === 1 ? '' : 's') + '. Delete them now?')) return;
  try {
    let done = 0;
    for (let i = 0; i < toDelete.length; i += 10) {
      await Promise.all(toDelete.slice(i, i + 10).map(id =>
        fetch('/api/jobs/' + id + '?key=' + encodeURIComponent(KEY), { method: 'DELETE' })
      ));
      done += Math.min(10, toDelete.length - i);
    }
    const del = new Set(toDelete);
    allJobs = allJobs.filter(j => !del.has(j.id));
    alert('Removed ' + toDelete.length + ' duplicate' + (toDelete.length === 1 ? '' : 's') + '.');
    render();
  } catch (e) { alert('Dedup failed partway: ' + e.message + '. Reload and try again.'); }
}
function exportCSV() {
  if (allJobs.length === 0) { alert('No jobs to export'); return; }
  const rows = [['Date Analyzed','Posted','Section','Country','Role','Company','Location','Experience','Type','Visa','Score','Recommendation','Status','Company Signal','URL']];
  allJobs.forEach(j => {
    const a = j.analysis || {};
    rows.push([formatDate(j.timestamp), (postedLabel(j.postedDate, j)||'').replace(/^Posted /,''), sectionOf(j), jobCountry(j), a.actualRole||'', a.company||'', a.location||'', a.experienceRequired||'', a.employmentType||'', a.visaSponsorship||'', a.matchScore||'', a.recommendation||'', j.status||'new', a.companySignal||'', j.url||'']);
  });
  const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'jobs-' + new Date().toISOString().slice(0,10) + '.csv';
  link.click();
}
function getJobPostedTimestamp(job) {
  if (!job) return null;
  const a = job.analysis || {};
  const raw = String(job.postedDate || a.postedDate || '').trim();
  if (raw) {
    const t = Date.parse(raw);
    if (!isNaN(t)) return t;
    const lower = raw.toLowerCase();
    const ref = job.timestamp || Date.now();
    const hr = lower.match(/(\d+)\s*(?:hour|hr)/);
    if (hr) return ref - parseInt(hr[1], 10) * 3600000;
    const d = lower.match(/(\d+)\s*(?:day|d)/);
    if (d) return ref - parseInt(d[1], 10) * 86400000;
    const w = lower.match(/(\d+)\s*(?:week|wk)/);
    if (w) return ref - parseInt(w[1], 10) * 7 * 86400000;
    const m = lower.match(/(\d+)\s*(?:month|mo)/);
    if (m) return ref - parseInt(m[1], 10) * 30 * 86400000;
    if (lower.includes('yesterday')) return ref - 86400000;
    if (lower.includes('today') || lower.includes('just now')) return ref;
  }
  return job.timestamp || null;
}
function postedLabel(iso, job) {
  const pts = job ? getJobPostedTimestamp(job) : (Date.parse(iso) || null);
  if (!pts) return '';
  const now = Date.now();
  const diff = now - pts;
  if (diff < 0) return 'Posted recently';
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Posted today';
  if (days === 1) return 'Posted 1d ago';
  if (days < 14) return 'Posted ' + days + 'd ago';
  if (days < 30) return 'Posted ' + Math.floor(days / 7) + 'w ago';
  const d = new Date(pts);
  return 'Posted ' + d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function postedDayBadge(job) {
  const pts = getJobPostedTimestamp(job);
  if (!pts) return '';
  const now = Date.now();
  const diff = now - pts;
  const days = Math.floor(diff / 86400000);
  if (days <= 0) return '<span class="day-chip day-today"><i class="ti ti-bolt"></i>Posted today</span>';
  if (days === 1) return '<span class="day-chip day-recent"><i class="ti ti-calendar"></i>Posted 1d ago</span>';
  if (days < 7) return '<span class="day-chip day-recent"><i class="ti ti-calendar"></i>Posted ' + days + 'd ago</span>';
  if (days < 30) return '<span class="day-chip day-older"><i class="ti ti-calendar"></i>Posted ' + Math.floor(days / 7) + 'w ago</span>';
  const d = new Date(pts);
  return '<span class="day-chip day-older"><i class="ti ti-calendar"></i>' + d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + '</span>';
}
async function cleanStaleJobs() {
  if (!confirm('Scan and delete jobs that have remained unattended (status is still "Not Applied", no notes) for more than 15 days?')) return;
  try {
    let totalDeleted = 0;
    let cursor = null;
    do {
      const u = '/api/cleanup-stale?key=' + encodeURIComponent(KEY) + '&days=15' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const res = await fetch(u, { method: 'POST' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      totalDeleted += (data.deleted || 0);
      cursor = data.list_complete ? null : data.cursor;
    } while (cursor);

    if (totalDeleted > 0) {
      alert('Cleaned up ' + totalDeleted + ' unattended job' + (totalDeleted === 1 ? '' : 's') + ' older than 15 days.');
      load();
    } else {
      alert('All clean! No unattended jobs older than 15 days found.');
    }
  } catch (e) {
    alert('Cleanup failed: ' + e.message);
  }
}
function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts); const now = Date.now(); const diff = now - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}
function isAdzunaUrl(url) {
  return !!url && /adzuna\./i.test(url);
}
function isJoobleUrl(url) {
  return !!url && /jooble\.org/i.test(url);
}
function applyUrl(job) {
  return (job && job.url) ? job.url : '';
}
function viewUrl(job) {
  const u = (job && job.url) || '';
  if (isJoobleUrl(u)) return u;
  if (isAdzunaUrl(u)) {
    if (/\/details\//i.test(u)) return u;
    const m = u.match(/^(https?:\/\/[^/]+adzuna\.[^/]+)\/(?:[^?]*\/)?(?:land\/ad|details)\/(\d+)/i);
    if (m) return m[1] + '/details/' + m[2];
    return u;
  }
  return '';
}
function aggregatorName(job) {
  const u = (job && job.url) || '';
  if (isJoobleUrl(u)) return 'Jooble';
  if (isAdzunaUrl(u)) return 'Adzuna';
  return '';
}
function applyLabel(job) {
  return isJoobleUrl(job && job.url) ? 'Open on Jooble' : 'Open & apply on original page';
}
function applyTooltip(job) {
  return 'Open the job posting to apply';
}
function applyButtons(job) {
  if (!job || !job.url) return '<div class="btn-primary" style="opacity:0.5;cursor:default">No URL saved</div>';
  const apply = applyUrl(job);
  let html = '<button class="btn-primary" onclick="window.open(\'' + escapeHtml(apply) + '\', \'_blank\')"><i class="ti ti-external-link"></i>' + applyLabel(job) + '</button>';
  if (sectionOf(job) === 'international' && job.directApplyUrl && job.directApplyUrl !== apply) {
    html += '<button class="btn-apply-direct" title="Direct application link taken from the posting\'s Apply button" onclick="window.open(\'' + escapeHtml(job.directApplyUrl) + '\', \'_blank\')"><i class="ti ti-external-link"></i>Direct apply link</button>';
  }
  const v = viewUrl(job);
  if (v && v !== apply) {
    const name = aggregatorName(job) || 'source';
    html += '<button class="btn-view" title="Read the job description on ' + name + ' — viewable even when the source is country-locked" onclick="window.open(\'' + escapeHtml(v) + '\', \'_blank\')"><i class="ti ti-file-text"></i>View JD on ' + name + '</button>';
  }
  const comp = (job.analysis && job.analysis.company) || '';
  const role = (job.analysis && job.analysis.role) || job.pageTitle || '';
  if (comp || role) {
    const q = encodeURIComponent((comp + ' ' + role + ' careers apply').trim());
    html += '<button class="btn-view" title="Search directly on Google for the employer\'s official career portal (bypasses aggregator expiration/location restrictions)" onclick="window.open(\'https://www.google.com/search?q=' + q + '\', \'_blank\')"><i class="ti ti-search"></i>Direct Employer Search</button>';
  }
  return html;
}
async function maybeResolveApply(job) {
  if (!job || sectionOf(job) !== 'international') return;
  if (job.directApplyUrl) return;
  if (!/adzuna\.|jooble\.org/i.test(job.url || '')) return;
  try {
    const res = await fetch('/api/resolve?key=' + encodeURIComponent(KEY) + '&id=' + encodeURIComponent(job.id));
    const data = await res.json();
    if (data && data.directApplyUrl) {
      job.directApplyUrl = data.directApplyUrl;
      if (currentDetailId === job.id) {
        const footer = document.querySelector('#drawer .drawer-footer');
        if (footer) footer.innerHTML = applyButtons(job) + '<button class="btn-danger" onclick="deleteJob(\'' + job.id + '\')"><i class="ti ti-trash"></i></button>';
      }
    }
  } catch {}
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
load();
</script>
</body>
</html>`;
