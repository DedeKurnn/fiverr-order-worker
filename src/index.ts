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
 * Parsing is built against this real Fiverr order-notification format:
 *
 *   Hi <seller>,
 *   You've just received an order from <buyer>! Feels good, right?
 *   Order #<id> is due <Month DD, YYYY>.
 *   ...
 *   I will <title with "- X Package">:
 *   ...
 *   Total: $<amount>
 *   The buyer has provided the following order requirements:
 *   <full Q&A block>
 *
 * Forum post title format: G-[order type code]-[order id] -- [customer name]
 * If Fiverr changes this template, only parseFiverrOrder() needs updating.
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

    const text = normalizeWhitespace(parsed.text || stripHtml(parsed.html || ""));
    const order = parseFiverrOrder(text);

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

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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
  const titleLine = matchOne(text, /I will (.+)/i);
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

// Turns Fiverr's numbered Q&A block into bolded questions with
// block-quoted answers, e.g.:
//   **1. What do you want...?**
//   > My rough idea is...
function formatRequirements(raw) {
  const itemRegex = /(?:^|\s)(\d+)\.\s+/g;
  const matches = [...raw.matchAll(itemRegex)];
  if (matches.length === 0) return raw.trim();

  const items = matches.map((m, i) => {
    const contentStart = m.index + m[0].length;
    const contentEnd = i + 1 < matches.length ? matches[i + 1].index : raw.length;
    return { number: m[1], body: raw.slice(contentStart, contentEnd).trim() };
  });

  return items
    .map(({ number, body }) => {
      // Most items are phrased as a question; split on the '?' so only the
      // question itself gets bolded and the rest is quoted as the answer.
      // Items with no '?' (e.g. the file-upload one) bold the whole line.
      const qMarkIdx = body.indexOf("?");
      let question, answer;
      if (qMarkIdx !== -1) {
        question = body.slice(0, qMarkIdx + 1).trim();
        answer = body.slice(qMarkIdx + 1).trim();
      } else {
        question = body;
        answer = "";
      }

      let formatted = `**${number}. ${question}**`;
      if (answer) {
        formatted += `\n> ${answer.replace(/\s*\n+\s*/g, " ").trim()}`;
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

async function postToDiscord(order, webhookUrl, mention, tagIds) {
  const payload = {
    content: buildDiscordContent(order, mention),
    // Only creates a forum post if the webhook's channel is a Forum channel.
    thread_name: buildThreadName(order),
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
