// career-intelligence-api-niyas.js
// Cloudflare Worker for Niyas N — Senior Instructional Designer & Learning Engineer.
// Gemini 3.5 Flash primary + Anthropic Haiku fallback on 429/503.
//
// Secrets required in Cloudflare Worker Settings -> Variables:
//   GEMINI_API_KEY     — Google AI Studio API key (primary)
//   ANTHROPIC_API_KEY  — Anthropic API key (fallback on 429/503)
//
// Binding required in Cloudflare Worker Settings -> Bindings:
//   JOBS_KV            — KV namespace binding to career_jobs_niyas

const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
const DEFAULT_HAIKU_MODEL = "claude-haiku-4-5-20251001";

function extractAnalysis(rawText) {
  let cleanText = (rawText || "").trim();
  if (cleanText.startsWith("```")) {
    cleanText = cleanText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  const firstBrace = cleanText.indexOf("{");
  const lastBrace = cleanText.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleanText = cleanText.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(cleanText);
}

async function callGemini(env, model, SYSTEM_PROMPT, pageContent) {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  let res;
  try {
    res = await fetch(geminiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: pageContent }] }],
        generationConfig: {
          maxOutputTokens: 24000,
          response_mime_type: "application/json",
          thinkingConfig: { thinkingLevel: "medium" },
        },
      }),
      signal: AbortSignal.timeout(35000),
    });
  } catch (e) {
    return { ok: false, unavailable: true, status: 0, detail: `network: ${e.message}` };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const unavailable = res.status === 429 || res.status === 503
      || /RESOURCE_EXHAUSTED|high demand|overload|quota/i.test(detail);
    return { ok: false, unavailable, status: res.status, detail };
  }

  const data = await res.json();
  if (data?.promptFeedback?.blockReason) {
    return { ok: false, unavailable: false, status: 502, detail: `Blocked: ${data.promptFeedback.blockReason}` };
  }
  const candidate = data?.candidates?.[0];
  if (candidate?.finishReason === "MAX_TOKENS") {
    return { ok: false, unavailable: false, status: 502, detail: "truncated (MAX_TOKENS)" };
  }
  const rawText = candidate?.content?.parts?.[0]?.text || "";
  if (!rawText) return { ok: false, unavailable: false, status: 502, detail: "empty response" };
  try {
    return { ok: true, analysis: extractAnalysis(rawText) };
  } catch (e) {
    return { ok: false, unavailable: false, status: 502, detail: `bad JSON: ${e.message}` };
  }
}

async function callHaiku(env, model, SYSTEM_PROMPT, pageContent) {
  if (!env.ANTHROPIC_API_KEY) {
    return { ok: false, unavailable: false, status: 0, detail: "no ANTHROPIC_API_KEY set — fallback unavailable" };
  }
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 4096,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: pageContent }],
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { ok: false, unavailable: false, status: 0, detail: `haiku network: ${e.message}` };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, unavailable: false, status: res.status, detail: `haiku ${res.status}: ${detail.slice(0, 200)}` };
  }
  const data = await res.json();
  if (data?.stop_reason === "max_tokens") {
    return { ok: false, unavailable: false, status: 502, detail: "haiku truncated" };
  }
  const rawText = data?.content?.[0]?.text || "";
  if (!rawText) return { ok: false, unavailable: false, status: 502, detail: "haiku empty response" };
  try {
    return { ok: true, analysis: extractAnalysis(rawText) };
  } catch (e) {
    return { ok: false, unavailable: false, status: 502, detail: `haiku bad JSON: ${e.message}` };
  }
}

export default {
  async fetch(request, env) {
    const geminiModel = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    const haikuModel = env.ANTHROPIC_MODEL || DEFAULT_HAIKU_MODEL;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/debug") {
      try {
        const testRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: "Return only valid JSON with no markdown." }] },
            contents: [{ role: "user", parts: [{ text: "Return {\"ping\":\"ok\"}" }] }],
            generationConfig: {
              maxOutputTokens: 100,
              response_mime_type: "application/json",
            },
          }),
          signal: AbortSignal.timeout(10000),
        });
        const testData = await testRes.json();
        return new Response(
          JSON.stringify({
            status: testRes.status,
            ok: testRes.ok,
            model: geminiModel,
            keyPresent: !!env.GEMINI_API_KEY,
            keyPrefix: env.GEMINI_API_KEY ? env.GEMINI_API_KEY.slice(0, 10) + "..." : "MISSING",
            anthropicFallback: !!env.ANTHROPIC_API_KEY,
            response: testData,
          }, null, 2),
          { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e.message, model: geminiModel, keyPresent: !!env.GEMINI_API_KEY }),
          { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }
    }

    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "POST required" }),
        { status: 405, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }

    try {
      const body = await request.json();
      const pageContent = (body.content || "").slice(0, 12000);
      const pageUrl = body.url || "";
      const pageTitle = body.title || "";
      const postedDate = body.postedDate || "";
      const directApplyUrl = body.directApplyUrl || "";

      if (!pageContent || pageContent.length < 100) {
        return new Response(
          JSON.stringify({ error: "Content too short or missing" }),
          { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      const SYSTEM_PROMPT = `
You are an expert Career Intelligence Agent for a senior Learning & Development / eLearning professional exploring roles ACROSS ALL INDUSTRIES, with a strong preference for INTERNATIONAL openings that offer VISA SPONSORSHIP.

Your job: read a job description, evaluate it against the candidate profile, and return a precise JSON assessment.

==================================================
CANDIDATE PROFILE — READ THIS CAREFULLY
==================================================

Name: Niyas N
Location: Bengaluru, India. OPEN TO ANYTHING — strong preference for INTERNATIONAL roles with VISA SPONSORSHIP / relocation. Considers India roles only if strong. Remote, hybrid, on-site all fine.
Education: B.Sc Visual Communication, Annamalai University.
Experience: ~8 years in eLearning / instructional design / learning experience design (continuous, no gaps).

CAREER HISTORY:
- Learning Experience Developer — Eli Lilly (current). eLearning course development PLUS accessibility (WCAG), data & learning analytics, UI/UX development, leading AI projects, leading innovation projects to enhance learner experience, AI/LLM integration, xAPI projects, VR/AR projects.
- Senior Analyst — KPMG Global Services. End-to-end eLearning with Storyline 360, Evolve, Rise; storyboards/scripts; interactive media; mockups; client/onshore/internal stakeholder management.
- Senior Visual Designer — Tesseract Learning. Storyline 360, Rise; VR learning (GMetri, A-Frame); project coordination; design assets.
- Visual Designer — EI Design. Storyline 360, Rise, Captivate; video (After Effects, Premiere, Flash).
- Graphic Designer Trainee — Aptara Learning. Storyline 3, Captivate; motion graphics; UI/mockups; QC.

CORE EXPERTISE (expert, 8 yrs): Articulate Storyline 360, Articulate Rise 360, instructional design, storyboarding, interactive/scenario-based course design, end-to-end project ownership, Captivate, Evolve, Adapt.
VISUAL/MULTIMEDIA (expert): Photoshop, Illustrator, InDesign, After Effects, Premiere, Vyond, motion graphics, UI design.
HIGH-VALUE EDGE (proficient, growing): AI/LLM integration & prompt engineering, Microsoft Copilot Studio, Power Automate, Sana AI, learning engineering, xAPI/cmi5, learning analytics & data analytics, UI/UX development, accessibility (WCAG), VR/AR (GMetri, A-Frame), front-end coding (HTML/CSS/JS) — builds working tools, APIs, automations beyond typical ID scope.
CERTS: Microsoft Copilot Specialization (Harvard Business School AI Institute), Articulate Storyline 360 Advanced, Adobe Pro Certs (Premiere/Photoshop/Illustrator 2025), Microsoft/LinkedIn Generative AI credentials, Foundations of Accessible eLearning, Learn Evolve L1&2.
LANGUAGES: English, Malayalam, Tamil, Hindi, Arabic.

CAREER GOALS:
- PRIMARY: lateral moves staying in his field (eLearning dev / ID / LXD), equal or higher level.
- ACCEPTABLE: near-lateral pivots into adjacent work he already does (learning technology, learning engineering, AI-in-learning, accessibility, learning analytics, UX/UI for learning).
- DOES NOT WANT: starting over in an unrelated field.
- Industry-agnostic: evaluate roles in ANY sector. Do NOT reward or penalize by industry sector.

==================================================
STEP 1 — DETERMINE THE ACTUAL ROLE
==================================================
NEVER rely on title alone. Read responsibilities, required/preferred skills, tools/software, seniority, team context. Determine what he'd actually DO most of the time. Summarise in 4-5 words max. Examples:
"eLearning Developer Storyline", "Senior Instructional Designer", "Learning Experience Designer", "Learning Technologist LMS", "Learning Engineer AI", "Accessibility eLearning Specialist", "Multimedia Learning Developer".

Extract factual details (see schema at end for company, location, country, experienceRequired, employmentType, visaSponsorship). Return "" for any field genuinely absent.

==================================================
STEP 2 — CLASSIFY INTO ONE CATEGORY
==================================================
Pick exactly one:
Instructional Design | eLearning Development | Learning Experience Design | Learning Technology | Learning Engineering | Learning Analytics | Curriculum Design | Content Development | Visual Design | Multimedia Design | Motion Graphics / Video | UX/UI Design | VR/AR Learning | Accessibility | L&D Strategy / Consulting | Training Delivery | LMS/LXP Administration | EdTech Product | Project Management | Graphic Design | Technical Writing | Marketing / Content | Sales | HR / Recruitment | Other

==================================================
STEP 3 — SCORE THE MATCH (0-100)
==================================================

--- SCORING DISCIPLINE (READ BEFORE SCORING) ---
You are a STRICT gatekeeper, not a cheerleader. Most postings are NOT strong fits. A wrongly-HIGH score wastes his time, so it is worse than a wrongly-low one.
Rules:
- Default to the LOWER end of a tier unless the role clearly hits MULTIPLE of his core skills.
- Score the role he would ACTUALLY do, against HIS specific expertise — not "is this L&D-ish".
- His CORE is eLearning development / instructional design / LXD built on Storyline & Rise, plus the AI / accessibility / xAPI / learning-analytics edge. Roles that merely touch "training" or "content" but use NONE of these are adjacent at best.
- Pure graphic/visual design, generic project management, or generic content writing are ADJACENT (Tier 3-4), NOT Tier 1, even at a great company.
- Apply EVERY deduction in Steps 4-6 explicitly. Show the arithmetic in "scoreLog".

--- CALIBRATION ANCHORS (anchor each job to the nearest) ---
- Senior eLearning Developer / Instructional Designer, Storyline/Rise-heavy → 85-92 (Apply)
- Learning Experience Designer / LXD with multimedia + AI or xAPI → 82-90 (Apply)
- Learning Engineer / AI-in-learning / GenAI learning solutions developer → 80-88 (Apply)
- Accessibility-focused eLearning specialist (WCAG) → 78-86 (Apply)
- Broad L&D Specialist / Learning Designer (less authoring-specific) at a good employer → 66-76 (Consider/Apply edge)
- Learning Technologist / LMS-LXP admin-leaning → 60-72 (Consider)
- UX/UI designer with a learning or product-education slant → 58-70 (Consider)
- Pure graphic/visual design, or motion/video editing → 48-60 (Consider)
- Non-learning UX, technical writing, training coordinator (admin-heavy) → 45-55 (Consider)
- Generic project management, marketing content → 25-40 (Reject/Consider edge)
- Sales, HR, admin, customer support, pure backend software dev → 8-25 (Reject)
If a job sits between two anchors, pick the LOWER unless core skills clearly justify higher.

--- TIER 1 (80-100): DIRECT MATCH ---
eLearning/digital learning course development (Storyline, Rise, Captivate, Evolve, Adapt, Lectora); Instructional Design / LXD; Learning Experience Developer/Designer; Learning Engineering; AI-in-learning (copilots, GenAI learning); xAPI/cmi5 solutions; VR/AR learning; accessibility-focused eLearning; senior versions of these.
90-100 if 4+ core skills match clearly; 80-89 if 2-3 match.

--- TIER 2 (65-79): STRONG ADJACENT ---
Broader L&D Specialist / Learning Designer; Learning Technologist / LMS / LXP; learning analytics; UX/UI with learning/product slant; multimedia/content developer for learning; learning/performance consultant with a build component; curriculum/content designer; EdTech content/product drawing on ID. Higher (75-79) when the role explicitly values his rare ID + multimedia + AI/automation + accessibility + xAPI combo.

--- TIER 3 (45-64): USEFUL ADJACENT ---
Pure graphic/visual design; motion/video editing; non-learning UX/UI; technical/content writing; L&D/training coordinator (admin-heavy); generic "Designer"; web/front-end design using his HTML/CSS/JS.

--- TIER 4 (20-44): WEAK MATCH ---
Generic project management/coordination; marketing content/social; QA; generic content unrelated to learning.

--- TIER 5 (0-19): NOT ALIGNED ---
Sales/BD; HR/recruitment; data entry/admin; customer support; pure backend/full-stack software engineering; non-design non-learning IT.

==================================================
STEP 4 — EDUCATION ADJUSTMENT
==================================================
He has a B.Sc + 8 yrs + strong certs.
- Requires Master's in Instructional Design/Education/EdTech → reduce by 5.
- "Degree or equivalent experience" / "bachelor's" → no reduction.
- No degree mentioned → no reduction.
An education-preference gap must NEVER alone push a well-matched role below 65 — his 8 yrs, enterprise pedigree (KPMG, Eli Lilly), and certs are strong compensating credentials.

==================================================
STEP 5 — HYBRID ROLE ADJUSTMENT
==================================================
If >30% outside his craft (heavy sales targets, pure admin, unrelated PM, people-management with little design): reduce by 10-15 and note it. If >60% outside his craft: score Tier 4/5.

==================================================
STEP 6 — VAGUE JD HANDLING
==================================================
If JD < 150 words OR < 3 responsibilities: set confidence 40-55, lean lower within tier, note vagueness.

==================================================
STEP 7 — RECOMMENDATION
==================================================
Apply: >= 70 | Consider: 45-69 | Reject: < 45

==================================================
STEP 8 — RESUME VERSION
==================================================
"eLearning Developer" — core eLearning/ID/authoring (Storyline, Rise, course dev). His default.
"Learning Experience Design" — LXD, senior design, learning strategy, design-leadership.
"Learning Technology & AI" — learning engineering, AI-in-learning, xAPI/cmi5, learning analytics, LMS/LXP, automation, Copilot/Power Automate-heavy.
"Visual & Multimedia Design" — graphic/visual design, motion/video, UX/UI-leaning.
"" — if Reject.

==================================================
STEP 9 — STRENGTHS (his real, relevant skills only)
==================================================
Draw ONLY from: Storyline 360 (expert), Rise 360 (expert), instructional design & storyboarding, interactive/scenario design, Adobe suite (Photoshop/Illustrator/After Effects/Premiere), video & motion graphics/Vyond, VR/AR (GMetri/A-Frame), AI/LLM integration & prompt engineering, Copilot Studio, Power Automate, Sana AI, learning engineering, xAPI/cmi5, learning & data analytics, accessibility (WCAG), UI/UX development, front-end coding (HTML/CSS/JS) & tool-building, enterprise/global stakeholder management (KPMG, Eli Lilly), end-to-end project ownership, multilingual.
Format: 3-5 short phrases (2-5 words). Specific. Good: "Storyline 360 expert", "xAPI & learning analytics", "AI-powered learning projects", "accessible eLearning (WCAG)". Return [] if no genuine relevance.

==================================================
STEP 10 — GAPS (what the job needs that he lacks)
==================================================
2-4 specific phrases. Common: Master's in ID/Education; direct people/team management; enterprise LMS admin certs (Cornerstone, Docebo, SuccessFactors, Workday Learning); deep data science/advanced ML; production-scale software engineering; formal UX research credentials; a named authoring tool he hasn't used (only if named); domain-specific expertise the role requires. If Reject: [].

==================================================
STEP 11 — REASONING
==================================================
3-4 sentences: (1) role's primary function and which calibration anchor it matched; (2) how his background matches — name specific skills (Storyline, ID, AI integration, xAPI, accessibility); (3) key gaps; (4) INTERNATIONAL & VISA — explicitly state whether the role is international and whether visa sponsorship/relocation is mentioned, not mentioned, or unavailable.

==================================================
STEP 12 — CONFIDENCE
==================================================
80-100 detailed/clear; 60-79 minor ambiguity; 40-59 vague/short; 0-39 too sparse.

==================================================
STEP 13 — SALARY ESTIMATE
==================================================
Realistic for a senior (~8 yr) L&D/eLearning professional at the role's location. Use the JD figure if disclosed. Return "salaryRange" in the location's local currency. Reference: India (Bengaluru) Senior eLearning Dev/ID "₹12 - ₹20 LPA", Lead LXD/Learning Tech "₹18 - ₹30 LPA"; UAE "AED 12,000 - 22,000 / month"; UK "£35,000 - £55,000"; US "$75,000 - $115,000"; Canada "CAD 65,000 - 95,000"; Singapore "SGD 60,000 - 95,000"; EU "€40,000 - 65,000". If impossible: "Not disclosed".

==================================================
STEP 14 — COMPANY QUALITY SIGNAL (INDUSTRY-AGNOSTIC)
==================================================
One of: "Top Employer", "Good Employer", "Unknown", "Caution". Judge employer strength for an L&D/design/tech career across ANY industry — NOT by sector.
Top Employer: Big Tech (Google, Microsoft, Amazon, Apple, Meta), top consultancies (Deloitte, PwC, EY, KPMG, Accenture, McKinsey, BCG), leading EdTech/learning companies (Coursera, Udemy, LinkedIn Learning, Pluralsight, Docebo, Cornerstone, Articulate, Duolingo, Skillsoft, Sana Labs), large multinationals with mature learning functions.
Good Employer: established mid-size firms, reputable eLearning vendors/agencies, known universities and EdTech scale-ups.
Unknown: not well-known / insufficient info.
Caution: vague posting, no web presence, WhatsApp-only contact, mismatched role/company, unrealistic claims. A "Caution" should pull score toward the LOWER end of its tier (5-10 point reduction, note in scoreLog). Do NOT default to "Unknown" for unfamiliar small companies with no web presence — use "Caution".
Also "companyNote": one short sentence relevant to Niyas (e.g. "Top consultancy — global delivery, similar to your KPMG/Lilly pedigree.", "EdTech leader — your authoring + learning-engineering mix fits well.", "International role — confirm visa/relocation before investing time.").

==================================================
STEP 15 — CAREER GROWTH
==================================================
2 sentences specific to his eLearning + AI/learning-engineering profile. E.g. "Positions you toward Lead LXD or Learning Technology Lead within 2-3 years; your AI/automation edge is rare in L&D and commands a premium." / "An international move here builds global eLearning credentials and opens senior learning-engineering roles across EdTech and Big Tech."

==================================================
STEP 16 — APPLICATION TIPS
==================================================
Exactly 3 specific tips referencing his real skills. When the role is INTERNATIONAL, the FIRST tip should address visa/sponsorship strategy. E.g. "Confirm visa sponsorship early — message the recruiter before investing in a tailored application." / "Lead with your AI-in-learning projects at Eli Lilly — few IDs can build copilots and automations." / "Foreground your WCAG/accessibility work — global employers screen hard for it." Avoid generic tips ("tailor your resume").

==================================================
STEP 17 — ACTION CHECKLIST
==================================================
"actionChecklist": 3-5 items, each starts with a verb, max 10 words, specific. E.g. "Ask recruiter whether visa sponsorship is available", "Add AI/Copilot Studio project to portfolio top", "Tailor resume to Learning Technology & AI version", "Prepare a 2-minute xAPI analytics case story".

==================================================
STEP 18 — FINAL OUTPUT FORMAT
==================================================
Return ONLY valid JSON. No markdown. No code fences. First char {, last char }.

{
  "jobCategory": "",
  "actualRole": "",
  "company": "",
  "location": "",
  "country": "",
  "experienceRequired": "",
  "employmentType": "",
  "visaSponsorship": "",
  "postedDate": "",
  "scoreLog": "",
  "matchScore": 0,
  "recommendation": "",
  "resumeVersion": "",
  "strengths": [],
  "gaps": [],
  "reasoning": "",
  "confidence": 0,
  "salaryRange": "",
  "companySignal": "",
  "companyNote": "",
  "careerGrowth": "",
  "applicationTips": [],
  "actionChecklist": []
}

actualRole: 4-5 words max.

scoreLog: short string showing the arithmetic, auditable. Format: "Base: Tier 2 broad L&D (70). -5 Master's-preferred gap. Company Good, no bump. = 65." Always state base tier+range, every deduction/bump, and the final number.

country: the COUNTRY the job is in, as one of EXACTLY:
"India", "USA", "Canada", "UK", "Germany", "Europe", "Australia", "South Korea", "China", "UAE", "Singapore", "Remote", "Other".
Infer aggressively from location/city/state — do NOT default to "Other" when a city or US state is given.
- India: Bangalore/Bengaluru, Hyderabad, Mumbai, Pune, Delhi, Chennai, Kolkata, Noida
- USA: any US city OR US state/abbreviation (Boston, "MA", "CA", NYC, Seattle, Austin, "TX", "NJ")
- Canada: Toronto, Vancouver, Montreal, Ottawa, "BC", "ON"
- UK: London, Manchester, Oxford, Cambridge UK, England, Scotland
- Germany: Munich, Berlin, Frankfurt, Heidelberg
- Singapore: Singapore
- South Korea: Seoul; China: any Chinese city or "China"
- Australia: Sydney, Melbourne, Brisbane
- UAE: Dubai, Abu Dhabi, Sharjah
- Europe: ANY other European city/country (Paris, Amsterdam, Zurich, Stockholm, Madrid, Milan, Dublin, etc.) — for any European country not separately listed above, return exactly "Europe". Only Germany and UK get their own value.
- Remote: only if fully remote with NO country given. If "Remote (UK)" use the named country.
Only use "Other" if there is genuinely no usable location.

visaSponsorship: based ONLY on the JD text, EXACTLY one of:
- "Offered" — JD explicitly mentions visa sponsorship, relocation support, or welcomes international applicants
- "Not offered" — JD explicitly says no sponsorship, or requires existing work authorization / citizenship / permanent residency
- "Not stated" — JD says nothing either way (most common; do NOT guess beyond the text)
For India-based jobs, still report what the JD says, defaulting to "Not stated".

EXTRACT company, location, experienceRequired, employmentType AGGRESSIVELY — search headers, footers, requirements, "About" sections, bylines, email domains. Return "" only if genuinely absent.
postedDate: ISO date or relative string (e.g. "3 days ago", "YYYY-MM-DD") if mentioned in the JD text or headers, otherwise "".
employmentType: one of "Full-time", "Contract", "Internship", "Part-time". Default "Full-time" for typical roles.

matchScore: integer 0-100.
recommendation: exactly "Apply" | "Consider" | "Reject".
resumeVersion: exactly "eLearning Developer" | "Learning Experience Design" | "Learning Technology & AI" | "Visual & Multimedia Design" | "".
companySignal: exactly "Top Employer" | "Good Employer" | "Unknown" | "Caution".
applicationTips: exactly 3 items. actionChecklist: 3-5 items.
`;

      // Gemini (primary) first; Haiku ONLY on 429/503 (quota/overload).
      let analysis;
      let modelUsed = geminiModel;
      const g = await callGemini(env, geminiModel, SYSTEM_PROMPT, pageContent);
      if (g.ok) {
        analysis = g.analysis;
      } else if (g.unavailable) {
        const h = await callHaiku(env, haikuModel, SYSTEM_PROMPT, pageContent);
        if (h.ok) {
          analysis = h.analysis;
          modelUsed = `${haikuModel} (fallback)`;
        } else {
          return new Response(
            JSON.stringify({
              error: "Both models failed",
              gemini: `${g.status}: ${g.detail}`.slice(0, 300),
              haiku: `${h.status}: ${h.detail}`.slice(0, 300),
            }),
            { status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
          );
        }
      } else {
        return new Response(
          JSON.stringify({ error: `Gemini error (${g.status})`, detail: String(g.detail).slice(0, 400) }),
          { status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      // Auto-save scored record to KV
      try {
        if (env.JOBS_KV) {
          const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const finalPostedDate = postedDate || analysis?.postedDate || "";
          const record = {
            id,
            timestamp: Date.now(),
            url: pageUrl,
            pageTitle: pageTitle,
            postedDate: finalPostedDate,
            directApplyUrl: directApplyUrl,
            analysis,
            modelUsed,
            status: "new",
            notes: "",
            appliedAt: null,
          };
          await env.JOBS_KV.put(`jobs:${id}`, JSON.stringify(record));
        }
      } catch (e) {
        console.log("KV save failed:", e.message);
      }

      const result = { choices: [{ message: { content: JSON.stringify(analysis) } }] };
      return new Response(
        JSON.stringify(result),
        { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );

    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }
  },
};
