/**
 * Cloudflare Email Worker — Fiverr order -> Discord thread.
 *
 * Setup:
 *   1. Domain must be on Cloudflare DNS with Email Routing enabled.
 *   2. Create a custom address (e.g. fiverr-orders@yourdomain.com) and
 *      route it to this Worker (Email Routing -> Routing Rules).
 *   3. In Proton, add a filter that forwards Fiverr order emails to that
 *      address (Proton will require you to verify it once).
 *   4. wrangler secret put DISCORD_WEBHOOK_URL
 *      wrangler secret put DESIGNER_MENTION   (e.g. "<@123456789012345678>" for a user,
 *                                               or "<@&123456789012345678>" for a role —
 *                                               plain "@Klc" text will NOT ping anyone)
 *      wrangler secret put FORUM_TAG_IDS      (JSON string mapping category/package
 *                                               names to Discord forum tag IDs, e.g.
 *                                               {"Banner":"123...","Premium":"456..."})
 *
 *      Forum tags don't have a UI "copy ID" option. To find the IDs:
 *        - Create a temporary bot, invite it to the server (View Channels perm is enough)
 *        - curl -H "Authorization: Bot YOUR_BOT_TOKEN" \
 *               https://discord.com/api/v10/channels/YOUR_FORUM_CHANNEL_ID
 *        - Read the "available_tags" array in the response: each has "id" and "name"
 *
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

    const text = parsed.text || stripHtml(parsed.html || "");
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

function matchOne(text, pattern) {
  const m = text.match(pattern);
  return m ? m[1].trim() : null;
}

const CATEGORY_MAP = [
  [/banner/i, "Banner"],
  [/profile picture|pfp/i, "Profile Picture"],
  [/wallpaper/i, "Wallpaper"],
	[/thumbnail/i, "Thumbnail"],
  [/render/i, "Render"]
];

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
  const buyer = matchOne(text, /order from ([^!]+)!/i);
  const orderId = matchOne(text, /Order #(\S+)/i);
  const dueDateStr = matchOne(text, /due ([A-Za-z]+ \d{1,2},\s*\d{4})/i);
  const titleLine = matchOne(text, /I will (.+)/i);
  const priceStr = matchOne(text, /Total:\s*\$([0-9,.]+)/i);

  const reqIdx = text.indexOf(REQUIREMENTS_MARKER);
  const requirementsBody =
    reqIdx !== -1 ? text.slice(reqIdx + REQUIREMENTS_MARKER.length).trim() : null;

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
  const name = `${order.category} - ${order.packageTier}${order.buyer ? ` (${order.buyer})` : ""}`;
  return name.slice(0, 100);
}

function buildDiscordContent(order, designerMention) {
  const parts = [];
  parts.push(designerMention || "@Klc"); // plain "@Klc" text won't actually ping — see setup notes
  parts.push("");
  parts.push(`Order ${order.category} - ${order.packageTier}`);
  parts.push("");

  if (order.requirementsBody) {
    parts.push(order.requirementsBody);
    parts.push("");
  }

  const deadline = order.dueDateStr
    ? `Deadline: ${order.dueDateStr}` +
      (order.daysLeft != null ? ` (${order.daysLeft} day${order.daysLeft === 1 ? "" : "s"} left)` : "")
    : "Deadline: unknown";
  parts.push(deadline);

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
