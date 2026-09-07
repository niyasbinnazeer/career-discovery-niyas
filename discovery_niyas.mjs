// discovery_niyas.mjs — Node.js discovery job for Niyas's L&D / eLearning search.
// Discovers, pre-filters, dedupes against Cloudflare KV, resolves off-aggregator apply links,
// and submits jobs to career-intelligence-api-niyas for AI analysis.
//
// Designed to run as a scheduled GitHub Action (no Cloudflare Workers subrequest cap).

import { createHash } from "node:crypto";

// =============================================================================
// CONFIG
// =============================================================================
const CONFIG = {
  // Max jobs analyzed per run. Set to 75 to comfortably guarantee at least 30+ jobs per run.
  MAX_ANALYZE_PER_RUN: 75,
  TARGET_MIN_ANALYZE: 30,

  // Dedup keys persist 21 days (fresh window), preventing stale multi-month locks
  SEEN_TTL_SECONDS: 60 * 60 * 24 * 21,

  // Company ATS boards (EdTech + tech scaleups with dedicated L&D / enablement orgs).
  ATS: {
    greenhouse: [
      // EdTech / learning companies (highest yield for L&D roles)
      "coursera", "udacity", "duolingo", "khanacademy", "codecademy",
      "outschool", "multiverse", "guildeducation", "degreed", "pluralsight",
      "docebo", "go1", "360learning", "instructure", "udemy", "skillsoft",
      "chegg", "quizlet", "brilliant", "masterclass", "newsela", "edmentum",
      "labster", "paper", "panorama", "nerdy", "learnupon", "cornerstone",
      // Global tech with verified active boards
      "thoughtworks", "inmobi", "postman", "freshworks",
      "stripe", "databricks", "figma", "notion", "gitlab", "asana",
      "dropbox", "twilio", "airbnb", "pinterest", "reddit", "doordash",
      "instacart", "robinhood", "brex", "ramp", "gusto", "samsara",
      "hashicorp", "confluent", "mongodb", "elastic", "datadog", "plaid",
      "affirm", "coinbase", "discord", "canva", "atlassian", "shopify",
      "wise", "revolut", "deliveroo", "snowflake",
    ],
    lever: [
      "sanalabs", "uplimit", "lingoda", "maven", "springboard",
      "cambly", "classdojo", "highspot", "benchling", "outreach",
      "grammarly", "automattic",
    ],
    ashby: [
      "synthesisschool", "deel", "replit",
    ],
  },

  // ---- ADZUNA (19 countries, prioritized across runs) ----
  ADZUNA_ENABLED: true,
  ADZUNA_COUNTRIES: [
    "in", "gb", "us", "sg", "de", "ae", "au", "ca", "nl", "ie",
    "at", "be", "ch", "pl", "fr", "es", "it", "nz", "za",
  ],
  ADZUNA_QUERIES: [
    "instructional designer",
    "learning experience designer",
    "elearning developer",
    "learning designer",
    "learning and development specialist",
    "curriculum developer",
    "instructional design",
    "articulate storyline",
    "learning technologist",
    "digital learning designer",
    "learning engineer",
    "training content developer",
  ],
  ADZUNA_CALLS_PER_RUN: 16,
  ADZUNA_RESULTS_PER_CALL: 50,
  ADZUNA_MAX_DAYS_OLD: 14,

  // ---- JOOBLE ----
  JOOBLE_ENABLED: true,
  JOOBLE_LOCATIONS: [
    "India",
    "Bengaluru",
    "Remote",
    "Worldwide Remote",
    "United Arab Emirates",
    "Dubai",
    "Singapore",
  ],
  // Comma-separated query bundles all keywords into a single Jooble request per location.
  JOOBLE_COMBINED_KEYWORDS: "instructional designer, elearning developer, learning experience designer, l&d specialist, curriculum developer",
  JOOBLE_CALLS_PER_RUN: 6,
  JOOBLE_RESULTS_PER_CALL: 40,

  // ---- LINKEDIN JOBS (Public guest search — no API key needed) ----
  LINKEDIN_ENABLED: true,
  LINKEDIN_QUERIES: [
    '"instructional designer" OR "learning experience designer"',
    '"elearning developer" OR "learning designer"',
    '"curriculum developer" OR "learning technologist"',
  ],
  LINKEDIN_LOCATIONS: [
    "India",
    "Remote",
    "United Arab Emirates",
    "United Kingdom",
  ],
  LINKEDIN_MAX_PER_QUERY: 25,

  // ---- JSEARCH (Google for Jobs via RapidAPI — optional, activates if RAPIDAPI_KEY set) ----
  JSEARCH_ENABLED: true,
  JSEARCH_QUERIES: [
    "Instructional Designer",
    "Learning Experience Designer",
    "eLearning Developer",
    "Curriculum Developer",
  ],
  JSEARCH_LOCATIONS: ["India", "Remote", "United Kingdom", "United States", "United Arab Emirates"],

  // ---- JOBICY (free, no key — remote jobs) ----
  JOBICY_ENABLED: true,
  JOBICY_CALLS: [
    { industry: "education" },
    { tag: "instructional designer" },
    { tag: "learning experience" },
    { tag: "elearning" },
    { tag: "learning designer" },
    { tag: "curriculum" },
    { tag: "training" },
  ],
  JOBICY_RESULTS_PER_CALL: 50,

  // ---- HIMALAYAS (free, no key — remote jobs) ----
  HIMALAYAS_ENABLED: true,
  HIMALAYAS_QUERIES: [
    "instructional designer",
    "learning experience designer",
    "elearning developer",
    "learning designer",
    "learning and development",
    "curriculum",
    "training specialist",
  ],
};

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 5000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

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
  RAPIDAPI_KEY: process.env.RAPIDAPI_KEY,
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
  "instructional design", "instructional designer", "elearning", "e-learning",
  "learning experience", "learning designer", "learning design", "lxd",
  "articulate storyline", "storyline 360", "storyline", "rise 360", "captivate",
  "scorm", "xapi", "cmi5", "lms", "learning management", "authoring tool",
  "curriculum", "course development", "course design", "learning and development",
  "l&d", "learning technologist", "learning engineer", "learning technology",
  "training content", "learning content", "edtech", "educational technology",
  "wcag", "accessible elearning", "learning analytics", "microlearning",
  "blended learning", "digital learning", "instructional",
];

// Title-level exclusions (checked with word boundaries to avoid false positives like "Sales Enablement Trainer")
const EXCLUDED_TITLE_PATTERNS = [
  /\b(?:sales\s+rep(?:resentative)?|account\s+executive|business\s+development|bdr|sdr)\b/i,
  /\b(?:medical\s+billing|medical\s+coder|nurse|nursing|physician|pharmacist)\b/i,
  /\b(?:call\s+cent(?:er|re)|telecaller|telemarketer|customer\s+support\s+rep)\b/i,
  /\b(?:software\s+engineer|backend\s+developer|devops|full\s*stack\s+developer|security\s+engineer)\b/i,
  /\b(?:warehouse|forklift|truck\s+driver|delivery\s+driver|security\s+guard|electrician|plumber)\b/i,
  /\b(?:accountant|bookkeeper|tax\s+associate|auditor)\b/i,
  /\b(?:recruiter|talent\s+acquisition\s+specialist)\b/i,
  /\b(?:product\s+designer|graphic\s+designer|ui\s*\/\s*ux\s+designer|interior\s+designer)\b/i,
];

// Body-level negative phrases — only strictly unambiguous non-L&D job indicators
const BODY_HARD_NEGATIVE = [
  "cold calling", "outbound calling", "door to door", "patient care", "clinical bedside",
  "commercial driving license", "cdl-a", "cdl class a", "hvac technician", "lawn care",
];

function isTitleExcluded(title) {
  const t = (title || "").trim();
  return EXCLUDED_TITLE_PATTERNS.some(re => re.test(t));
}

function isLocationEligible(job) {
  const loc = (job.location || "").toLowerCase();
  const text = `${job.title || ""} ${job.location || ""} ${job.description || ""}`.toLowerCase();
  const url = job.url || "";

  // Only Jooble actively blocks overseas candidates on US/Canada on-site postings ("requires local presence")
  if (/jooble\.org/i.test(url)) {
    if (/remote|work from home|wfh|anywhere|worldwide|distributed|virtual/.test(loc)) return true;
    if (/\b(?:100%\s*remote|fully\s*remote|remote\s*(?:first|eligible|friendly|option)|work\s*from\s*anywhere)\b/.test(text)) return true;
    if (/india|bengaluru|bangalore|hyderabad|mumbai|delhi|pune|chennai|noida|gurgaon/.test(loc)) return true;
    if (/dubai|abu dhabi|uae|emirates|singapore/.test(loc)) return true;
    if (/uk|united kingdom|london|england|germany|netherlands|ireland|europe/.test(loc)) return true;
    if (/visa|relocation|sponsor/.test(text)) return true;
    return false;
  }

  // All direct ATS (Greenhouse/Lever/Ashby), LinkedIn, Adzuna, Himalayas, Jobicy jobs are eligible
  return true;
}

function prefilterPass(job) {
  const title = job.title || "";
  if (isTitleExcluded(title)) return false;
  if (!isLocationEligible(job)) return false;

  const text = `${title} ${job.location || ""} ${job.description || ""}`.toLowerCase();
  if (text.length < 40) return false;

  let score = 0;
  for (const kw of STRONG_POSITIVE) {
    if (text.includes(kw)) score += 2;
  }
  for (const neg of BODY_HARD_NEGATIVE) {
    if (text.includes(neg)) score -= 4;
  }

  return score >= 2;
}

function thinTextWorthAnalyzing(title) {
  const t = (title || "").toLowerCase().trim();
  if (t.length < 8) return false;
  if (isTitleExcluded(title)) return false;

  const JUNK = [
    "read more", "apply now", "apply here", "view all", "see all", "login",
    "sign in", "register", "subscribe", "newsletter", "cookie", "privacy", "terms",
    "contact us", "about us", "home", "next", "previous", "load more", "search jobs",
    "search for jobs", "saved jobs", "jobs expiring", "expiring soon", "browse",
    "filter", "sort by", "all jobs", "my account", "create account", "post a job",
  ];
  for (const j of JUNK) {
    if (t === j || t.startsWith(j)) return false;
  }

  const TOO_SENIOR = [
    "chief learning officer", "vice president", "executive director", "head of department",
    "vp ", "svp ",
  ];
  for (const s of TOO_SENIOR) {
    if (t.includes(s)) return false;
  }

  // Require qualified domain indicator — not generic "design" alone
  const DOMAIN = [
    "learning", "training", "instructional", "elearning", "e-learning",
    "curriculum", "course", "education", "lms", "edtech", "scorm", "xapi",
    "storyline", "captivate", "articulate", "instructional design",
    "learning experience", "learning design", "lxd", "l&d", "enablement",
    "pedagogy", "instruction", "trainer", "talent development",
  ];
  return DOMAIN.some(d => t.includes(d));
}

function stripHtml(s) {
  return (s || "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'")
    .replace(/&#8217;/gi, "'").replace(/&#8220;|&#8221;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlUrl(s) {
  return (s || "")
    .replace(/&amp;/gi, "&").replace(/&#38;/g, "&")
    .replace(/&quot;/gi, '"').replace(/&#34;/g, '"')
    .replace(/&#39;/gi, "'").replace(/&#x2f;/gi, "/");
}

function sameDomain(a, b) {
  try {
    return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase();
  } catch {
    return true;
  }
}

function resolveRelative(maybeRelative, base) {
  try {
    return new URL(decodeHtmlUrl(maybeRelative), base).toString();
  } catch {
    return null;
  }
}

// =============================================================================
// DIRECT APPLY LINK RESOLUTION
// =============================================================================
async function resolveDirectApplyUrl(pageUrl, maxHops = 6) {
  if (!pageUrl) return null;
  const isAggregator = (u) => /adzuna\.|jooble\.org|linkedin\.com/i.test(u);
  if (!isAggregator(pageUrl)) return pageUrl;

  let current = pageUrl;
  for (let hop = 0; hop < maxHops; hop++) {
    let res;
    try {
      res = await fetch(current, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": BROWSER_UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      return !isAggregator(current) ? current : null;
    }

    const finalUrl = res.url || current;
    if (finalUrl !== current && !sameDomain(finalUrl, pageUrl) && !isAggregator(finalUrl)) {
      return finalUrl;
    }

    let html = "";
    try {
      html = await res.text();
    } catch {
      return !isAggregator(finalUrl) ? finalUrl : null;
    }

    // 1. <meta http-equiv="refresh" content="...url=...">
    const metaRefresh = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^;]+;\s*url=([^"'>\s]+)/i)
      || html.match(/<meta[^>]+content=["'][^;]+;\s*url=([^"'>\s]+)["'][^>]+http-equiv=["']?refresh["']?/i);
    if (metaRefresh) {
      const u = resolveRelative(metaRefresh[1], current);
      if (u && !sameDomain(u, pageUrl) && !isAggregator(u)) return u;
      if (u && u !== current) { current = u; continue; }
    }

    // 2. JS redirect: location.href = "..."
    const jsRedir = html.match(/(?:window\.)?location(?:\.href|\.replace)\s*=\s*["']([^"']+)["']/i);
    if (jsRedir) {
      const u = resolveRelative(jsRedir[1], current);
      if (u && !sameDomain(u, pageUrl) && !isAggregator(u)) return u;
      if (u && u !== current) { current = u; continue; }
    }

    // 3. Aggregator tracking hop (/land/ad/ or /track/)
    const landMatch = html.match(/href=["']([^"']*(?:land\/ad|redirect|track)[^"']*)["']/i);
    if (landMatch) {
      const u = resolveRelative(landMatch[1], current);
      if (u && u !== current) { current = u; continue; }
    }

    // 4. JSON-LD JobPosting url
    const lds = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const block of lds) {
      try {
        const json = block.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "").trim();
        const parsed = JSON.parse(json);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of list) {
          const cand = item && (item.url || item.sameAs || item.potentialAction?.target?.url);
          if (typeof cand === "string" && !sameDomain(cand, pageUrl) && !isAggregator(cand)) {
            return cand;
          }
        }
      } catch {}
    }

    if (!isAggregator(finalUrl)) return finalUrl;
    return null;
  }

  return !isAggregator(current) ? current : null;
}

// =============================================================================
// CLOUDFLARE KV REST CLIENT (Fail-Open on Reads)
// =============================================================================
const KV_BASE = () => `https://api.cloudflare.com/client/v4/accounts/${ENV.CF_ACCOUNT_ID}/storage/kv/namespaces/${ENV.CF_KV_NAMESPACE_ID}`;
const KV_HEADERS = () => ({ "Authorization": `Bearer ${ENV.CF_API_TOKEN}` });

async function kvGet(key) {
  try {
    const res = await fetch(`${KV_BASE()}/values/${encodeURIComponent(key)}`, {
      headers: KV_HEADERS(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`KV read warning for ${key}: HTTP ${res.status}`);
      return null; // Fail-open: treat as not seen to prevent dropping real jobs
    }
    return await res.text();
  } catch (e) {
    console.warn(`KV read error for ${key}: ${e.message}`);
    return null; // Fail-open
  }
}

async function kvPut(key, value, ttlSeconds) {
  const url = `${KV_BASE()}/values/${encodeURIComponent(key)}` + (ttlSeconds ? `?expiration_ttl=${ttlSeconds}` : "");
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...KV_HEADERS(), "Content-Type": "text/plain" },
    body: typeof value === "string" ? value : JSON.stringify(value),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`KV put ${key} -> ${res.status}`);
}

// =============================================================================
// DEDUP KEYS
// =============================================================================
function sha1Hex(s) {
  return createHash("sha1").update(s).digest("hex");
}

function cleanTrackingParams(rawUrl) {
  if (!rawUrl) return "";
  try {
    if (typeof URL !== "undefined") {
      const u = new URL(rawUrl);
      const tracking = [
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
        "gh_src", "ref", "source", "fbclid", "gclid", "mc_cid", "mc_eid",
      ];
      for (const p of tracking) u.searchParams.delete(p);
      return u.toString();
    }
  } catch {}
  return rawUrl.replace(/([?&])(?:utm_[a-z]+|gh_src|fbclid|gclid|mc_[ce]id|ref)=[^&#]*/gi, "$1")
    .replace(/[?&]$/, "")
    .replace(/[?&]&+/g, (m) => m[0]);
}

function seenKey(url) {
  const cleaned = cleanTrackingParams(url);
  return "seen:v2:" + sha1Hex(cleaned).slice(0, 24);
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
  return "fp:v2:" + sha1Hex(`${company}|${title}`).slice(0, 24);
}

function normalizePostedDate(raw) {
  if (!raw) return "";
  const t = Date.parse(raw);
  if (!isNaN(t)) return new Date(t).toISOString();
  const lower = String(raw).toLowerCase().trim();
  const now = Date.now();
  const hrMatch = lower.match(/(\d+)\s*(?:hour|hr)/);
  if (hrMatch) return new Date(now - parseInt(hrMatch[1], 10) * 3600000).toISOString();
  const dayMatch = lower.match(/(\d+)\s*(?:day|d)/);
  if (dayMatch) return new Date(now - parseInt(dayMatch[1], 10) * 86400000).toISOString();
  const wkMatch = lower.match(/(\d+)\s*(?:week|wk)/);
  if (wkMatch) return new Date(now - parseInt(wkMatch[1], 10) * 7 * 86400000).toISOString();
  const moMatch = lower.match(/(\d+)\s*(?:month|mo)/);
  if (moMatch) return new Date(now - parseInt(moMatch[1], 10) * 30 * 86400000).toISOString();
  if (lower.includes("yesterday")) return new Date(now - 86400000).toISOString();
  if (lower.includes("today") || lower.includes("just now")) return new Date(now).toISOString();
  return raw;
}

async function cleanupStaleDashboardJobs() {
  if (!ENV.CAREER_ANALYZER_URL) return;
  try {
    const dashUrl = ENV.CAREER_ANALYZER_URL.replace("career-intelligence-api-niyas", "career-dashboard-niyas");
    const res = await fetch(`${dashUrl}/api/cleanup-stale?key=niyas-2026&days=15`, {
      method: "POST",
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.deleted > 0) {
        console.log(`[maintenance] Auto-deleted ${data.deleted} unattended jobs older than 15 days.`);
      }
    }
  } catch (e) {
    // Non-fatal background maintenance
  }
}

// =============================================================================
// SOURCE ADAPTERS
// =============================================================================

// ---- Greenhouse ATS ----
async function fetchGreenhouse(token, report) {
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`, {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) { report.push(`greenhouse:${token} -> HTTP ${res.status}`); return []; }
    const data = await res.json();
    const jobs = (data.jobs || []).map(j => ({
      title: stripHtml(j.title || ""),
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

// ---- Lever ATS ----
async function fetchLever(token, report) {
  try {
    const res = await fetch(`https://api.lever.co/v0/postings/${token}?mode=json`, {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) { report.push(`lever:${token} -> HTTP ${res.status}`); return []; }
    const data = await res.json();
    const jobs = (data || []).map(j => ({
      title: stripHtml(j.text || ""),
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

// ---- Ashby ATS ----
async function fetchAshby(token, report) {
  try {
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`, {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) { report.push(`ashby:${token} -> HTTP ${res.status}`); return []; }
    const data = await res.json();
    const jobs = (data.jobs || []).map(j => ({
      title: stripHtml(j.title || ""),
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

// ---- Adzuna ----
async function fetchAdzuna(country, query, report) {
  if (!ENV.ADZUNA_APP_ID || !ENV.ADZUNA_APP_KEY) return [];
  const params = new URLSearchParams({
    app_id: ENV.ADZUNA_APP_ID,
    app_key: ENV.ADZUNA_APP_KEY,
    what: query,
    results_per_page: String(CONFIG.ADZUNA_RESULTS_PER_CALL),
    max_days_old: String(CONFIG.ADZUNA_MAX_DAYS_OLD),
    "content-type": "application/json",
  });
  const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) { report.push(`adzuna:${country}:"${query}" -> HTTP ${res.status}`); return []; }
    const data = await res.json();
    const jobs = (data.results || []).map(j => ({
      title: stripHtml(j.title || ""),
      // Fix: Use actual employer name instead of hardcoded adzuna:country to prevent duplicate collisions
      company: stripHtml(j.company?.display_name || "Adzuna"),
      location: j.location?.display_name || (j.location?.area || []).slice(-2).join(", ") || "",
      url: j.redirect_url || "",
      description: stripHtml(j.description || ""),
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

// ---- Jooble (Optimized with bundled keywords & browser headers) ----
async function fetchJooble(location, report) {
  if (!ENV.JOOBLE_API_KEY) return [];
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const res = await fetch(`https://jooble.org/api/${ENV.JOOBLE_API_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": BROWSER_UA,
        "Accept": "application/json",
      },
      body: JSON.stringify({
        keywords: CONFIG.JOOBLE_COMBINED_KEYWORDS,
        location,
        datecreatedfrom: sevenDaysAgo,
        page: "1",
        ResultOnPage: CONFIG.JOOBLE_RESULTS_PER_CALL,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const bodyText = await res.text();
    if (!res.ok) { report.push(`jooble:${location} -> HTTP ${res.status}`); return []; }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      report.push(`jooble:${location} -> non-JSON response`);
      return [];
    }

    if (data.errors || (!Array.isArray(data.jobs) && data.jobs !== undefined)) {
      report.push(`jooble:${location} -> API error: ${JSON.stringify(data.errors || data).slice(0, 80)}`);
      return [];
    }

    const jobs = (data.jobs || []).map(j => ({
      title: stripHtml(j.title || ""),
      company: stripHtml(j.company || ""),
      location: j.location || location,
      url: j.link || "",
      description: stripHtml(j.snippet || ""),
      postedDate: j.updated || "",
      thinText: true,
    }));
    report.push(`jooble:${location} -> ${jobs.length}`);
    return jobs;
  } catch (e) { report.push(`jooble:${location} -> ERR ${e.message}`); return []; }
}

async function pickJoobleSlice() {
  const locations = CONFIG.JOOBLE_LOCATIONS;
  let cursor = 0;
  try {
    const stored = await kvGet("discovery:jooble_cursor");
    if (stored) cursor = parseInt(stored, 10) || 0;
  } catch {}
  const slice = [];
  for (let i = 0; i < CONFIG.JOOBLE_CALLS_PER_RUN; i++) {
    const idx = (cursor + i) % locations.length;
    slice.push(locations[idx]);
  }
  const newCursor = (cursor + CONFIG.JOOBLE_CALLS_PER_RUN) % locations.length;
  try { await kvPut("discovery:jooble_cursor", String(newCursor)); } catch {}
  return slice;
}

// ---- LinkedIn Jobs (Public Guest API — No Key Required) ----
async function searchLinkedIn(keywordsQuery, location) {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(keywordsQuery)}&location=${encodeURIComponent(location)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  const jobs = [];
  const linkMatches = [...html.matchAll(/<a[^>]*class=["'][^"']*base-card__full-link[^"']*["'][^>]*href=["']([^"']+)["']/gi)];
  const titleMatches = [...html.matchAll(/<h3[^>]*class=["'][^"']*base-search-card__title[^"']*["'][^>]*>\s*([\s\S]*?)\s*<\/h3>/gi)];
  const compMatches = [...html.matchAll(/<h4[^>]*class=["'][^"']*base-search-card__subtitle[^"']*["'][^>]*>[\s\S]*?<a[^>]*>\s*([\s\S]*?)\s*<\/a>/gi)];
  const locMatches = [...html.matchAll(/<span[^>]*class=["'][^"']*job-search-card__location[^"']*["'][^>]*>\s*([\s\S]*?)\s*<\/span>/gi)];

  for (let i = 0; i < linkMatches.length; i++) {
    const rawLink = linkMatches[i][1];
    const idMatch = rawLink.match(/-(\d+)(?:\?|$)/);
    if (!idMatch) continue;

    const jobId = idMatch[1];
    const cleanLink = `https://www.linkedin.com/jobs/view/${jobId}`;
    const title = titleMatches[i] ? stripHtml(titleMatches[i][1]) : "";
    const company = compMatches[i] ? stripHtml(compMatches[i][1]) : "";
    const loc = locMatches[i] ? stripHtml(locMatches[i][1]) : location;

    jobs.push({ id: jobId, title, company, location: loc, url: cleanLink });
  }

  return jobs;
}

async function fetchLinkedInDetail(jobId) {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  const descMatch = html.match(/<div[^>]*class=["'][^"']*show-more-less-html__markup[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  const snippet = descMatch ? stripHtml(descMatch[1]).slice(0, 5000) : "";

  const dateMatch = html.match(/<span[^>]*class=["'][^"']*posted-time-ago__text[^"']*["'][^>]*>\s*([\s\S]*?)\s*<\/span>/i);
  const postedDate = dateMatch ? stripHtml(dateMatch[1]) : "";

  return { snippet, postedDate };
}

// ---- JSearch (Google for Jobs via RapidAPI — Optional) ----
async function fetchJSearch(query, location, report) {
  if (!ENV.RAPIDAPI_KEY) return [];
  const fullQuery = `${query} in ${location}`;
  const url = `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(fullQuery)}&page=1&num_pages=1&date_posted=all`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "x-rapidapi-key": ENV.RAPIDAPI_KEY,
        "x-rapidapi-host": "jsearch.p.rapidapi.com",
        "User-Agent": BROWSER_UA,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) { report.push(`jsearch:${location} -> HTTP ${res.status}`); return []; }
    const data = await res.json();
    const rawList = Array.isArray(data.data) ? data.data : [];
    const jobs = rawList.map(item => ({
      title: stripHtml(item.job_title || ""),
      company: stripHtml(item.employer_name || ""),
      location: item.job_city ? `${item.job_city}, ${item.job_country || ""}` : location,
      url: item.job_apply_link || item.job_google_link || "",
      description: stripHtml(item.job_description || "").slice(0, 5000),
      postedDate: item.job_posted_at_datetime_utc || "",
      directApplyUrl: item.job_apply_link || "",
    }));
    report.push(`jsearch:${location} -> ${jobs.length}`);
    return jobs;
  } catch (e) { report.push(`jsearch:${location} -> ERR ${e.message}`); return []; }
}

// ---- Jobicy (Remote) ----
async function fetchJobicy(params, report) {
  const label = params.industry ? `industry=${params.industry}` : `tag=${params.tag}`;
  const qs = new URLSearchParams({ count: String(CONFIG.JOBICY_RESULTS_PER_CALL), ...params });
  try {
    const res = await fetch(`https://jobicy.com/api/v2/remote-jobs?${qs}`, {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) { report.push(`jobicy:${label} -> HTTP ${res.status}`); return []; }
    const data = await res.json();
    const jobs = (data.jobs || []).map(j => ({
      title: stripHtml(j.jobTitle || ""),
      company: stripHtml(j.companyName || ""),
      location: j.jobGeo || "Remote",
      url: j.url || "",
      description: stripHtml(j.jobDescription || j.jobExcerpt || ""),
      postedDate: j.pubDate || "",
    }));
    report.push(`jobicy:${label} -> ${jobs.length}`);
    return jobs;
  } catch (e) { report.push(`jobicy:${label} -> ERR ${e.message}`); return []; }
}

// ---- Himalayas (Remote) ----
async function fetchHimalayas(query, report) {
  try {
    const res = await fetch(`https://himalayas.app/jobs/api/search?keywords=${encodeURIComponent(query)}&limit=20`, {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) { report.push(`himalayas:"${query}" -> HTTP ${res.status}`); return []; }
    const data = await res.json();
    const arr = data.jobs || data.data || [];
    const jobs = arr.map(j => {
      let posted = j.pubDate || j.publishedDate || j.updated || "";
      if (typeof posted === "number") posted = new Date(posted * 1000).toISOString();
      const loc = Array.isArray(j.locationRestrictions) && j.locationRestrictions.length
        ? j.locationRestrictions.join(", ") : "Remote";
      return {
        title: stripHtml(j.title || j.jobTitle || ""),
        company: stripHtml(j.companyName || j.company || ""),
        location: loc,
        url: j.applicationLink || j.url || j.guid || "",
        description: stripHtml(j.description || j.excerpt || ""),
        postedDate: posted,
      };
    });
    report.push(`himalayas:"${query}" -> ${jobs.length}`);
    return jobs;
  } catch (e) { report.push(`himalayas:"${query}" -> ERR ${e.message}`); return []; }
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
  const payload = {
    content,
    url: job.url,
    title: job.title,
    postedDate: normalizePostedDate(job.postedDate) || "",
    directApplyUrl: job.directApplyUrl || "",
  };

  const MAX_TRIES = 3;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const res = await fetch(ENV.CAREER_ANALYZER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return true;

      let bodySnippet = "";
      try { bodySnippet = (await res.text()).slice(0, 200); } catch {}
      const transient = res.status === 502 || res.status === 503 || res.status === 429
        || /503|high demand|RESOURCE_EXHAUSTED|overload/i.test(bodySnippet);

      if (transient && attempt < MAX_TRIES) {
        await sleep(attempt * 1500);
        continue;
      }
      report.push(`analyzer -> HTTP ${res.status}: ${bodySnippet}`);
      return false;
    } catch (e) {
      if (attempt < MAX_TRIES) { await sleep(attempt * 1500); continue; }
      report.push(`analyzer -> ERR: ${e.message}`);
      return false;
    }
  }
  return false;
}

// =============================================================================
// MAIN
// =============================================================================
async function main() {
  requireEnv(["CF_ACCOUNT_ID", "CF_API_TOKEN", "CF_KV_NAMESPACE_ID", "CAREER_ANALYZER_URL"]);
  const report = [];
  let collected = [];

  // Auto-cleanup unattended jobs older than 15 days from the dashboard KV
  await cleanupStaleDashboardJobs();

  // ---- 1. Collect from all sources ------------------------------------------
  for (const t of CONFIG.ATS.greenhouse) {
    collected.push(...await fetchGreenhouse(t, report));
    await sleep(60);
  }
  for (const t of CONFIG.ATS.lever) {
    collected.push(...await fetchLever(t, report));
  }
  for (const t of CONFIG.ATS.ashby) {
    collected.push(...await fetchAshby(t, report));
  }

  // Adzuna
  if (CONFIG.ADZUNA_ENABLED && ENV.ADZUNA_APP_ID && ENV.ADZUNA_APP_KEY) {
    const slice = await pickAdzunaSlice();
    for (const { country, query } of slice) {
      collected.push(...await fetchAdzuna(country, query, report));
      await sleep(150);
    }
  } else if (CONFIG.ADZUNA_ENABLED) {
    report.push("adzuna -> skipped (ADZUNA_APP_ID / ADZUNA_APP_KEY not set)");
  }

  // Jooble (bundled)
  if (CONFIG.JOOBLE_ENABLED && ENV.JOOBLE_API_KEY) {
    const locations = await pickJoobleSlice();
    for (const location of locations) {
      collected.push(...await fetchJooble(location, report));
      await sleep(250);
    }
  } else if (CONFIG.JOOBLE_ENABLED) {
    report.push("jooble -> skipped (JOOBLE_API_KEY not set)");
  }

  // LinkedIn Jobs (Public Guest API)
  if (CONFIG.LINKEDIN_ENABLED) {
    let linkedInFound = 0;
    for (const location of CONFIG.LINKEDIN_LOCATIONS) {
      for (const query of CONFIG.LINKEDIN_QUERIES) {
        let cards = [];
        try {
          cards = await searchLinkedIn(query, location);
        } catch (e) {
          report.push(`linkedin:"${query}" in ${location} -> ERR ${e.message}`);
          continue;
        }

        for (const card of cards.slice(0, CONFIG.LINKEDIN_MAX_PER_QUERY)) {
          // Pre-check KV before queuing
          const sk = seenKey(card.url);
          const alreadySeen = await kvGet(sk);
          if (alreadySeen) continue;

          collected.push({
            id: card.id,
            title: card.title,
            company: card.company,
            location: card.location,
            url: card.url,
            description: card.title,
            postedDate: "",
            thinText: true,
            isLinkedIn: true,
          });
          linkedInFound++;
        }
        await sleep(100);
      }
    }
    report.push(`linkedin -> ${linkedInFound} postings harvested`);
  }

  // JSearch (Google for Jobs via RapidAPI)
  if (CONFIG.JSEARCH_ENABLED && ENV.RAPIDAPI_KEY) {
    for (const location of CONFIG.JSEARCH_LOCATIONS) {
      for (const query of CONFIG.JSEARCH_QUERIES) {
        collected.push(...await fetchJSearch(query, location, report));
        await sleep(200);
      }
    }
  }

  // Jobicy (Remote)
  if (CONFIG.JOBICY_ENABLED) {
    for (const p of CONFIG.JOBICY_CALLS) {
      collected.push(...await fetchJobicy(p, report));
      await sleep(150);
    }
  }

  // Himalayas (Remote)
  if (CONFIG.HIMALAYAS_ENABLED) {
    for (const q of CONFIG.HIMALAYAS_QUERIES) {
      collected.push(...await fetchHimalayas(q, report));
      await sleep(150);
    }
  }

  report.push(`--- collected ${collected.length} raw postings ---`);

  // ---- 2. Balance via round-robin ------------------------------------------
  collected = interleaveBySource(collected);

  // ---- 3. Filter + dedup + analyze -----------------------------------------
  let analyzed = 0, passed = 0, dupes = 0, attempts = 0;
  const srcStats = {};
  const bump = (c, field) => {
    const k = (c || "?").toLowerCase();
    (srcStats[k] = srcStats[k] || { seen: 0, filtered: 0, analyzed: 0 })[field]++;
  };

  for (const job of collected) {
    if (analyzed >= CONFIG.MAX_ANALYZE_PER_RUN) {
      report.push(`hit MAX_ANALYZE_PER_RUN (${CONFIG.MAX_ANALYZE_PER_RUN} jobs analyzed) — remaining roll to next run`);
      break;
    }
    if (!job.url) continue;
    bump(job.company, "seen");

    if (job.thinText) {
      if (!thinTextWorthAnalyzing(job.title)) { bump(job.company, "filtered"); continue; }
    } else {
      if (!prefilterPass(job)) { bump(job.company, "filtered"); continue; }
    }
    passed++;

    const sk = seenKey(job.url);
    const fp = fingerprintKey(job);

    try {
      if (await kvGet(sk)) { dupes++; continue; }
      if (await kvGet(fp)) {
        dupes++;
        report.push(`dup (cross-source): ${job.title.slice(0, 40)}`);
        continue;
      }
    } catch (e) {
      report.push(`KV read error: ${e.message}`);
    }

    attempts++;

    // Just-in-time LinkedIn detail fetch (only for the jobs actually picked for analysis)
    if (job.isLinkedIn && job.id && job.description === job.title) {
      try {
        const detail = await fetchLinkedInDetail(job.id);
        if (detail.snippet) {
          job.description = detail.snippet;
          job.thinText = false;
        }
        if (detail.postedDate) job.postedDate = detail.postedDate;
      } catch {}
    }

    const ok = await analyzeAndSave(job, report);
    if (ok) {
      analyzed++;
      console.log(`[progress] Added job ${analyzed}/${CONFIG.MAX_ANALYZE_PER_RUN}: ${job.company} - ${job.title}`);
      bump(job.company, "analyzed");

      // CRITICAL FIX: Only write permanent dedup keys to KV on SUCCESSFUL analysis.
      // If the analyzer had a 500 error, network hiccup, or Gemini blip, the job
      // will NOT be burned and can retry next run.
      try {
        await kvPut(sk, String(Date.now()), CONFIG.SEEN_TTL_SECONDS);
        await kvPut(fp, String(Date.now()), CONFIG.SEEN_TTL_SECONDS);
      } catch (e) {
        report.push(`KV put error: ${e.message}`);
      }
    }

    // Polite delay between analyzer calls to prevent Gemini/Worker rate limit spikes
    await sleep(150);
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

  try {
    await kvPut("discovery:last_run", JSON.stringify(summary));
  } catch (e) {
    console.error("Failed to save summary:", e.message);
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
