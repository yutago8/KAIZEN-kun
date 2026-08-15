/**
 * Slack Events API endpoint for KAIZEN君.
 *
 * Two responsibilities:
 *   1. Relay (existing): forward thread replies / @mentions in #0-神喝 to the
 *      KAIZEN君 routine via its API trigger. The routine writes the actual reply.
 *   2. Image embed (new): when a photo is shared in the channel, download it from
 *      Slack, upload it to Notion, and append it to that day's 日次KAIZEN page.
 *      No Slack reply is posted — success is signalled with a ✅ reaction only,
 *      so it never double-posts against the KAIZEN君 Webhook.
 *
 * Env vars (all existing except SLACK_BOT_TOKEN / NOTION_API_KEY):
 *   SLACK_SIGNING_SECRET  - Slack app signing secret (request verification)
 *   ROUTINE_FIRE_URL      - https://api.anthropic.com/v1/claude_code/routines/<trig_id>/fire
 *   ROUTINE_TOKEN         - bearer token for the routine's API trigger
 *   SLACK_CHANNEL_ID      - channel to act on (default C04AATNK55G / #0-神喝)
 *   SLACK_BOT_TOKEN       - xoxb- token, scopes: files:read, reactions:write
 *   NOTION_API_KEY        - Notion integration token shared with 日次KAIZEN DB
 *   KAIZEN_DAILY_DATA_SOURCE_ID - optional override of the 日次KAIZEN data source
 *   SLACK_BOT_USER_ID     - optional; skips the auth.test lookup for mention detection
 */

export const config = { runtime: 'edge' };

const SLACK_API = 'https://slack.com/api';
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2025-09-03';

const DEFAULT_CHANNEL_ID = 'C04AATNK55G';
const DEFAULT_DAILY_DATA_SOURCE_ID = 'bb7d697a-d3a1-48a8-a5ee-7c9bb2b08595';
const DATE_PROPERTY = '日付';
/** Heading to file photos under, e.g. "### 今日の写真". Falls back to page end. */
const PHOTO_HEADING_RE = /写真|画像|photo/i;
const SUCCESS_REACTION = 'white_check_mark';
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // Notion single-part file upload limit

/**
 * Vercel injects env values verbatim; a stray full-width space or newline pasted
 * into the dashboard silently breaks HTTP headers, so strip anything non-ASCII.
 * (This bit us on 2026-08-11 with a corrupted routine token.)
 */
function env(name, fallback = '') {
  const raw = process.env[name];
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(/[^\x20-\x7E]/g, '').trim();
  return cleaned || fallback;
}

const log = (...args) => console.log('[slack-events]', ...args);
const logError = (...args) => console.error('[slack-events]', ...args);

/* ------------------------------------------------------------------ *
 * Slack request verification
 * ------------------------------------------------------------------ */

async function verifySlackSignature(rawBody, timestamp, signature, secret) {
  if (!timestamp || !signature) return false;
  // Reject replays older than 5 minutes.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`v0:${timestamp}:${rawBody}`));
  const expected =
    'v0=' +
    Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ *
 * Slack helpers
 * ------------------------------------------------------------------ */

async function slackApi(method, payload) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env('SLACK_BOT_TOKEN')}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`slack ${method} failed: ${json.error || res.status}`);
  return json;
}

let cachedBotUserId = null;
async function getBotUserId() {
  const configured = env('SLACK_BOT_USER_ID');
  if (configured) return configured;
  if (cachedBotUserId) return cachedBotUserId;
  if (!env('SLACK_BOT_TOKEN')) return null;
  try {
    const res = await fetch(`${SLACK_API}/auth.test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env('SLACK_BOT_TOKEN')}` },
    });
    const json = await res.json();
    if (json.ok) cachedBotUserId = json.user_id;
    return cachedBotUserId;
  } catch (err) {
    logError('auth.test failed:', err.message);
    return null;
  }
}

async function downloadSlackFile(file) {
  const url = file.url_private_download || file.url_private;
  if (!url) throw new Error('file has no url_private');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env('SLACK_BOT_TOKEN')}` } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  // An unauthorised download returns the Slack sign-in page with HTTP 200.
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    throw new Error('download returned HTML — SLACK_BOT_TOKEN is missing the files:read scope or cannot see this file');
  }
  return new Uint8Array(await res.arrayBuffer());
}

/* ------------------------------------------------------------------ *
 * Notion helpers
 * ------------------------------------------------------------------ */

async function notionApi(path, init = {}) {
  const headers = {
    Authorization: `Bearer ${env('NOTION_API_KEY')}`,
    'Notion-Version': NOTION_VERSION,
    ...(init.headers || {}),
  };
  // Let fetch set the multipart boundary itself when the body is FormData.
  if (init.body && !(init.body instanceof FormData)) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${NOTION_API}${path}`, { ...init, headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`notion ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** JST calendar date (YYYY-MM-DD) of a Slack message timestamp. */
function jstDateOf(slackTs) {
  const ms = Number(slackTs) * 1000 + 9 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

async function findDailyPage(date) {
  const dataSourceId = env('KAIZEN_DAILY_DATA_SOURCE_ID', DEFAULT_DAILY_DATA_SOURCE_ID);
  const result = await notionApi(`/data_sources/${dataSourceId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: DATE_PROPERTY, date: { equals: date } },
      page_size: 5,
    }),
  });
  const pages = result.results || [];
  if (pages.length > 1) log(`multiple 日次 pages for ${date}, using the oldest`);
  // Duplicates are resolved oldest-first, matching the 運用仕様書 rule.
  return pages.sort((a, b) => (a.created_time || '').localeCompare(b.created_time || ''))[0] || null;
}

const HEADING_LEVEL = { heading_1: 1, heading_2: 2, heading_3: 3 };

function blockPlainText(block) {
  const rich = block[block.type]?.rich_text;
  if (!Array.isArray(rich)) return '';
  return rich.map((t) => t.plain_text || '').join('');
}

/**
 * Locate where a photo should go: the end of the section under the first heading
 * matching PHOTO_HEADING_RE. Returns {parentId, afterId} — afterId null means
 * "append at the end of parentId".
 */
async function findPhotoAnchor(parentId, depth = 0) {
  if (depth > 2) return null;

  const blocks = [];
  let cursor;
  do {
    const query = new URLSearchParams({ page_size: '100' });
    if (cursor) query.set('start_cursor', cursor);
    const page = await notionApi(`/blocks/${parentId}/children?${query}`);
    blocks.push(...(page.results || []));
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);

  const headingIndex = blocks.findIndex(
    (b) => HEADING_LEVEL[b.type] && PHOTO_HEADING_RE.test(blockPlainText(b)),
  );

  if (headingIndex >= 0) {
    const level = HEADING_LEVEL[blocks[headingIndex].type];
    // Walk to the end of this section: stop at the next heading of equal or higher rank.
    let last = headingIndex;
    for (let i = headingIndex + 1; i < blocks.length; i++) {
      const nextLevel = HEADING_LEVEL[blocks[i].type];
      if (nextLevel && nextLevel <= level) break;
      last = i;
    }
    return { parentId, afterId: blocks[last].id };
  }

  // Not at this level — the heading may live inside a toggle or column.
  for (const block of blocks) {
    if (!block.has_children) continue;
    if (block.type === 'child_page' || block.type === 'child_database') continue;
    const nested = await findPhotoAnchor(block.id, depth + 1);
    if (nested) return nested;
  }
  return null;
}

async function uploadImageToNotion(bytes, filename, contentType) {
  const created = await notionApi('/file_uploads', {
    method: 'POST',
    body: JSON.stringify({ filename, content_type: contentType }),
  });

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), filename);

  const res = await fetch(created.upload_url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env('NOTION_API_KEY')}`,
      'Notion-Version': NOTION_VERSION,
    },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`notion file upload → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return created.id;
}

async function appendImageBlock(pageId, fileUploadId, caption) {
  const anchor = (await findPhotoAnchor(pageId)) || { parentId: pageId, afterId: null };
  const body = {
    children: [
      {
        object: 'block',
        type: 'image',
        image: {
          type: 'file_upload',
          file_upload: { id: fileUploadId },
          caption: caption ? [{ type: 'text', text: { content: caption.slice(0, 2000) } }] : [],
        },
      },
    ],
  };
  if (anchor.afterId) body.after = anchor.afterId;
  await notionApi(`/blocks/${anchor.parentId}/children`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return anchor;
}

/* ------------------------------------------------------------------ *
 * Image pipeline
 * ------------------------------------------------------------------ */

async function handleImages(event) {
  const images = (event.files || []).filter((f) => (f.mimetype || '').startsWith('image/'));
  if (images.length === 0) return;

  const missing = ['SLACK_BOT_TOKEN', 'NOTION_API_KEY'].filter((name) => !env(name));
  if (missing.length) {
    logError(`image skipped: missing env ${missing.join(', ')}`);
    return;
  }

  const date = jstDateOf(event.ts);
  const page = await findDailyPage(date);
  if (!page) {
    // Per spec: no page for that day → log and stop. Don't create one here;
    // the hourly routine owns 日次ページ creation.
    log(`no 日次KAIZEN page for ${date} (JST) — skipped ${images.length} image(s)`);
    return;
  }

  let embedded = 0;
  for (const file of images) {
    try {
      if (file.size && file.size > MAX_UPLOAD_BYTES) {
        logError(`${file.id} skipped: ${file.size} bytes exceeds the ${MAX_UPLOAD_BYTES} byte upload limit`);
        continue;
      }
      const bytes = await downloadSlackFile(file);
      const contentType = file.mimetype || 'image/jpeg';
      const filename = file.name || `slack-${file.id}.${contentType.split('/')[1] || 'jpg'}`;
      const uploadId = await uploadImageToNotion(bytes, filename, contentType);
      const caption = [file.title && file.title !== filename ? file.title : '', `Slack ${date}`]
        .filter(Boolean)
        .join(' · ');
      const anchor = await appendImageBlock(page.id, uploadId, caption);
      embedded++;
      log(
        `embedded ${filename} (${bytes.length} bytes) into 日次ページ ${page.id} for ${date}` +
          (anchor.afterId ? ' under the photo heading' : ' at page end'),
      );
    } catch (err) {
      logError(`failed to embed ${file.id} (${file.name || 'unnamed'}):`, err.message);
    }
  }

  if (embedded > 0) {
    // Reaction only — the KAIZEN君 Webhook owns replies, a message here would double-post.
    try {
      await slackApi('reactions.add', {
        channel: event.channel,
        timestamp: event.ts,
        name: SUCCESS_REACTION,
      });
    } catch (err) {
      if (!/already_reacted/.test(err.message)) logError('reactions.add failed:', err.message);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Routine relay
 * ------------------------------------------------------------------ */

async function fireRoutine(kind, event) {
  const url = env('ROUTINE_FIRE_URL');
  const token = env('ROUTINE_TOKEN');
  if (!url || !token) {
    logError('routine not fired: ROUTINE_FIRE_URL / ROUTINE_TOKEN not configured');
    return;
  }

  const payload = [
    'Slackスレッド返信イベント（リアルタイム応答モード）',
    `kind: ${kind}`,
    `channel: ${event.channel}`,
    `thread_ts: ${event.thread_ts || event.ts}`,
    `ts: ${event.ts}`,
    `user: ${event.user || ''}`,
    `text: ${event.text || ''}`,
  ].join('\n');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'experimental-cc-routine-2026-04-01',
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: payload }),
  });
  const body = await res.text();
  if (!res.ok) {
    logError(`routine fire failed: HTTP ${res.status}: ${body.slice(0, 300)}`);
    return;
  }
  let sessionUrl = '';
  try {
    sessionUrl = JSON.parse(body).claude_code_session_url || '';
  } catch {
    /* non-JSON success body — nothing to log */
  }
  log(`routine fired: ${sessionUrl}`);
}

/* ------------------------------------------------------------------ *
 * Handler
 * ------------------------------------------------------------------ */

const ok = (body = 'ok') => new Response(body, { status: 200, headers: { 'content-type': 'text/plain;charset=UTF-8' } });

export default async function handler(request, context) {
  if (request.method !== 'POST') {
    // Presence-only diagnostic; never returns any secret value.
    if (new URL(request.url).searchParams.get('diag') === '1') {
      const names = [
        'SLACK_SIGNING_SECRET',
        'ROUTINE_FIRE_URL',
        'ROUTINE_TOKEN',
        'SLACK_CHANNEL_ID',
        'SLACK_BOT_TOKEN',
        'NOTION_API_KEY',
      ];
      const configured = Object.fromEntries(names.map((n) => [n, Boolean(env(n))]));
      return new Response(JSON.stringify({ configured }, null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return ok();
  }

  const rawBody = await request.text();

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response('bad request', { status: 400 });
  }

  // Slack's Request URL check is sent unsigned.
  if (body.type === 'url_verification') {
    return new Response(body.challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
  }

  const signingSecret = env('SLACK_SIGNING_SECRET');
  if (!signingSecret) {
    logError('SLACK_SIGNING_SECRET is not configured — rejecting');
    return new Response('unauthorized', { status: 401 });
  }
  const valid = await verifySlackSignature(
    rawBody,
    request.headers.get('x-slack-request-timestamp'),
    request.headers.get('x-slack-signature'),
    signingSecret,
  );
  if (!valid) {
    logError('invalid Slack signature');
    return new Response('unauthorized', { status: 401 });
  }

  // Slack retries any delivery it thinks failed. Re-processing would fire the
  // routine twice and embed the same photo twice, so acknowledge and stop.
  if (request.headers.get('x-slack-retry-num')) {
    log(`ignoring Slack retry #${request.headers.get('x-slack-retry-num')} (${request.headers.get('x-slack-retry-reason')})`);
    return ok();
  }

  const event = body.event;
  if (!event || event.type !== 'message') return ok();

  const channelId = env('SLACK_CHANNEL_ID', DEFAULT_CHANNEL_ID);
  if (event.channel !== channelId) return ok();

  // Never react to our own posts (KAIZEN君 Webhook, other bots) or edits/deletes.
  if (event.bot_id || event.subtype === 'bot_message' || event.subtype === 'message_changed' || event.subtype === 'message_deleted') {
    return ok();
  }

  const hasImages = (event.files || []).some((f) => (f.mimetype || '').startsWith('image/'));
  const isThreadReply = Boolean(event.thread_ts);
  const botUserId = await getBotUserId();
  const isMention = !isThreadReply && Boolean(botUserId) && (event.text || '').includes(`<@${botUserId}>`);

  // The image pipeline outlives the Slack 3s ack window, so let it run after the
  // response. The relay stays inline — it is a single fast call.
  if (hasImages) {
    const work = handleImages(event).catch((err) => logError('image pipeline failed:', err.message));
    if (context && typeof context.waitUntil === 'function') context.waitUntil(work);
    else await work;
  }

  if (isThreadReply || isMention) {
    await fireRoutine(isThreadReply ? 'thread_reply' : 'mention', event).catch((err) =>
      logError('routine fire threw:', err.message),
    );
  }

  return ok();
}
