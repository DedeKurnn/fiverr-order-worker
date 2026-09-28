/**
 * Cloudflare Email Worker — Fiverr order -> Discord forum post.
 *
 * Setup:
 *   1. Domain must be on Cloudflare DNS with Email Routing enabled.
 *   2. Create a custom address (e.g. fiverr-orders@yourdomain.com) and
 *      route it to this Worker (Email Routing -> Routing Rules).
 *   3. In Proton, add a forwarding rule that sends Fiverr order emails to
 *      that address (Proton requires a one-time confirmation).
 *   4. wrangler secret put DISCORD_WEBHOOK_URL
 *      wrangler secret put DESIGNER_MENTION   (e.g. "<@123456789012345678>" for a user,
 *                                               or "<@&123456789012345678>" for a role —
 *                                               plain "@Klc" text will NOT ping anyone)
 *      wrangler secret put FORUM_TAG_IDS      (JSON string mapping category/package
 *                                               names to Discord forum tag IDs, e.g.
 *                                               {"Banner":"123...","Premium":"456..."})
 *   5. npm install postal-mime
 *   6. wrangler deploy
 *
 * Forum post title format: G-[order type code]-[order id] -- [customer name]
 * If Fiverr changes its email template, parseFiverrOrder() /
 * formatRequirements() are the only places that need updating.
 */

import PostalMime from "postal-mime";

const REQUIREMENTS_MARKER = "The buyer has provided the following order requirements:";
const DISCORD_CONTENT_LIMIT = 2000;

export default {
  async email(message, env, ctx) {
    let parsed;
    try {
      parsed = await PostalMime.parse(message.raw);
    } catch (err) {
      console.error("Failed to parse email:", err);
      return;
    }

    // Use the plain-text part only if it kept its line breaks; otherwise
    // rebuild text from the HTML so the block structure survives.
    const useText = Boolean(parsed.text && parsed.text.includes("\n"));
    const text = normalizeWhitespace(
      useText ? parsed.text : htmlToText(parsed.html || parsed.text || "")
    );
    const order = parseFiverrOrder(text);

    // DEBUG (remove once formatting is confirmed): shows the raw requirements
    // text with visible \n so parsing problems can be diagnosed via `wrangler tail`.
    console.log("SOURCE:", useText ? "text" : "html", "REQ_RAW:", JSON.stringify(order.requirementsBody));

    let tagIds = {};
    try {
      tagIds = env.FORUM_TAG_IDS ? JSON.parse(env.FORUM_TAG_IDS) : {};
    } catch (err) {
      console.error("FORUM_TAG_IDS is not valid JSON:", err);
    }

    try {
      await postToDiscord(order, env.DISCORD_WEBHOOK_URL, env.DESIGNER_MENTION, tagIds);
    } catch (err) {
      console.error("Failed to post to Discord:", err);
      // throw err; // uncomment to have Cloudflare retry delivery
    }

    // Optional: also land a copy in your normal inbox.
    // await message.forward("you@yourdomain.com");
  },
};

// HTML -> text that keeps block structure (line breaks) and decodes entities.
function htmlToText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/\s+/g, " ") // source-code whitespace is insignificant in HTML
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|td|th|h[1-6]|table|ul|ol|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function normalizeWhitespace(text) {
  return text
    .replace(/\u00A0/g, " ") // non-breaking space, common around bold/formatted text
    .replace(/[\u200B-\u200D\uFEFF]/g, ""); // zero-width characters
}

function matchOne(text, pattern) {
  const m = text.match(pattern);
  return m ? m[1].trim() : null;
}

const CATEGORY_MAP = [
  [/banner/i, "Banner"],
  [/profile picture|pfp/i, "Profile Picture"],
  [/wallpaper/i, "Wallpaper"],
  [/thumbnail/i, "Thumbnail"],
  [/render/i, "Render"],
  [/custom/i, "Custom"],
];

// Short codes used in the forum post title (G-[code]-[order id])
const CATEGORY_CODE = {
  "Banner": "BN",
  "Thumbnail": "TH",
  "Wallpaper": "WP",
  "Render": "TR",
  "Custom": "CT",
  "Profile Picture": "PP",
};

const PACKAGE_MAP = [
  [/diamond/i, "Premium"],
  [/gold/i, "Standard"],
  [/iron/i, "Basic"],
];

function detect(map, titleLine, fallback = "Unknown") {
  if (!titleLine) return fallback;
  for (const [re, label] of map) if (re.test(titleLine)) return label;
  return fallback;
}

function parseFiverrOrder(text) {
  const buyer =
    matchOne(text, /order from ([A-Za-z0-9_.\-]+)!/i) ||
    matchOne(text, /order from ([A-Za-z0-9_.\-]+)/i);
  const orderId = matchOne(text, /Order #(\S+)/i);
  const dueDateStr =
    matchOne(text, /due\s+(?:by\s+|on\s+)?([A-Za-z]+\s+\d{1,2},\s*\d{4})/i) ||
    matchOne(text, /([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})/);
  // Only the gig-title line, so words in the requirements can't affect detection
  const titleLine = matchOne(text, /I will ([^\n]+)/i);
  const priceStr = matchOne(text, /Total:\s*\$([0-9,.]+)/i);

  const reqIdx = text.indexOf(REQUIREMENTS_MARKER);
  let requirementsBody =
    reqIdx !== -1 ? text.slice(reqIdx + REQUIREMENTS_MARKER.length).trim() : null;

  // Drop Fiverr's trailing boilerplate ("Got everything you need? Review
  // Requirements <link> ...") entirely rather than keeping any of it.
  if (requirementsBody) {
    const boilerplateIdx = requirementsBody.search(/got everything you need\?/i);
    if (boilerplateIdx !== -1) {
      requirementsBody = requirementsBody.slice(0, boilerplateIdx).trim();
    } else {
      const reviewIdx = requirementsBody.search(/review requirements/i);
      if (reviewIdx !== -1) {
        requirementsBody = requirementsBody.slice(0, reviewIdx).trim();
      }
    }
  }

  const dueDate = dueDateStr ? new Date(dueDateStr) : null;
  const daysLeft =
    dueDate && !isNaN(dueDate)
      ? Math.ceil((dueDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      : null;

  return {
    buyer,
    orderId,
    dueDateStr,
    daysLeft,
    category: detect(CATEGORY_MAP, titleLine),
    packageTier: detect(PACKAGE_MAP, titleLine),
    price: priceStr,
    requirementsBody,
  };
}

function buildThreadName(order) {
  const code = CATEGORY_CODE[order.category] || "XX";
  const orderId = order.orderId || "UNKNOWN";
  const buyer = order.buyer || "unknown";
  return `G-${code}-${orderId} -- ${buyer}`.slice(0, 100);
}

// ---------------------------------------------------------------------------
// Requirements formatting
//
// Fiverr lists each requirement as a question followed by the buyer's answer.
// Long questions are cut at ~80 chars with an ellipsis, may carry a
// "For example : ..." hint, and may be hard-wrapped over several lines — so a
// question can span multiple lines. Numbering ("1.", "2.") may or may not be
// present. Strategy: group lines into question lines + answer lines.
// ---------------------------------------------------------------------------

const WRAP_LEN = 55; // a line this long without end punctuation probably wraps
const QUESTION_END_RE = /(\?|…|\.{3})\s*$/;
const TERMINATOR_RE = /[?…!.:]\s*$/;
const HINT_START_RE = /^(for example|e\.g\.?|eg:)/i;

function questionContinues(line, nextLine) {
  if (!nextLine) return false;
  if (HINT_START_RE.test(nextLine)) return true; // "For example : ..." hint line
  return line.length >= WRAP_LEN && !TERMINATOR_RE.test(line); // hard-wrapped question
}

function parseRequirementItems(raw) {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const items = [];
  let current = null;
  let inQuestion = false;
  let numbered = false;

  const startItem = () => {
    current = { question: [], answer: [] };
    items.push(current);
    inQuestion = true;
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Number marker: "1." alone, or "1. Question..." — only the next number in sequence
    const num = line.match(/^(\d+)\.\s*(.*)$/);
    if (num && Number(num[1]) === items.length + 1) {
      numbered = true;
      startItem();
      line = num[2];
      if (!line) continue;
    } else if (!current) {
      startItem();
    } else if (!inQuestion && !numbered && QUESTION_END_RE.test(line) && line.length <= 120) {
      startItem(); // unnumbered format: a new question line starts the next item
    }

    if (inQuestion) {
      current.question.push(line);
      if (!questionContinues(line, lines[i + 1])) inQuestion = false;
    } else {
      current.answer.push(line);
    }
  }
  return items;
}

// Re-join hard-wrapped answer lines with a space, keep intentional breaks.
function joinWrapped(lines) {
  let out = "";
  lines.forEach((line, i) => {
    if (i === 0) {
      out = line;
      return;
    }
    const prev = lines[i - 1];
    const wrapped = prev.length >= WRAP_LEN && !TERMINATOR_RE.test(prev);
    out += (wrapped ? " " : "\n") + line;
  });
  return out;
}

function formatRequirements(raw) {
  const items = parseRequirementItems(raw);
  if (items.length === 0) return raw.trim();

  return items
    .map((item, idx) => {
      const question = item.question.join(" ");
      let formatted = `**${idx + 1}. ${question}**`;
      if (item.answer.length > 0) {
        formatted +=
          "\n" +
          joinWrapped(item.answer)
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n");
      }
      return formatted;
    })
    .join("\n\n");
}

function buildDiscordContent(order, designerMention) {
  const parts = [];

  if (designerMention) parts.push(designerMention); // plain "@Klc" text won't ping — see setup notes

  parts.push(`# ${order.category} Order — ${order.packageTier}`);
  parts.push("");
  parts.push(`**Buyer:** ${order.buyer ?? "unknown"}`);

  const deadline = order.dueDateStr
    ? `**Deadline:** ${order.dueDateStr}` +
      (order.daysLeft != null
        ? ` _(${order.daysLeft} day${order.daysLeft === 1 ? "" : "s"} left)_`
        : "")
    : "**Deadline:** unknown";
  parts.push(deadline);

  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push("**Requirements**");
  parts.push("");

  if (order.requirementsBody) {
    parts.push(formatRequirements(order.requirementsBody));
  }

  let content = parts.join("\n");
  if (content.length > DISCORD_CONTENT_LIMIT) {
    content = content.slice(0, DISCORD_CONTENT_LIMIT - 20) + "\n...[truncated]";
  }
  return content;
}

function resolveAppliedTags(order, tagIds) {
  // Discord allows at most 5 applied_tags per forum post.
  return [tagIds[order.category], tagIds[order.packageTier]].filter(Boolean).slice(0, 5);
}

// Buyer-written text ends up in the message, so only the designer mention may
// ping — a buyer typing "@everyone" must not.
function buildAllowedMentions(mention) {
  const users = [];
  const roles = [];
  const u = mention && mention.trim().match(/^<@!?(\d+)>$/);
  const r = mention && mention.trim().match(/^<@&(\d+)>$/);
  if (u) users.push(u[1]);
  if (r) roles.push(r[1]);
  return { parse: [], users, roles };
}

async function postToDiscord(order, webhookUrl, mention, tagIds) {
  const payload = {
    content: buildDiscordContent(order, mention),
    // Only creates a forum post if the webhook's channel is a Forum channel.
    thread_name: buildThreadName(order),
    allowed_mentions: buildAllowedMentions(mention),
  };

  const appliedTags = resolveAppliedTags(order, tagIds);
  if (appliedTags.length > 0) {
    payload.applied_tags = appliedTags;
  }

  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    throw new Error(`Discord webhook failed: ${resp.status} ${await resp.text()}`);
  }
}
