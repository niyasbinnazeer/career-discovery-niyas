// discovery_niyas.mjs — Node.js discovery job for Niyas's L&D / eLearning search.
// Mirrors Sudakshina's discovery script structure; profile, queries, sources, and
// keyword filters are Niyas's. Runs as a GitHub Actions scheduled job (no Cloudflare
// Workers subrequest cap).
//
// SECRETS REQUIRED (GitHub repo → Settings → Secrets and variables → Actions):
//   CF_ACCOUNT_ID        — your Cloudflare account ID (SAME as Sudakshina's — same account)
//   CF_API_TOKEN         — Cloudflare API token with KV read+write (SAME token works)
//   CF_KV_NAMESPACE_ID   — KV namespace ID of `career_jobs_niyas` (NEW — yours)
//   CAREER_ANALYZER_URL  — https://career-intelligence-api-niyas.<sub>.workers.dev
//   ADZUNA_APP_ID        — your NEW Adzuna app id
//   ADZUNA_APP_KEY       — your NEW Adzuna app key
//
// NOTE ON GEMINI: your career-intelligence-api-niyas worker should use its OWN
// Gemini API key (separate Google AI Studio project) so it has an independent
// 500/day free pool. Sharing Sudakshina's key would push most of your analyses to
// the paid Haiku fallback, because her discovery already consumes ~480/day.
//
// Run locally for testing:  node discovery_niyas.mjs

// =============================================================================
// CONFIG
// =============================================================================
const CONFIG = {
  // No subrequest cap on GitHub Actions. 40/run × 12 runs/day = 480/day max —
  // within your analyzer's OWN Gemini Flash-Lite free tier (500/day); Haiku
  // absorbs any overflow.
  MAX_ANALYZE_PER_RUN: 40,

  // Dedup keys persist 120 days, then expire — re-postings don't re-analyze.
  SEEN_TTL_SECONDS: 60 * 60 * 24 * 120,

  // Company ATS boards. Seeded broad (EdTech + tech with real L&D orgs). The
  // fetchGreenhouse adapter handles 404s gracefully — wrong tokens are silently
  // skipped, so adding probable tokens is safe (working ones add jobs).
  ATS: {
    greenhouse: [
      // EdTech / learning companies (highest yield for L&D roles)
      "coursera", "udacity", "duolingo", "khanacademy", "codecademy",
      "outschool", "multiverse", "guildeducation", "degreed", "pluralsight",
      "docebo", "go1", "360learning", "instructure", "udemy", "skillsoft",
      "chegg", "quizlet", "brilliant", "masterclass", "newsela", "edmentum",
      "labster", "paper", "panorama", "nerdy", "learnupon", "cornerstone",
      // Large tech / scale-ups with mature learning & enablement functions
      "stripe", "databricks", "figma", "notion", "gitlab", "asana",
      "dropbox", "twilio", "airbnb", "pinterest", "reddit", "doordash",
      "instacart", "robinhood", "brex", "ramp", "gusto", "samsara",
      "hashicorp", "confluent", "mongodb", "elastic", "datadog", "plaid",
      "affirm", "coinbase", "discord", "canva", "atlassian", "shopify",
      "wise", "revolut", "deliveroo", "snowflake",
    ],
    lever: [],
    ashby: [],
  },

  ADZUNA_ENABLED: true,
  // ALL 19 Adzuna-supported countries — maximum coverage, no restriction.
  ADZUNA_COUNTRIES: [
    "gb","us","ca","au","in","sg","nz","de","fr","nl",
    "it","es","at","be","ch","pl","br","mx","za",
  ],
  // L&D / eLearning / instructional-design query set.
  ADZUNA_QUERIES: [
    "instructional designer",
    "elearning developer",
    "e-learning developer",
    "learning experience designer",
    "learning designer",
    "learning experience developer",
    "learning technologist",
    "learning and development specialist",
    "instructional design",
    "articulate storyline",
    "learning engineer",
    "curriculum developer",
    "digital learning designer",
    "learning content developer",
    "training content developer",
  ],
  // Per-run cap on Adzuna rotation calls (cursor cycles the full country×query
  // matrix over successive runs). 10/run × 12 runs/day = 120 Adzuna calls/day —
  // conservative against the free tier. Raise for faster matrix coverage.
  ADZUNA_CALLS_PER_RUN: 10,
  ADZUNA_RESULTS_PER_CALL: 25,
  ADZUNA_MAX_DAYS_OLD: 14,

  // ---- JOOBLE (free key, ~500 req/day) — direct source links + UAE coverage ----
  // Budgeted like Adzuna: a rotating slice each run keeps daily usage well under
  // the 500/day cap. 12 calls/run × 12 runs/day = 144/day. Locations are passed as
  // strings (Jooble has no country codes). Reuses the same L&D query set.
  JOOBLE_ENABLED: true,
  JOOBLE_LOCATIONS: [
    "United Kingdom","United States","Canada","Australia","India","Singapore",
    "United Arab Emirates","Dubai","Germany","Netherlands","Ireland","Remote",
  ],
  JOOBLE_CALLS_PER_RUN: 12,
  JOOBLE_RESULTS_PER_CALL: 20,
};

// =============================================================================
// SECRETS — from process.env (GitHub Actions repo secrets)
// =============================================================================
const ENV = {
  CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
  CF_API_TOKEN: process.env.CF_API_TOKEN,
  CF_KV_NAMESPACE_ID: process.env.CF_KV_NAMESPACE_ID,
  CAREER_ANALYZER_URL: process.env.CAREER_ANALYZER_URL,
  ADZUNA_APP_ID: process.env.ADZUNA_APP_ID,
  ADZUNA_APP_KEY: process.env.ADZUNA_APP_KEY,
  JOOBLE_API_KEY: process.env.JOOBLE_API_KEY,
};

function requireEnv(keys) {
  const missing = keys.filter(k => !ENV[k]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    console.error(`Set them as repo secrets in GitHub: Settings → Secrets and variables → Actions.`);
    process.exit(1);
  }
}

// =============================================================================
// KEYWORD FILTERS — tuned for L&D / eLearning / instructional design
// =============================================================================
const STRONG_POSITIVE = [
  "instructional design","instructional designer","elearning","e-learning",
  "learning experience","learning designer","learning design","lxd",
  "articulate storyline","storyline 360","storyline","rise 360","captivate",
  "scorm","xapi","cmi5","lms","learning management","authoring tool",
  "curriculum","course development","course design","learning and development",
  "l&d","learning technologist","learning engineer","learning technology",
  "training content","learning content","edtech","educational technology",
  "wcag","accessible elearning","learning analytics","microlearning",
  "blended learning","digital learning","instructional",
];
const HARD_NEGATIVE = [
  "sales","business development","account manager","account executive",
  "medical coding","billing","call center","call centre","customer support",
  "customer success","recruiter","recruitment","talent acquisition","data entry",
  "telecaller","bpo","insurance","real estate","warehouse","logistics",
  "procurement","supply chain","accountant","bookkeeper","tax associate","audit",
  "nurse","nursing","physician","pharmacist","clinical research","lab technician",
  "machine learning","deep learning","data scientist","data engineer",
  "software engineer","backend developer","back-end developer","devops",
  "full stack developer","full-stack developer","security engineer",
  "electrician","plumber","driver","security guard","machine operator",
];

function prefilterPass(text, minScore = 2) {
  const t = (text || "").toLowerCase();
  if (t.length < 40) return false;
  let score = 0;
  for (const kw of STRONG_POSITIVE) if (t.includes(kw)) score += 2;
  for (const kw of HARD_NEGATIVE) if (t.includes(kw)) score -= 3;
  return score >= minScore;
}

function thinTextWorthAnalyzing(title) {
  const t = (title || "").toLowerCase().trim();
  if (t.length < 8) return false;
  const JUNK = ["read more","apply now","apply here","view all","see all","login",
    "sign in","register","subscribe","newsletter","cookie","privacy","terms",
    "contact us","about us","home","next","previous","load more","search jobs",
    "search for jobs","saved jobs","jobs expiring","expiring soon","browse",
    "filter","sort by","all jobs","my account","create account","post a job",
    "advertise","help","faq","sitemap","back to"];
  for (const j of JUNK) if (t === j || t.startsWith(j) || t.includes(j)) return false;
  for (const kw of HARD_NEGATIVE) if (t.includes(kw)) return false;
  const TOO_SENIOR = ["chief learning officer","vice president"," vp ","svp ",
    "executive director","head of department"];
  for (const s of TOO_SENIOR) if (t.includes(s)) return false;
  const DOMAIN = ["learning","training","instructional","elearning","e-learning",
    "curriculum","course","education","lms","edtech","scorm","xapi","storyline",
    "captivate","articulate","design"];
  if (!DOMAIN.some(d => t.includes(d))) return false;
  return true;
}

function stripHtml(s) {
  return (s || "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// =============================================================================
// CLOUDFLARE KV via REST API
// =============================================================================
const KV_BASE = () => `https://api.cloudflare.com/client/v4/accounts/${ENV.CF_ACCOUNT_ID}/storage/kv/namespaces/${ENV.CF_KV_NAMESPACE_ID}`;
const KV_HEADERS = () => ({ "Authorization": `Bearer ${ENV.CF_API_TOKEN}` });

async function kvGet(key) {
  const res = await fetch(`${KV_BASE()}/values/${encodeURIComponent(key)}`, { headers: KV_HEADERS() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV get ${key} -> ${res.status}`);
  return await res.text();
}

async function kvPut(key, value, ttlSeconds) {
  const url = `${KV_BASE()}/values/${encodeURIComponent(key)}` + (ttlSeconds ? `?expiration_ttl=${ttlSeconds}` : "");
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...KV_HEADERS(), "Content-Type": "text/plain" },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`KV put ${key} -> ${res.status}`);
}

// =============================================================================
// DEDUP KEYS
// =============================================================================
import { createHash } from "node:crypto";
function sha1Hex(s) { return createHash("sha1").update(s).digest("hex"); }

function seenKey(url) {
  const base = (url || "").split("?")[0];
  return "seen:" + sha1Hex(base).slice(0, 24);
}

function normalizeForFingerprint(s) {
  return (s || "").toLowerCase()
    .replace(/\bsr\.?\b/g, "senior").replace(/\bjr\.?\b/g, "junior")
    .replace(/\bassoc\.?\b/g, "associate").replace(/\bmgr\.?\b/g, "manager")
    .replace(/\bengg?\.?\b/g, "engineer")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function fingerprintKey(job) {
  const company = normalizeForFingerprint(job.company).split(" ").slice(0, 2).join(" ");
  const title = normalizeForFingerprint(job.title);
  return "fp:" + sha1Hex(`${company}|${title}`).slice(0, 24);
}

// =============================================================================
// SOURCE ADAPTERS — Greenhouse, Lever, Ashby, Adzuna
// =============================================================================
async function fetchGreenhouse(token, report) {
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`);
    if (!res.ok) { report.push(`greenhouse:${token} -> HTTP ${res.status}`); return []; }
    const data = await res.json();
    const jobs = (data.jobs || []).map(j => ({
      title: j.title || "",
      company: token,
      location: j.location?.name || "",
      url: j.absolute_url || "",
      description: stripHtml(j.content || ""),
      postedDate: j.first_published || j.updated_at || "",
    }));
    report.push(`greenhouse:${token} -> ${jobs.length}`);
    return jobs;
  } catch (e) { report.push(`greenhouse:${token} -> ERR ${e.message}`); return []; }
}

async function fetchLever(token, report) {
  try {
    const res = await fetch(`https://api.lever.co/v0/postings/${token}?mode=json`);
    if (!res.ok) { report.push(`lever:${token} -> HTTP ${res.status}`); return []; }
    const data = await res.json();
    const jobs = (data || []).map(j => ({
      title: j.text || "",
      company: token,
      location: j.categories?.location || "",
      url: j.hostedUrl || "",
      description: stripHtml(j.descriptionPlain || j.description || ""),
      postedDate: j.createdAt ? new Date(j.createdAt).toISOString() : "",
    }));
    report.push(`lever:${token} -> ${jobs.length}`);
    return jobs;
  } catch (e) { report.push(`lever:${token} -> ERR ${e.message}`); return []; }
}

async function fetchAshby(token, report) {
  try {
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`);
    if (!res.ok) { report.push(`ashby:${token} -> HTTP ${res.status}`); return []; }
    const data = await res.json();
    const jobs = (data.jobs || []).map(j => ({
      title: j.title || "",
      company: token,
      location: j.location || (j.address?.postalAddress?.addressLocality) || "",
      url: j.jobUrl || j.applyUrl || "",
      description: stripHtml(j.descriptionPlain || j.descriptionHtml || ""),
      postedDate: j.publishedAt || j.updatedAt || "",
    }));
    report.push(`ashby:${token} -> ${jobs.length}`);
    return jobs;
  } catch (e) { report.push(`ashby:${token} -> ERR ${e.message}`); return []; }
}

async function fetchAdzuna(country, query, report) {
  if (!ENV.ADZUNA_APP_ID || !ENV.ADZUNA_APP_KEY) return [];
  const params = new URLSearchParams({
    app_id: ENV.ADZUNA_APP_ID, app_key: ENV.ADZUNA_APP_KEY,
    what: query, results_per_page: String(CONFIG.ADZUNA_RESULTS_PER_CALL),
    max_days_old: String(CONFIG.ADZUNA_MAX_DAYS_OLD),
    "content-type": "application/json",
  });
  const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params}`;
  try {
    const res = await fetch(url);
    if (!res.ok) { report.push(`adzuna:${country}:"${query}" -> HTTP ${res.status}`); return []; }
    const data = await res.json();
    const jobs = (data.results || []).map(j => ({
      title: j.title || "",
      company: `adzuna:${country}`,
      location: j.location?.display_name || (j.location?.area || []).slice(-2).join(", ") || "",
      url: j.redirect_url || "",
      description: (j.company?.display_name ? `Company: ${j.company.display_name}\n\n` : "") + stripHtml(j.description || ""),
      postedDate: j.created || "",
    }));
    report.push(`adzuna:${country}:"${query}" -> ${jobs.length}`);
    return jobs;
  } catch (e) { report.push(`adzuna:${country}:"${query}" -> ERR ${e.message}`); return []; }
}

async function pickAdzunaSlice() {
  const countries = CONFIG.ADZUNA_COUNTRIES;
  const queries = CONFIG.ADZUNA_QUERIES;
  const total = countries.length * queries.length;
  let cursor = 0;
  try {
    const stored = await kvGet("discovery:adzuna_cursor");
    if (stored) cursor = parseInt(stored, 10) || 0;
  } catch {}
  const slice = [];
  for (let i = 0; i < CONFIG.ADZUNA_CALLS_PER_RUN; i++) {
    const idx = (cursor + i) % total;
    const c = countries[idx % countries.length];
    const q = queries[Math.floor(idx / countries.length) % queries.length];
    slice.push({ country: c, query: q });
  }
  const newCursor = (cursor + CONFIG.ADZUNA_CALLS_PER_RUN) % total;
  try { await kvPut("discovery:adzuna_cursor", String(newCursor)); } catch {}
  return slice;
}

async function fetchJooble(location, query, report) {
  if (!ENV.JOOBLE_API_KEY) return [];
  try {
    const res = await fetch(`https://jooble.org/api/${ENV.JOOBLE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keywords: query,
        location,
        page: "1",
        ResultOnPage: CONFIG.JOOBLE_RESULTS_PER_CALL,
      }),
    });
    if (!res.ok) { report.push(`jooble:${location}:"${query}" -> HTTP ${res.status}`); return []; }
    const data = await res.json();
    const jobs = (data.jobs || []).map(j => ({
      title: j.title || "",
      company: j.company || "",
      location: j.location || location,
      url: j.link || "",
      description: stripHtml(j.snippet || ""),
      postedDate: j.updated || "",
      thinText: true, // Jooble returns short snippets — filter by title, not body.
    }));
    report.push(`jooble:${location}:"${query}" -> ${jobs.length}`);
    return jobs;
  } catch (e) { report.push(`jooble:${location}:"${query}" -> ERR ${e.message}`); return []; }
}

async function pickJoobleSlice() {
  const locations = CONFIG.JOOBLE_LOCATIONS;
  const queries = CONFIG.ADZUNA_QUERIES; // reuse the same L&D query set
  const total = locations.length * queries.length;
  let cursor = 0;
  try {
    const stored = await kvGet("discovery:jooble_cursor");
    if (stored) cursor = parseInt(stored, 10) || 0;
  } catch {}
  const slice = [];
  for (let i = 0; i < CONFIG.JOOBLE_CALLS_PER_RUN; i++) {
    const idx = (cursor + i) % total;
    const loc = locations[idx % locations.length];
    const q = queries[Math.floor(idx / locations.length) % queries.length];
    slice.push({ location: loc, query: q });
  }
  const newCursor = (cursor + CONFIG.JOOBLE_CALLS_PER_RUN) % total;
  try { await kvPut("discovery:jooble_cursor", String(newCursor)); } catch {}
  return slice;
}

// =============================================================================
// ROUND-ROBIN INTERLEAVE — balance jobs across sources before analyzing
// =============================================================================
function interleaveBySource(jobs) {
  const buckets = {};
  for (const j of jobs) {
    const key = (j.company || "unknown").toLowerCase();
    (buckets[key] = buckets[key] || []).push(j);
  }
  const order = Object.keys(buckets);
  for (let i = order.length - 1; i > 0; i--) {
    const k = Math.floor(Math.random() * (i + 1));
    [order[i], order[k]] = [order[k], order[i]];
  }
  const out = [];
  let added = true, idx = 0;
  while (added) {
    added = false;
    for (const key of order) {
      const arr = buckets[key];
      if (idx < arr.length) { out.push(arr[idx]); added = true; }
    }
    idx++;
  }
  return out;
}

// =============================================================================
// ANALYZE & SAVE — calls the analyzer worker via its public URL
// =============================================================================
async function analyzeAndSave(job, report) {
  const description = job.description || "";
  const content = `Job Title: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location}\n\n${description}`.slice(0, 12000);
  const payload = { content, url: job.url, title: job.title, postedDate: job.postedDate || "" };

  const MAX_TRIES = 3;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const res = await fetch(ENV.CAREER_ANALYZER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) return true;
      let bodySnippet = "";
      try { bodySnippet = (await res.text()).slice(0, 200); } catch {}
      const transient = res.status === 502 || res.status === 503 || res.status === 429
        || /503|high demand|RESOURCE_EXHAUSTED|overload/i.test(bodySnippet);
      if (transient && attempt < MAX_TRIES) {
        await new Promise(r => setTimeout(r, attempt * 1500));
        continue;
      }
      report.push(`analyze FAIL ${res.status} (try ${attempt}) :: ${bodySnippet.slice(0, 120)} :: ${job.title.slice(0, 28)}`);
      return false;
    } catch (e) {
      if (attempt < MAX_TRIES) { await new Promise(r => setTimeout(r, attempt * 1500)); continue; }
      report.push(`analyze ERR ${e.message}: ${job.title.slice(0, 40)}`);
      return false;
    }
  }
  return false;
}

// =============================================================================
// MAIN
// =============================================================================
async function main() {
  requireEnv(["CF_ACCOUNT_ID","CF_API_TOKEN","CF_KV_NAMESPACE_ID","CAREER_ANALYZER_URL"]);
  const report = [];
  let collected = [];

  // ---- 1. Collect from all sources ------------------------------------------
  for (const t of CONFIG.ATS.greenhouse) collected.push(...await fetchGreenhouse(t, report));
  for (const t of CONFIG.ATS.lever) collected.push(...await fetchLever(t, report));
  for (const t of CONFIG.ATS.ashby) collected.push(...await fetchAshby(t, report));
  if (CONFIG.ADZUNA_ENABLED && ENV.ADZUNA_APP_ID && ENV.ADZUNA_APP_KEY) {
    // Rotation across the full country×query matrix — different slice each run.
    const slice = await pickAdzunaSlice();
    for (const { country, query } of slice) {
      collected.push(...await fetchAdzuna(country, query, report));
    }
  } else if (CONFIG.ADZUNA_ENABLED) {
    report.push("adzuna -> skipped (ADZUNA_APP_ID / ADZUNA_APP_KEY not set)");
  }
  if (CONFIG.JOOBLE_ENABLED && ENV.JOOBLE_API_KEY) {
    const jslice = await pickJoobleSlice();
    for (const { location, query } of jslice) {
      collected.push(...await fetchJooble(location, query, report));
    }
  } else if (CONFIG.JOOBLE_ENABLED) {
    report.push("jooble -> skipped (JOOBLE_API_KEY not set)");
  }
  report.push(`--- collected ${collected.length} raw postings ---`);

  // ---- 2. Balance via round-robin ------------------------------------------
  collected = interleaveBySource(collected);

  // ---- 3. Filter + dedup + analyze -----------------------------------------
  let analyzed = 0, passed = 0, dupes = 0, attempts = 0;
  const srcStats = {};
  const bump = (c, field) => { const k = (c||'?').toLowerCase(); (srcStats[k] = srcStats[k] || {seen:0,filtered:0,analyzed:0})[field]++; };

  for (const job of collected) {
    if (attempts >= CONFIG.MAX_ANALYZE_PER_RUN) {
      report.push(`hit MAX_ANALYZE_PER_RUN (${CONFIG.MAX_ANALYZE_PER_RUN} attempts) — remaining roll to next run`);
      break;
    }
    if (!job.url) continue;
    bump(job.company, 'seen');
    const blob = `${job.title} ${job.location} ${job.description}`;
    if (job.thinText) {
      if (!thinTextWorthAnalyzing(job.title)) { bump(job.company, 'filtered'); continue; }
    } else {
      if (!prefilterPass(blob, 2)) { bump(job.company, 'filtered'); continue; }
    }
    passed++;

    const sk = seenKey(job.url);
    const fp = fingerprintKey(job);
    try {
      if (await kvGet(sk)) { dupes++; continue; }
      if (await kvGet(fp)) { dupes++; report.push(`dup (cross-source): ${job.title.slice(0, 40)}`); continue; }
      // Mark seen BEFORE analyzing so a failed analyze doesn't retry next run.
      await kvPut(sk, String(Date.now()), CONFIG.SEEN_TTL_SECONDS);
      await kvPut(fp, String(Date.now()), CONFIG.SEEN_TTL_SECONDS);
    } catch (e) {
      report.push(`KV error: ${e.message}`);
      continue;
    }

    attempts++;
    const ok = await analyzeAndSave(job, report);
    if (ok) { analyzed++; bump(job.company, 'analyzed'); }
  }

  const sourceDiag = Object.keys(srcStats).sort().map(k => {
    const s = srcStats[k];
    return `${k}: seen ${s.seen}, filtered-out ${s.filtered}, analyzed ${s.analyzed}`;
  });

  const summary = {
    ranAt: new Date().toISOString(),
    rawCollected: collected.length,
    passedPrefilter: passed,
    skippedDuplicates: dupes,
    analyzedAndSaved: analyzed,
    perSource: report,
    sourceDiagnostics: sourceDiag,
  };

  try { await kvPut("discovery:last_run", JSON.stringify(summary)); } catch (e) { console.error("Failed to save summary:", e.message); }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
