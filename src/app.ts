import "dotenv/config";
import { Input, Markup, Telegraf } from "telegraf";
import { EAuthSessionGuardType, EAuthTokenPlatformType, LoginSession } from "steam-session";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ADMIN_IDS,
  BOT_TOKEN,
} from "./core/config";
import { adminKb, mainKbForRole } from "./core/ui";
import { createFileStoreDatabase } from "./core/fileStore";
import type { Role } from "./core/types";
import { formatOnlineWatchOfflineText, formatOnlineWatchOnlineText } from "./features/online/text";
import { escapeHtml, nowIso } from "./utils/text";

type Ctx = any;
type StatsRangeKey = "today" | "week" | "month" | "all";
type ProfileDrawMode = "add_friend" | "acc_blocked" | "steam_guard_error";
type UserFlow =
  | { mode: "online_watch_profile_input" }
  | { mode: "online_watch_comment_input"; payload: { profileUrl: string } }
  | { mode: "rent_add_title" }
  | { mode: "rent_add_description"; payload: { title: string } }
  | { mode: "rent_add_credentials"; payload: { title: string; description: string } }
  | { mode: "rent_add_mafile"; payload: { title: string; description: string; login: string; password: string } }
  | { mode: "rent_edit_input"; payload: { number: number; field: "title" | "description" } }
  | { mode: "rent_set_responsible" }
  | { mode: "rent_discord_handoff"; payload: { rentalNumber: number } }
  | { mode: "rent_report_upload"; payload: { reportId: number } }
  | { mode: "rent_report_reject_comment"; payload: { reportId: number; requestRepeat: boolean } }
  | { mode: "settings_phishing_link" }
  | { mode: "admin_logs_search" }
  | { mode: "admin_find_user"; payload: { returnPage: number } }
  | { mode: "admin_broadcast_input" }
  | { mode: "admin_steam_proxy_input" }
  | { mode: "draw_input:add_friend"; payload: { variant: "link" | "id"; promptMessageId: number | null } }
  | { mode: "draw_input:acc_blocked"; payload: { variant: "link" | "id"; promptMessageId: number | null } }
  | { mode: "draw_input:steam_guard_error"; payload: { variant: "link" | "id"; promptMessageId: number | null } }
  | { mode: "draw_input:code_dota2_mammoth_code"; payload: { promptMessageId: number | null } }
  | { mode: "draw_input:qr_page_time"; payload: { inviteLink: string; promptMessageId: number | null } }
  | { mode: "draw_input:friend_page_normal_link"; payload: { promptMessageId: number | null } }
  | { mode: "draw_input:friend_page_code"; payload: { inviteLink: string; showRegionMismatch: boolean; promptMessageId: number | null } };

type RuntimeWatch = {
  onlineSince: number;
  messageChatId: number;
  messageId: number;
  profileUrl: string;
  comment: string | null;
  lastStatusCheckAt: number;
};

type InvitePageData = {
  name: string;
  avatarFull: string;
  avatarMedium: string | null;
  avatarFrame: string | null;
  miniprofile: string;
  profileUrl: string | null;
};

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN missing");
}

const bot = new Telegraf(BOT_TOKEN);
const db = createFileStoreDatabase(process.env.STORE_PATH || "./data/bot-store.json") as any;
const store = db.store;
const DRAW_IMAGE_PATH = path.join(process.cwd(), "src", "assets", "cctg.png");
const DRAW_ADD_FRIEND_IMAGE_PATH = path.join(process.cwd(), "src", "assets", "draw-add-friend.png");
const DRAW_QR_PAGE_IMAGE_PATH = path.join(process.cwd(), "src", "assets", "draw-qr-page.png");
const DRAW_ACC_BLOCKED_IMAGE_PATH = path.join(process.cwd(), "src", "assets", "draw-acc-blocked.png");
const DRAW_STEAM_GUARD_ERROR_IMAGE_PATH = path.join(process.cwd(), "src", "assets", "draw-steam-guard-error.png");
const DRAW_CODE_DOTA2_IMAGE_PATH = path.join(process.cwd(), "src", "assets", "draw-code-dota2.png");
const DRAW_FRIEND_PAGE_IMAGE_PATH = path.join(process.cwd(), "src", "assets", "draw-friend-page.png");
const WELCOME_IMAGE_PATH = path.join(process.cwd(), "src", "assets", "welcome.png");
const SETTINGS_IMAGE_PATH = path.join(process.cwd(), "src", "assets", "settings.png");
const ONLINE_WATCH_IMAGE_PATH = path.join(process.cwd(), "src", "assets", "online-watch.png");

const state = new Map<number, UserFlow>();
const uiPromptMsg = new Map<number, number>();
const adminLogsViewState = new Map<number, { query: string }>();
const onlineWatchRuntime = new Map<number, RuntimeWatch>();
const onlineWatchProbeState = new Map<number, { lastStatusCheckAt: number; onlineStreak: number }>();
const steamTerminationInFlight = new Map<string, Promise<boolean>>();
const steamTerminationCooldownUntil = new Map<string, number>();
const steamProxyFailureUntil = new Map<string, number>();
const activeBroadcasts = new Set<string>();
let onlineWatchLoopStarted = false;
let rentReportLoopStarted = false;
let rentReportTickInFlight = false;
let rentDiscordBridgeLoopStarted = false;
let steamProxyLastUrl = "";
let steamProxyOverrideUrl: string | null = null;

const steamIdResolveCache = new Map<string, { steamId: string; updatedAt: number }>();
const invitePageCache = new Map<string, InvitePageData & { updatedAt: number }>();
const rentReportReservationKeys = new Set<string>();
let moscowTimeCache: { value: { dateKey: string; hour: number; minute: number }; updatedAt: number } | null = null;
const STEAM_ABORT_RESOURCE_TYPES = new Set(["media", "font", "websocket"]);
const STEAM_SCREENSHOT_CLIP_DEFAULT = { x: 0, y: 122, width: 1920, height: 810 };
const STEAM_SCREENSHOT_CLIP_WITH_HEADER = { x: 0, y: 0, width: 1920, height: 932 };
const STEAM_FRIEND_TEMPLATE_VIEWPORT = { width: 1920, height: 1080 };
const STEAM_FRIEND_FALLBACK_AVATAR_URL = "https://avatars.akamai.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg";
const RENT_REPORT_HOUR_MSK = 13;
const RENT_REPORT_MINUTE_MSK = 45;
const RENT_REPORT_POLL_INTERVAL_MS = 30_000;
const RENT_REPORT_TIME_SOURCE_URL = "https://timeapi.io/api/Time/current/zone?timeZone=Europe/Moscow";

let steamBrowser: any = null;
let steamPage: any = null;
let steamAddFriendPage: any = null;
let steamSourcePage: any = null;
let steamTemplatePage: any = null;
let steamReadyPromise: Promise<void> | null = null;
let steamRenderChain: Promise<unknown> = Promise.resolve();
function appState() {
  return store.getState() as any;
}

function saveState() {
  store.saveNow();
}

function getUserById(userId: number) {
  return appState().users.find((row: any) => Number(row.id) === Number(userId)) || null;
}

function getUserByTgId(tgId: number) {
  return appState().users.find((row: any) => Number(row.tg_id) === Number(tgId)) || null;
}

function getUserByQuery(queryRaw: string) {
  const query = String(queryRaw || "").trim();
  const normalized = query.replace(/^@/, "").toLowerCase();
  const id = Number(query || -1);
  return (
    appState().users.find((row: any) => Number(row.id) === id) ||
    appState().users.find((row: any) => String(row.tg_username || "").toLowerCase() === normalized) ||
    appState().users.find((row: any) => String(row.discord_tag || "").toLowerCase() === query.toLowerCase()) ||
    null
  );
}

const ROLE_ORDER: Role[] = ["USER", "HELPER", "ADMIN"];
const ROLE_LABELS: Record<Role, string> = {
  USER: "Пользователь",
  HELPER: "Помощник",
  ADMIN: "Администратор",
};
const TOGGLABLE_ROLES: Role[] = ["HELPER", "ADMIN"];

function normalizeRole(roleRaw: unknown): Role | null {
  const role = String(roleRaw || "").toUpperCase();
  if (role === "USER" || role === "HELPER" || role === "ADMIN") return role;
  return null;
}

function formatRoleList(roles: Role[]) {
  return roles.map((role) => ROLE_LABELS[role]).join(", ");
}

function rolesByUserId(userId: number): Role[] {
  const seen = new Set<Role>(["USER"]);
  for (const row of appState().user_roles.filter((row: any) => Number(row.user_id) === Number(userId))) {
    const role = normalizeRole(row.role);
    if (role) seen.add(role);
  }
  const user = getUserById(userId);
  if (ADMIN_IDS.includes(Number(user?.tg_id || 0))) seen.add("ADMIN");
  return ROLE_ORDER.filter((role) => seen.has(role));
}

function ensureUser(ctx: Ctx) {
  const tgId = Number(ctx.from?.id || 0);
  if (!tgId) return null;

  let user = getUserByTgId(tgId);
  if (!user) {
    db.prepare("INSERT OR IGNORE INTO users (tg_id, tg_username, registered_at) VALUES (?, ?, ?)").run(
      tgId,
      ctx.from?.username || null,
      nowIso(),
    );
    user = getUserByTgId(tgId);
    if (user) {
      db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, 'USER')").run(user.id);
    }
  }

  if (!user) return null;

  if (String(user.tg_username || "") !== String(ctx.from?.username || "")) {
    user.tg_username = ctx.from?.username || null;
    saveState();
  }

  if (ADMIN_IDS.includes(tgId)) {
    db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, 'ADMIN')").run(user.id);
    if (!Number(user.is_approved || 0)) {
      db.prepare("UPDATE users SET is_approved = 1 WHERE id = ?").run(user.id);
      user.is_approved = 1;
    }
  }

  store.ensureUserPrefs(user.id);
  return { ...user, roles: rolesByUserId(user.id) as Role[] };
}

function hasRole(user: any, roles: Role[]) {
  if (roles.includes("ADMIN") && ADMIN_IDS.includes(Number(user?.tg_id || 0))) {
    return true;
  }
  return Array.isArray(user?.roles) && user.roles.some((role: Role) => roles.includes(role));
}

function getMainKeyboard(user: any) {
  return mainKbForRole(hasRole(user, ["ADMIN"]));
}

function getUserPhishingLink(userId: number) {
  const prefs = store.ensureUserPrefs(userId) as any;
  const link = String(prefs?.phishing_link || "").trim();
  return link || null;
}

function setUserPhishingLink(userId: number, link: string) {
  const prefs = store.ensureUserPrefs(userId) as any;
  prefs.phishing_link = link;
  saveState();
}

function hasAcceptedRentRules(userId: number) {
  const prefs = store.ensureUserPrefs(userId) as any;
  return Number(prefs.rent_rules_accepted || 0) === 1;
}

function setRentRulesAccepted(userId: number) {
  const prefs = store.ensureUserPrefs(userId) as any;
  prefs.rent_rules_accepted = 1;
  saveState();
}

function getRentResponsibleUsername() {
  const value = String((appState() as any).rent_responsible_username || "").trim();
  return value || null;
}

function setRentResponsibleUsername(usernameRaw: string) {
  const username = String(usernameRaw || "").trim().replace(/^@+/, "");
  (appState() as any).rent_responsible_username = username ? `@${username}` : null;
  saveState();
  return (appState() as any).rent_responsible_username as string | null;
}

function parseHttpUrl(raw: string) {
  try {
    const parsed = new URL(String(raw || "").trim());
    if (!/^https?:$/i.test(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function photoCache() {
  const stateData = appState() as any;
  if (!stateData.telegram_photo_cache || typeof stateData.telegram_photo_cache !== "object") {
    stateData.telegram_photo_cache = {};
  }
  return stateData.telegram_photo_cache as Record<string, string>;
}

function cachedPhotoMedia(imagePath: string) {
  return photoCache()[path.basename(imagePath)] || Input.fromLocalFile(imagePath);
}

function rememberPhotoFileId(imagePath: string, message: any) {
  const photos = Array.isArray(message?.photo) ? message.photo : [];
  const fileId = photos[photos.length - 1]?.file_id;
  if (!fileId) return;
  const cache = photoCache();
  if (cache[path.basename(imagePath)] === fileId) return;
  cache[path.basename(imagePath)] = fileId;
  saveState();
}

async function replyWithCachedPhoto(ctx: Ctx, imagePath: string, extra: any) {
  const sent = await ctx.replyWithPhoto(cachedPhotoMedia(imagePath), extra);
  rememberPhotoFileId(imagePath, sent);
  return sent;
}

async function editCachedPhotoMedia(ctx: Ctx, imagePath: string, caption: string, extra?: any) {
  if (ctx.updateType !== "callback_query" || typeof ctx.editMessageMedia !== "function") return false;
  return ctx
    .editMessageMedia(
      {
        type: "photo",
        media: cachedPhotoMedia(imagePath),
        caption,
        parse_mode: extra?.parse_mode,
      },
      extra?.reply_markup ? { reply_markup: extra.reply_markup } : undefined,
    )
    .then(() => true)
    .catch(() => false);
}

async function renderSettingsMenu(ctx: Ctx, user: any) {
  const phishingLink = getUserPhishingLink(user.id);
  const caption = `<b>⚙️ Настройки</b>\n\nФишинг-ссылка: <b>${phishingLink ? escapeHtml(phishingLink) : "не установлена"}</b>`;
  const extra = {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("🔗 Установить фишинг-ссылку", "settings:set_phishing")],
    ]).reply_markup,
  };

  if (await editCachedPhotoMedia(ctx, SETTINGS_IMAGE_PATH, caption, extra)) return;

  await replyWithCachedPhoto(ctx, SETTINGS_IMAGE_PATH, {
    ...extra,
    caption,
  }).catch(() => null);
}

async function askSetPhishingLinkFromDraw(ctx: Ctx) {
  state.delete(ctx.from.id);
  await replaceOrReply(ctx, `<b>Сначала установите фишинг-ссылку в главном меню → Настройки.</b>`, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("⚙️ Открыть настройки", "settings:menu")],
      [Markup.button.callback("⬅️ Назад", "draw:menu")],
    ]).reply_markup,
  });
}

async function getRequiredPhishingLink(ctx: Ctx, user: any) {
  const link = getUserPhishingLink(user.id);
  if (link) return link;
  await askSetPhishingLinkFromDraw(ctx);
  return null;
}

async function showMainMenu(ctx: Ctx, user: any, text?: string) {
  const approvedCount = appState().users.filter((row: any) => Number(row.is_approved || 0) === 1).length;
  const message =
    text ||
    `<tg-emoji emoji-id="5242732781406033436">👋</tg-emoji> Добро пожаловать в <a href="https://discord.gg/criminalchina"><b>CC TEAM BOT</b></a>.\n` +
      `╰ Пользователей в боте: <b>${approvedCount}</b>`;
  if (!text) {
    await replyWithCachedPhoto(ctx, WELCOME_IMAGE_PATH, {
      ...getMainKeyboard(user),
      caption: message,
      parse_mode: "HTML",
    })
      .catch(() => null);
    return;
  }
  await ctx
    .reply(message, {
      ...getMainKeyboard(user),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    })
    .catch(() => null);
}

function logEvent(user: any, eventType: string, details: string) {
  db.prepare(
    "INSERT INTO logs (actor_user_id, actor_tg_id, actor_role, event_type, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(user?.id || null, user?.tg_id || null, user?.roles?.[0] || "USER", eventType, details, nowIso());
}

async function resetUserFlow(ctx: Ctx) {
  const userId = Number(ctx.from?.id || 0);
  state.delete(userId);
  await deleteUserPrompt(ctx, userId);
}

async function clearUserFlowOnly(ctx: Ctx) {
  const userId = Number(ctx.from?.id || 0);
  state.delete(userId);
  uiPromptMsg.delete(userId);
}

async function deleteUserPrompt(ctx: Ctx, userId = Number(ctx.from?.id || 0)) {
  const promptId = uiPromptMsg.get(userId);
  uiPromptMsg.delete(userId);
  if (promptId && ctx.chat?.id) {
    await ctx.telegram.deleteMessage(ctx.chat.id, promptId).catch(() => null);
  }
}

async function sendCleanPrompt(ctx: Ctx, text: string, extra?: any) {
  const userId = Number(ctx.from?.id || 0);
  const previousMessageId = uiPromptMsg.get(userId);
  if (previousMessageId && ctx.chat?.id) {
    const edited = await ctx.telegram
      .editMessageText(ctx.chat.id, previousMessageId, undefined, text, extra)
      .then(() => true)
      .catch(() => false);
    if (edited) {
      return { message_id: previousMessageId };
    }
    await ctx.telegram.deleteMessage(ctx.chat.id, previousMessageId).catch(() => null);
  }
  const sent = await ctx.reply(text, extra).catch(() => null);
  if (sent?.message_id) {
    uiPromptMsg.set(userId, sent.message_id);
  }
  return sent;
}

async function replaceOrReply(ctx: Ctx, text: string, extra?: any) {
  if (ctx.updateType === "callback_query" && typeof ctx.editMessageText === "function") {
    const edited = await ctx.editMessageText(text, extra).then(() => true).catch(() => false);
    if (edited) return true;
    if (typeof ctx.editMessageCaption === "function") {
      const captionEdited = await ctx.editMessageCaption(text, extra).then(() => true).catch(() => false);
      if (captionEdited) return true;
    }
  }
  await ctx.reply(text, extra).catch(() => null);
  return false;
}

async function renderPhotoPrompt(ctx: Ctx, imagePath: string, caption: string, extra?: any) {
  if (await editCachedPhotoMedia(ctx, imagePath, caption, extra)) return true;

  if (ctx.updateType === "callback_query" && typeof ctx.editMessageCaption === "function") {
    const editedCaption = await ctx.editMessageCaption(caption, extra).then(() => true).catch(() => false);
    if (editedCaption) return true;
  }

  await replyWithCachedPhoto(ctx, imagePath, {
    ...(extra || {}),
    caption,
  }).catch(async () => {
    await replaceOrReply(ctx, caption, extra);
  });
  return true;
}

function normalizeProfileInput(input: string): { profileUrl: string; steamId: string | null } | null {
  const value = input.trim();
  const prepared = /^https?:\/\//i.test(value)
    ? value
    : /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(value)
      ? `https://${value}`
      : value;

  if (/^7\d{15,18}$/.test(value)) {
    return { profileUrl: `https://steamcommunity.com/profiles/${value}/`, steamId: value };
  }

  try {
    const parsed = new URL(prepared);
    const host = parsed.hostname.toLowerCase();
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (host === "steamcommunity.com" || host === "my.steamchina.com") {
      if (parts.length === 2 && parts[0] === "profiles" && /^7\d{15,18}$/.test(parts[1])) {
        return { profileUrl: `https://${host}/profiles/${parts[1]}/`, steamId: parts[1] };
      }
      if (parts.length === 2 && parts[0] === "id" && /^[A-Za-z0-9_-]{2,64}$/.test(parts[1])) {
        return { profileUrl: `https://${host}/id/${parts[1]}/`, steamId: null };
      }
    }
    return { profileUrl: parsed.toString(), steamId: null };
  } catch {
    return null;
  }
}

async function fetchTextSafe(url: string) {
  try {
    const preparedUrl = new URL(url);
    preparedUrl.searchParams.set("_", String(Date.now()));
    const res = await fetch(preparedUrl.toString(), {
      redirect: "follow",
      headers: {
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function resolveSteamId64FromProfileUrl(profileUrl: string) {
  const normalized = normalizeProfileInput(profileUrl)?.profileUrl || profileUrl;
  const cached = steamIdResolveCache.get(normalized);
  if (cached && Date.now() - cached.updatedAt < 30 * 60 * 1000) {
    return cached.steamId;
  }

  const direct = normalized.match(/\/profiles\/(7\d{15,18})\/?$/i)?.[1];
  if (direct) {
    steamIdResolveCache.set(normalized, { steamId: direct, updatedAt: Date.now() });
    return direct;
  }

  const vanity = normalized.match(/\/id\/([A-Za-z0-9_-]{2,64})\/?$/i)?.[1];
  if (!vanity) return null;

  const xml = await fetchTextSafe(`${normalized.replace(/\/+$/, "/")}?xml=1`);
  const xmlSteamId = xml?.match(/<steamID64>\s*(7\d{15,18})\s*<\/steamID64>/i)?.[1] || null;
  if (xmlSteamId) {
    steamIdResolveCache.set(normalized, { steamId: xmlSteamId, updatedAt: Date.now() });
    return xmlSteamId;
  }

  return null;
}

function parseSteamOnlineStateFromXml(xml: string) {
  const rawState = String(xml.match(/<onlineState>\s*([^<]+)\s*<\/onlineState>/i)?.[1] || "").trim().toLowerCase();
  if (!rawState) return null;
  if (rawState === "offline") return false;
  return true;
}

function parseSteamOnlineStateFromHtml(html: string) {
  const bodyClass = String(html.match(/<body[^>]*class=["']([^"']+)["']/i)?.[1] || "").toLowerCase();
  const personaClass = String(html.match(/class=["'][^"']*\bpersona\s+([^"']*)["']/i)?.[1] || "").toLowerCase();
  const playerAvatarClass = String(html.match(/class=["'][^"']*\bplayeravatar\s+([^"']*)["']/i)?.[1] || "").toLowerCase();
  const combined = `${bodyClass} ${personaClass} ${playerAvatarClass}`;
  if (/\boffline\b/.test(combined)) return false;
  if (/\b(online|in-game|ingame|away|busy|snooze)\b/.test(combined)) return true;
  if (/profile_in_game_header|profile_in_game_name|currently online|currently in-game/i.test(html)) return true;
  return null;
}

async function detectSteamProfileOnline(profileUrl: string): Promise<boolean | null> {
  const normalized = normalizeProfileInput(profileUrl);
  const normalizedUrl = normalized?.profileUrl || profileUrl;
  const steamId = normalized?.steamId || (await resolveSteamId64FromProfileUrl(normalizedUrl));

  const xmlUrl = steamId
    ? `https://steamcommunity.com/profiles/${steamId}/?xml=1`
    : `${normalizedUrl.replace(/\/+$/, "")}/?xml=1`;
  const xml = await fetchTextSafe(xmlUrl);
  if (xml) {
    const parsedXmlState = parseSteamOnlineStateFromXml(xml);
    if (parsedXmlState !== null) return parsedXmlState;
  }

  const htmlTargets = [
    normalizedUrl,
    steamId ? `https://steamcommunity.com/profiles/${steamId}/` : null,
  ].filter(Boolean) as string[];

  for (const target of htmlTargets) {
    const html = await fetchTextSafe(target);
    if (!html) continue;
    const parsedHtmlState = parseSteamOnlineStateFromHtml(html);
    if (parsedHtmlState !== null) return parsedHtmlState;
  }

  return null;
}

async function runOnlineWatchTick() {
  const rows = db
    .prepare("SELECT ow.id, ow.profile_url, ow.comment, u.tg_id FROM online_watch ow JOIN users u ON u.id = ow.user_id ORDER BY ow.id ASC")
    .all() as Array<{ id: number; profile_url: string; comment: string | null; tg_id: number }>;

  const activeIds = new Set(rows.map((row) => row.id));
  for (const [watchId] of onlineWatchRuntime.entries()) {
    if (!activeIds.has(watchId)) {
      onlineWatchRuntime.delete(watchId);
    }
  }
  for (const [watchId] of onlineWatchProbeState.entries()) {
    if (!activeIds.has(watchId)) {
      onlineWatchProbeState.delete(watchId);
    }
  }

  for (const row of rows) {
    const runtime = onlineWatchRuntime.get(row.id);
    const now = Date.now();
    let isOnline: boolean | null = null;

    if (runtime) {
      if (now - runtime.lastStatusCheckAt >= 30000) {
        isOnline = await detectSteamProfileOnline(row.profile_url);
      }
    } else {
      const probe = onlineWatchProbeState.get(row.id) || { lastStatusCheckAt: 0, onlineStreak: 0 };
      if (now - probe.lastStatusCheckAt >= 30000) {
        isOnline = await detectSteamProfileOnline(row.profile_url);
        probe.lastStatusCheckAt = now;
      }
      onlineWatchProbeState.set(row.id, probe);
    }

    if (isOnline === null && !runtime) continue;

    if (isOnline === null && runtime) {
      const elapsed = Math.max(0, Math.floor((now - runtime.onlineSince) / 1000));
      await bot.telegram
        .editMessageText(
          runtime.messageChatId,
          runtime.messageId,
          undefined,
          formatOnlineWatchOnlineText(runtime.profileUrl, runtime.comment, elapsed),
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
        )
        .catch(() => null);
      continue;
    }

    if (isOnline) {
      if (!runtime) {
        const probe = onlineWatchProbeState.get(row.id) || { lastStatusCheckAt: now, onlineStreak: 0 };
        probe.onlineStreak += 1;
        onlineWatchProbeState.set(row.id, probe);
        if (probe.onlineStreak < 2) continue;

        const sent = await bot.telegram
          .sendMessage(row.tg_id, formatOnlineWatchOnlineText(row.profile_url, row.comment, 0), {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          })
          .catch(() => null);
        if (!sent?.message_id) continue;

        onlineWatchRuntime.set(row.id, {
          onlineSince: Date.now(),
          messageChatId: row.tg_id,
          messageId: sent.message_id,
          profileUrl: row.profile_url,
          comment: row.comment || null,
          lastStatusCheckAt: now,
        });
        onlineWatchProbeState.delete(row.id);
        continue;
      }

      runtime.lastStatusCheckAt = now;
      const elapsed = Math.max(0, Math.floor((now - runtime.onlineSince) / 1000));
      await bot.telegram
        .editMessageText(
          runtime.messageChatId,
          runtime.messageId,
          undefined,
          formatOnlineWatchOnlineText(runtime.profileUrl, runtime.comment, elapsed),
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
        )
        .catch(() => null);
      continue;
    }

    if (runtime) {
      runtime.lastStatusCheckAt = now;
      const elapsed = Math.max(0, Math.floor((Date.now() - runtime.onlineSince) / 1000));
      await bot.telegram
        .editMessageText(
          runtime.messageChatId,
          runtime.messageId,
          undefined,
          formatOnlineWatchOfflineText(runtime.profileUrl, runtime.comment, elapsed),
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
        )
        .catch(() => null);
      onlineWatchRuntime.delete(row.id);
      onlineWatchProbeState.set(row.id, { lastStatusCheckAt: now, onlineStreak: 0 });
      continue;
    }

    const probe = onlineWatchProbeState.get(row.id);
    if (probe) {
      probe.onlineStreak = 0;
      onlineWatchProbeState.set(row.id, probe);
    }
  }
}

function startOnlineWatchLoop() {
  if (onlineWatchLoopStarted) return;
  onlineWatchLoopStarted = true;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOnlineWatchTick();
    } catch {}
    running = false;
  };
  void tick();
  setInterval(() => void tick(), 15000);
}

function getStatsRangeStartIso(range: StatsRangeKey) {
  if (range === "all") return null;
  const date = new Date();
  if (range === "today") {
    date.setHours(0, 0, 0, 0);
  } else if (range === "week") {
    date.setDate(date.getDate() - 7);
  } else if (range === "month") {
    date.setMonth(date.getMonth() - 1);
  }
  return date.toISOString();
}

function statsRangeLabel(range: StatsRangeKey) {
  return (
    {
      today: "Сегодня",
      week: "7 дней",
      month: "30 дней",
      all: "За все время",
    }[range] || "За все время"
  );
}

function formatAdminListDate(iso: string | null | undefined) {
  const date = new Date(String(iso || ""));
  if (Number.isNaN(date.getTime())) return "-";
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
}

function getSortedAdminUsers() {
  return appState()
    .users.filter((user: any) => Number(user.is_approved || 0) === 1)
    .sort((a: any, b: any) => Number(b.id || 0) - Number(a.id || 0));
}

async function renderAdminUserCard(ctx: Ctx, target: any, page: number) {
  const roles = rolesByUserId(target.id);
  const lines = [
    `<b>Пользователь #${target.id}</b>`,
    `Telegram: <b>${escapeHtml(target.tg_username ? `@${target.tg_username}` : String(target.tg_id || "-"))}</b>`,
    `Discord: <b>${escapeHtml(String(target.discord_tag || "-"))}</b>`,
    `Роли: <b>${escapeHtml(formatRoleList(roles))}</b>`,
    `Статус: <b>${Number(target.is_banned || 0) ? "Забанен" : "Активен"}</b>`,
    `Регистрация: <b>${escapeHtml(formatAdminListDate(target.registered_at))}</b>`,
  ];
  const kb = Markup.inlineKeyboard([
    TOGGLABLE_ROLES.map((role) =>
      Markup.button.callback(
        `${roles.includes(role) ? "✓ " : "+ "}${ROLE_LABELS[role]}`,
        `admin:role:${target.id}:${role}:${page}`,
      ),
    ),
    [Markup.button.callback(Number(target.is_banned || 0) ? "Разбанить" : "Забанить", `admin:ban:${target.id}:${page}`)],
    [Markup.button.callback("Назад", `admin:userlist:page:${page}`)],
  ]).reply_markup;
  await replaceOrReply(ctx, lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

async function renderAdminUsersPage(ctx: Ctx, pageRaw = 0) {
  const users = getSortedAdminUsers();
  const pageSize = 10;
  const maxPage = Math.max(0, Math.ceil(users.length / pageSize) - 1);
  const page = Math.max(0, Math.min(pageRaw, maxPage));
  const rows = users.slice(page * pageSize, page * pageSize + pageSize);

  const kbRows = rows.map((user: any) => {
    const tg = user.tg_username ? `@${user.tg_username}` : String(user.tg_id || "-");
    const status = Number(user.is_banned || 0) ? "бан" : "ok";
    return [Markup.button.callback(`#${user.id} ${tg} | ${status}`, `admin:usercard:${user.id}:${page}`)];
  });

  if (maxPage > 0) {
    kbRows.push([
      Markup.button.callback("◀", `admin:userlist:page:${Math.max(0, page - 1)}`),
      Markup.button.callback(`${page + 1}/${maxPage + 1}`, "admin:userlist:noop"),
      Markup.button.callback("▶", `admin:userlist:page:${Math.min(maxPage, page + 1)}`),
    ]);
  }
  kbRows.push([Markup.button.callback("Поиск", `admin:userlist:search:${page}`)]);

  await replaceOrReply(ctx, `<b>Пользователи</b>\nСтраница: <b>${page + 1}/${Math.max(1, maxPage + 1)}</b>`, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard(kbRows).reply_markup,
  });
}

function getLogRows(queryRaw = "") {
  const query = String(queryRaw || "").trim().toLowerCase();
  const usersById = new Map(appState().users.map((user: any) => [Number(user.id), user]));
  const rows = [...appState().logs]
    .sort((a: any, b: any) => Number(b.id || 0) - Number(a.id || 0))
    .map((log: any) => ({
      ...log,
      user: usersById.get(Number(log.actor_user_id || 0)) || null,
    }));
  if (!query) return rows;
  return rows.filter((row: any) => {
    const blob = [
      row.actor_role,
      row.event_type,
      row.details,
      row.user?.tg_username,
      row.user?.discord_tag,
      row.actor_tg_id,
    ]
      .map((value) => String(value || "").toLowerCase())
      .join(" ");
    return blob.includes(query);
  });
}

async function renderAdminLogs(ctx: Ctx, pageRaw = 0, queryRaw = "") {
  const rows = getLogRows(queryRaw);
  const pageSize = 8;
  const maxPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
  const page = Math.max(0, Math.min(pageRaw, maxPage));
  const slice = rows.slice(page * pageSize, page * pageSize + pageSize);

  const blocks = slice.length
    ? slice.map((row: any) => {
        const userLabel = row.user?.tg_username
          ? `@${row.user.tg_username}`
          : row.user?.tg_id
            ? String(row.user.tg_id)
            : String(row.actor_tg_id || "-");
        return (
          `<blockquote>` +
          `Время: <b>${escapeHtml(formatAdminListDate(row.created_at))}</b>\n` +
          `Роль: <b>${escapeHtml(String(row.actor_role || "USER"))}</b>\n` +
          `Событие: <b>${escapeHtml(String(row.event_type || "-"))}</b>\n` +
          `Пользователь: <b>${escapeHtml(userLabel)}</b>\n` +
          `Детали: <b>${escapeHtml(String(row.details || "-"))}</b>` +
          `</blockquote>`
        );
      })
    : ["<blockquote>Логи не найдены.</blockquote>"];

  const header = queryRaw
    ? `<b>Логи</b>\nПоиск: <b>${escapeHtml(queryRaw)}</b>\nСтраница: <b>${page + 1}/${Math.max(1, maxPage + 1)}</b>\n\n`
    : `<b>Логи</b>\nСтраница: <b>${page + 1}/${Math.max(1, maxPage + 1)}</b>\n\n`;

  const kbRows: any[] = [];
  if (maxPage > 0) {
    kbRows.push([
      Markup.button.callback("◀", `logs:page:${Math.max(0, page - 1)}`),
      Markup.button.callback(`${page + 1}/${maxPage + 1}`, "logs:noop"),
      Markup.button.callback("▶", `logs:page:${Math.min(maxPage, page + 1)}`),
    ]);
  }
  kbRows.push([Markup.button.callback("Поиск", "logs:search")]);
  if (queryRaw) {
    kbRows.push([Markup.button.callback("Сбросить поиск", "logs:clear")]);
  }

  await replaceOrReply(ctx, `${header}${blocks.join("\n")}`, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: Markup.inlineKeyboard(kbRows).reply_markup,
  });
}

async function renderAdminStats(ctx: Ctx, range: StatsRangeKey) {
  const fromIso = getStatsRangeStartIso(range);
  const users = appState().users as any[];
  const roles = appState().user_roles as any[];
  const watches = appState().online_watch as any[];
  const logs = appState().logs as any[];

  const filteredLogs = fromIso
    ? logs.filter((log: any) => String(log.created_at || "") >= fromIso)
    : logs;

  const adminIds = new Set(
    roles.filter((row: any) => String(row.role) === "ADMIN").map((row: any) => Number(row.user_id)),
  );
  const approvedUsers = users.filter((user: any) => Number(user.is_approved || 0) === 1).length;
  const bannedUsers = users.filter((user: any) => Number(user.is_banned || 0) === 1).length;
  const watchUsers = new Set(watches.map((watch: any) => Number(watch.user_id))).size;
  const drawActions = filteredLogs.filter((log: any) => String(log.event_type || "") === "draw").length;
  const onlineActions = filteredLogs.filter((log: any) => String(log.event_type || "") === "online_watch").length;
  const adminActions = filteredLogs.filter((log: any) => String(log.actor_role || "") === "ADMIN").length;

  const text =
    `<b>Статистика</b>\n` +
    `Период: <b>${statsRangeLabel(range)}</b>\n\n` +
    `Всего пользователей: <b>${users.length}</b>\n` +
    `Одобрено: <b>${approvedUsers}</b>\n` +
    `Админов: <b>${adminIds.size}</b>\n` +
    `Забанено: <b>${bannedUsers}</b>\n` +
    `Активных отслеживаний: <b>${watches.length}</b>\n` +
    `Пользователей с чекером: <b>${watchUsers}</b>\n` +
    `Логов за период: <b>${filteredLogs.length}</b>\n` +
    `Действий отрисовки: <b>${drawActions}</b>\n` +
    `Действий онлайн чекера: <b>${onlineActions}</b>\n` +
    `Админских действий: <b>${adminActions}</b>`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(range === "today" ? "• Сегодня" : "Сегодня", "stats:range:today"),
      Markup.button.callback(range === "week" ? "• 7 дней" : "7 дней", "stats:range:week"),
    ],
    [
      Markup.button.callback(range === "month" ? "• 30 дней" : "30 дней", "stats:range:month"),
      Markup.button.callback(range === "all" ? "• Все время" : "Все время", "stats:range:all"),
    ],
  ]).reply_markup;

  await replaceOrReply(ctx, text, { parse_mode: "HTML", reply_markup: kb });
}

async function renderAdminSteamProxy(ctx: Ctx) {
  const proxies = steamProxyList();
  await replaceOrReply(
    ctx,
    `<b>Steam \u043f\u0440\u043e\u043a\u0441\u0438</b>\n\n\u0420\u0435\u0436\u0438\u043c: <b>${escapeHtml(steamProxyStatusText())}</b>\n\u0412\u0441\u0435\u0433\u043e \u043f\u0440\u043e\u043a\u0441\u0438: <b>${proxies.length}</b>\n\n\u0414\u043e\u0431\u0430\u0432\u043b\u0435\u043d\u0438\u0435 \u043f\u0430\u0447\u043a\u043e\u0439: \u043a\u0430\u0436\u0434\u044b\u0439 \u043f\u0440\u043e\u043a\u0441\u0438 \u0441 \u043d\u043e\u0432\u043e\u0439 \u0441\u0442\u0440\u043e\u043a\u0438:\n<code>user:pass@host:port</code>\n<code>socks5://user:pass@host:port</code>`,
    {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u043f\u0440\u043e\u043a\u0441\u0438", "admin:steam_proxy:set")],
        [Markup.button.callback("\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u043f\u0440\u043e\u043a\u0441\u0438", "admin:steam_proxy:delete_menu")],
        [Markup.button.callback("\u041e\u0442\u043a\u043b\u044e\u0447\u0438\u0442\u044c \u0432\u0441\u0435", "admin:steam_proxy:clear")],
      ]).reply_markup,
    },
  );
}

async function renderAdminSteamProxyDeleteMenu(ctx: Ctx) {
  const proxies = steamProxyList();
  const rows = proxies.map((proxy, index) => [
    Markup.button.callback(`${index + 1}. ${maskedProxyValue(proxy.url)}`, `admin:steam_proxy:delete:${proxy.id}`),
  ]);
  await replaceOrReply(ctx, proxies.length ? "<b>\u0423\u0434\u0430\u043b\u0435\u043d\u0438\u0435 Steam \u043f\u0440\u043e\u043a\u0441\u0438</b>" : "<b>\u0421\u043f\u0438\u0441\u043e\u043a \u043f\u0440\u043e\u043a\u0441\u0438 \u043f\u0443\u0441\u0442.</b>", {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0432\u0441\u0435", "admin:steam_proxy:delete_all")],
      ...rows,
      [Markup.button.callback("\u041d\u0430\u0437\u0430\u0434", "admin:steam_proxy")],
    ]).reply_markup,
  });
}

function toggleUserBan(userId: number) {
  const user = getUserById(userId);
  if (!user) return null;
  user.is_banned = Number(user.is_banned || 0) ? 0 : 1;
  saveState();
  return user;
}

function toggleUserRole(userId: number, role: Role) {
  if (!TOGGLABLE_ROLES.includes(role)) return null;
  const user = getUserById(userId);
  if (!user) return null;

  const roles = appState().user_roles as Array<{ id: number; user_id: number; role: string }>;
  const matchesRole = (row: { user_id: number; role: string }) => {
    if (Number(row.user_id) !== Number(userId)) return false;
    const currentRole = String(row.role).toUpperCase();
    return currentRole === role;
  };
  const hasRoleAlready = roles.some(matchesRole);

  for (let index = roles.length - 1; index >= 0; index -= 1) {
    if (matchesRole(roles[index])) roles.splice(index, 1);
  }

  if (!hasRoleAlready) {
    const nextRoleId = roles.reduce((max, row) => Math.max(max, Number(row.id || 0)), 0) + 1;
    roles.push({ id: nextRoleId, user_id: Number(userId), role });
  }

  if (!roles.some((row) => Number(row.user_id) === Number(userId) && String(row.role).toUpperCase() === "USER")) {
    const nextRoleId = roles.reduce((max, row) => Math.max(max, Number(row.id || 0)), 0) + 1;
    roles.push({ id: nextRoleId, user_id: Number(userId), role: "USER" });
  }

  if (ADMIN_IDS.includes(Number(user.tg_id || 0))) {
    if (!roles.some((row) => Number(row.user_id) === Number(userId) && String(row.role).toUpperCase() === "ADMIN")) {
      const nextRoleId = roles.reduce((max, row) => Math.max(max, Number(row.id || 0)), 0) + 1;
      roles.push({ id: nextRoleId, user_id: Number(userId), role: "ADMIN" });
    }
    user.is_approved = 1;
  } else {
    const normalizedRoles = rolesByUserId(userId);
    user.is_approved = normalizedRoles.includes("ADMIN") ? 1 : Number(user.is_approved || 0);
  }
  saveState();
  return user;
}

function broadcastRecipients() {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const user of appState().users as any[]) {
    const tgId = Number(user.tg_id || 0);
    if (!tgId || seen.has(tgId)) continue;
    seen.add(tgId);
    result.push(tgId);
  }
  return result;
}

function waitMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBroadcastKey(sourceChatId: number, sourceMessageId: number) {
  return `source:${sourceChatId}:${sourceMessageId}`;
}

function getBroadcastLog(eventType: string, broadcastKey: string) {
  return (
    (appState().logs as any[]).find(
      (row) => String(row.event_type || "") === eventType && String(row.details || "").startsWith(broadcastKey),
    ) || null
  );
}

async function sendAdminBroadcast(ctx: Ctx, me: any) {
  const sourceChatId = ctx.chat?.id;
  const sourceMessageId = ctx.message?.message_id;
  if (!sourceChatId || !sourceMessageId) return false;

  const broadcastKey = getBroadcastKey(Number(sourceChatId), Number(sourceMessageId));
  if (activeBroadcasts.has(broadcastKey)) {
    state.delete(ctx.from.id);
    await ctx.reply("<b>Эта рассылка уже выполняется.</b>", { parse_mode: "HTML" }).catch(() => null);
    return true;
  }
  if (getBroadcastLog("admin_broadcast_done", broadcastKey)) {
    state.delete(ctx.from.id);
    await ctx.reply("<b>Эта рассылка уже была завершена. Повтор не запущен.</b>", { parse_mode: "HTML" }).catch(() => null);
    return true;
  }
  if (getBroadcastLog("admin_broadcast_start", broadcastKey)) {
    state.delete(ctx.from.id);
    await ctx.reply("<b>Эта рассылка уже запускалась. Повтор после рестарта заблокирован.</b>", { parse_mode: "HTML" }).catch(() => null);
    return true;
  }

  state.delete(ctx.from.id);
  logEvent(me, "admin_broadcast_start", broadcastKey);
  saveState();
  activeBroadcasts.add(broadcastKey);

  const recipients = broadcastRecipients();
  const status = await ctx.reply(`<b>Рассылка запущена.</b>\nПолучателей: <b>${recipients.length}</b>`, { parse_mode: "HTML" }).catch(() => null);

  void (async () => {
    let sent = 0;
    let failed = 0;
    try {
      for (const tgId of recipients) {
        try {
          await ctx.telegram.copyMessage(tgId, sourceChatId, sourceMessageId);
          sent += 1;
        } catch {
          failed += 1;
        }
        if ((sent + failed) % 20 === 0) {
          await waitMs(900);
        } else {
          await waitMs(35);
        }
      }

      const resultText = `<b>Рассылка завершена.</b>\nОтправлено: <b>${sent}</b>\nОшибок: <b>${failed}</b>`;
      if (status?.message_id) {
        await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, resultText, { parse_mode: "HTML" }).catch(() => null);
      } else {
        await ctx.reply(resultText, { parse_mode: "HTML" }).catch(() => null);
      }
      logEvent(me, "admin_broadcast_done", `${broadcastKey}:sent:${sent}:failed:${failed}`);
    } catch (error) {
      console.error("[BROADCAST ERROR]", error);
      const resultText = `<b>Рассылка остановлена с ошибкой.</b>\nОтправлено: <b>${sent}</b>\nОшибок: <b>${failed}</b>`;
      if (status?.message_id) {
        await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, resultText, { parse_mode: "HTML" }).catch(() => null);
      } else {
        await ctx.reply(resultText, { parse_mode: "HTML" }).catch(() => null);
      }
      logEvent(me, "admin_broadcast_failed", `${broadcastKey}:sent:${sent}:failed:${failed}`);
    } finally {
      activeBroadcasts.delete(broadcastKey);
    }
  })();

  return true;
}

async function renderDrawMenu(ctx: Ctx) {
  const text = `<tg-emoji emoji-id="5242657215751426928">🎨</tg-emoji> <b>Отрисовка.</b> Позволяет максимально быстро создать нужный шаблон под рабочие задачи.`;
  const extra = {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("👥 Добавление в друзья", "draw:add_friend")],
      [Markup.button.callback("🧾 Страница друга", "draw:friend_page")],
      [Markup.button.callback("🔳 QR-Код страница друга", "draw:qr_page")],
      [Markup.button.callback("⛔ Аккаунт заблокирован", "draw:acc_blocked")],
      [Markup.button.callback("🛡️ Ошибка Steam Guard", "draw:steam_guard_error")],
      [Markup.button.callback("🔑 Код DOTA 2", "draw:code_dota2")],
    ]).reply_markup,
  };

  if (ctx.updateType === "callback_query") {
    if (await editCachedPhotoMedia(ctx, DRAW_IMAGE_PATH, text, extra)) return;

    const editedCaption = typeof ctx.editMessageCaption === "function"
      ? await ctx.editMessageCaption(text, extra).then(() => true).catch(() => false)
      : false;
    if (editedCaption) return;

    const editedText = typeof ctx.editMessageText === "function"
      ? await ctx.editMessageText(text, extra).then(() => true).catch(() => false)
      : false;
    if (editedText) return;
  }

  try {
    await replyWithCachedPhoto(ctx, DRAW_IMAGE_PATH, {
      ...extra,
      caption: text,
    });
  } catch {
    await replaceOrReply(ctx, text, extra);
  }
}

async function runDrawJob(ctx: Ctx, job: () => Promise<string>, errorMessage: string, statusMessageId = 0) {
  let ticker: NodeJS.Timeout | null = null;
  let drawMessageId = statusMessageId;
  let screenshotPath = "";
  try {
    const frames = ["Рисую.", "Рисую..", "Рисую..."] as const;
    let frameIndex = 0;
    const statusText = () => `<b>${frames[frameIndex]}</b>`;
    const editDrawStatus = async (messageId: number) => {
      if (!ctx.chat?.id) return false;
      const editedText = await ctx.telegram
        .editMessageText(ctx.chat.id, messageId, undefined, statusText(), { parse_mode: "HTML" })
        .then(() => true)
        .catch(() => false);
      if (editedText) return true;
      return await ctx.telegram
        .editMessageCaption(ctx.chat.id, messageId, undefined, statusText(), { parse_mode: "HTML" })
        .then(() => true)
        .catch(() => false);
    };

    if (drawMessageId > 0 && ctx.chat?.id) {
      const editedStatus = await editDrawStatus(drawMessageId);
      if (!editedStatus) {
        drawMessageId = 0;
      }
    }

    if (!drawMessageId) {
      const statusMessage = await ctx.reply(statusText(), { parse_mode: "HTML" });
      drawMessageId = statusMessage.message_id;
    }

    ticker = setInterval(async () => {
      frameIndex = (frameIndex + 1) % frames.length;
      await editDrawStatus(drawMessageId);
    }, 800);

    screenshotPath = await job();
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }

    const editedDocument = drawMessageId > 0 && ctx.chat?.id
      ? await ctx.telegram
          .editMessageMedia(
            ctx.chat.id,
            drawMessageId,
            undefined,
            { type: "document", media: Input.fromLocalFile(screenshotPath, `IMG_${Date.now()}.png`) } as any,
          )
          .then(() => true)
          .catch(() => false)
      : false;

    if (!editedDocument) {
      if (drawMessageId) {
        await ctx.deleteMessage(drawMessageId).catch(() => null);
      }
      await ctx.replyWithDocument(Input.fromLocalFile(screenshotPath, `IMG_${Date.now()}.png`));
    }
    return true;
  } catch {
    if (ticker) clearInterval(ticker);
    let editedError = false;
    if (drawMessageId > 0 && ctx.chat?.id) {
      editedError = await ctx.telegram
        .editMessageText(ctx.chat.id, drawMessageId, undefined, errorMessage)
        .then(() => true)
        .catch(() => false);
      if (!editedError) {
        editedError = await ctx.telegram
          .editMessageCaption(ctx.chat.id, drawMessageId, undefined, errorMessage)
          .then(() => true)
          .catch(() => false);
      }
    }
    if (!editedError) {
      await ctx.reply(errorMessage).catch(() => null);
    }
    return false;
  } finally {
    if (screenshotPath) {
      await fs.rm(path.dirname(screenshotPath), { recursive: true, force: true }).catch(() => null);
    }
  }
}

function makeProfileDrawScreenshot(
  profileUrl: string,
  drawMode: ProfileDrawMode,
  variant: "link" | "id",
  headerInviteUrl?: string,
) {
  return makeSteamProfileScreenshot(profileUrl, {
    includeTopBar: Boolean(headerInviteUrl),
    headerInviteUrl,
    showAddFriendErrorModal: drawMode === "add_friend" || drawMode === "steam_guard_error",
    showAddFriendInviteBanner: variant === "link",
    showAccountBlockedModal: drawMode === "acc_blocked",
    addFriendErrorTextVariant: drawMode === "steam_guard_error" ? "steam_guard" : "default",
  });
}

async function handleDrawInput(ctx: Ctx, flow: Extract<UserFlow, { mode: string }>, rawText: string) {
  const promptMessageId = Number((flow as any).payload?.promptMessageId || 0);
  const editPromptOrReply = async (message: string) => {
    const edited = promptMessageId > 0 && ctx.chat?.id
      ? await ctx.telegram.editMessageText(ctx.chat.id, promptMessageId, undefined, message).then(() => true).catch(() => false)
      : false;
    if (!edited) {
      await ctx.reply(message).catch(() => null);
    }
  };
  if (ctx.message?.message_id) {
    await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => null);
  }

  const mode = flow.mode.replace("draw_input:", "");
  const text = rawText.trim();

  if (mode === "friend_page_normal_link") {
    const parsed = parseHttpUrl(text);
    if (!parsed) {
      await editPromptOrReply("Нужна корректная фишинг-ссылка http/https.");
      return;
    }
    state.delete(ctx.from.id);
    await runDrawJob(
      ctx,
      () => makeSteamFriendPageFromTemplateScreenshot(parsed, { variant: "normal" }),
      "Не удалось создать страницу друга.",
      promptMessageId,
    );
    return;
  }

  if (mode === "qr_page_time") {
    const inviteLink = String((flow as any).payload?.inviteLink || "");
    if (!inviteLink || !text) {
      await editPromptOrReply("Время не должно быть пустым.");
      return;
    }
    state.delete(ctx.from.id);
    await runDrawJob(ctx, () => makeSteamQrPageScreenshot(text, inviteLink), "Не удалось создать QR-страницу.", promptMessageId);
    return;
  }

  if (mode === "friend_page_code") {
    const inviteLink = String((flow as any).payload?.inviteLink || "");
    const showRegionMismatch = Boolean((flow as any).payload?.showRegionMismatch);
    if (!inviteLink || !text) {
      await editPromptOrReply("Код друга не должен быть пустым.");
      return;
    }
    state.delete(ctx.from.id);
    await runDrawJob(
      ctx,
      () => makeSteamFriendPageFromTemplateScreenshot(inviteLink, { variant: "not_found", friendCode: text, showRegionMismatch }),
      "Не удалось создать страницу друга.",
      promptMessageId,
    );
    return;
  }

  if (mode === "code_dota2_mammoth_code") {
    if (!text) {
      await editPromptOrReply("Код DOTA 2 не должен быть пустым.");
      return;
    }
    state.delete(ctx.from.id);
    await runDrawJob(
      ctx,
      () => makeDota2CodeNotFoundScreenshot(text),
      "Не удалось создать скриншот кода DOTA 2.",
      promptMessageId,
    );
    return;
  }

  const normalized = normalizeProfileInput(text);
  if (!normalized) {
    await editPromptOrReply(
      "Нужен SteamID или ссылка вида:\nhttps://steamcommunity.com/profiles/7656...\nhttps://steamcommunity.com/id/name/",
    );
    return;
  }

  if (mode === "add_friend" || mode === "acc_blocked" || mode === "steam_guard_error") {
    const variant = (flow as any).payload?.variant === "link" ? "link" : "id";
    const user = getUserByTgId(Number(ctx.from.id || 0));
    const phishingLink = user ? await getRequiredPhishingLink(ctx, user) : null;
    if (!phishingLink) {
      return;
    }
    state.delete(ctx.from.id);
    await runDrawJob(
      ctx,
      () => makeProfileDrawScreenshot(normalized.profileUrl, mode, variant, phishingLink),
      "Не удалось создать скриншот.",
      promptMessageId,
    );
    return;
  }

  state.delete(ctx.from.id);
  await runDrawJob(
    ctx,
    () => makeSteamProfileScreenshot(normalized.profileUrl),
    "Не удалось создать скриншот.",
    promptMessageId,
  );
}

function syncStateForRemovedWatch(watchId: number) {
  onlineWatchRuntime.delete(watchId);
  onlineWatchProbeState.delete(watchId);
}

function onlineWatchMenuMarkup() {
  return Markup.inlineKeyboard([[Markup.button.callback("📋 Список аккаунтов", "online_watch:list")]]).reply_markup;
}

function getOnlineWatchRowsForUser(userId: number) {
  return (appState().online_watch as any[])
    .filter((row) => Number(row.user_id) === Number(userId))
    .sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
}

async function renderOnlineWatchPrompt(ctx: Ctx) {
  const caption = `<tg-emoji emoji-id="5242657215751426928">🟢</tg-emoji> <b>Чекер онлайна.</b> Отправляет уведомление, когда нужный профиль появляется в сети\n\n<tg-emoji emoji-id="5240446651918753852">🔗</tg-emoji> Пришлите ссылку на профиль/SteamID`;
  const extra = {
    parse_mode: "HTML",
    reply_markup: onlineWatchMenuMarkup(),
  };

  if (await editCachedPhotoMedia(ctx, ONLINE_WATCH_IMAGE_PATH, caption, extra)) return;

  await replyWithCachedPhoto(ctx, ONLINE_WATCH_IMAGE_PATH, {
    ...extra,
    caption,
  }).catch(() => null);
}

async function renderRentalsMenu(ctx: Ctx) {
  await renderRentalsList(ctx, ensureUser(ctx));
}

async function renderRentalsRules(ctx: Ctx, options?: { instant?: boolean }) {
  const availableAt = options?.instant ? Date.now() : Date.now() + 30_000;
  const text =
    `<b>🧾 Условия аренды аккаунта</b>\n\n` +
    `Перед входом в раздел подтвердите правила:\n\n` +
    `1. <b>Ежедневная активность:</b> минимум <b>10 игр Turbo</b> или <b>5 игр Rating</b> в день.\n` +
    `2. <b>Ежедневный отчет:</b> каждый день в <b>13:45 МСК</b> нужно отправлять скрин списка игр.\n` +
    `3. <b>Отчеты обязательны:</b> если отчет не будет отправлен <b>2 раза за 7 дней</b>, аренда аккаунта будет отменена.\n` +
    `4. <b>Игры нельзя портить:</b> запрещены ливы, руин и любые действия, которые снижают порядочность аккаунта. За серьезный вред аккаунту доступ к аренде блокируется навсегда.\n` +
    `5. <b>Steam-ссылки запрещены:</b> нельзя отправлять ссылки в Steam Chat. Общение и переходы в Steam Chat выполняются самостоятельно, без рассылки ссылок.`;

  await renderPhotoPrompt(ctx, WELCOME_IMAGE_PATH, text, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback(options?.instant ? "⬅️ Назад" : "✅ Я понял, открыть аренду", options?.instant ? "rent:list" : `rent:rules_accept:${availableAt}`)],
    ]).reply_markup,
  });
}

function canManageRentals(user: any) {
  return hasRole(user, ["HELPER", "ADMIN"]);
}

function rentalRows() {
  return (appState().rentals as any[])
    .slice()
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
}

function getRentalByNumber(number: number) {
  return (appState().rentals as any[]).find((row) => Number(row.number) === Number(number)) || null;
}

function getRentalById(id: number) {
  return (appState().rentals as any[]).find((row) => Number(row.id) === Number(id)) || null;
}

function userLabel(user: any) {
  if (!user) return "-";
  return user.tg_username ? `@${user.tg_username}` : String(user.tg_id || user.id || "-");
}

function rentalListLabel(row: any) {
  const status = Number(row.is_busy || 0) ? "🔴" : "🟢";
  return `${status} ${String(row.title || `Аккаунт #${row.number}`)} №${row.number}`;
}

function formatDiscordRentalCommand(rental: any) {
  return `/ar ${Number(rental.number)}`;
}

function formatDiscordRentalInstruction(rental: any) {
  return (
    `<b>Заявка почти готова.</b>\n\n` +
    `Чтобы подтвердить Discord, зайдите на сервер и отправьте команду в канале <b>rent-cmd</b> (<code>1532708640513986562</code>):\n\n` +
    `<code>${escapeHtml(formatDiscordRentalCommand(rental))}</code>\n\n` +
    `После подтверждения заявка уйдет на рассмотрение уже с вашим Discord.`
  );
}

function nextRentalNumber() {
  return rentalRows().reduce((max, row) => Math.max(max, Number(row.number || 0)), 0) + 1;
}

function nextRowId(rows: any[]) {
  return rows.reduce((max, row) => Math.max(max, Number(row.id || 0)), 0) + 1;
}

function moscowNowPartsFromTimeApiPayload(payload: any) {
  const directYear = Number(payload?.year);
  const directMonth = Number(payload?.month);
  const directDay = Number(payload?.day);
  const directHour = Number(payload?.hour);
  const directMinute = Number(payload?.minute);
  if ([directYear, directMonth, directDay, directHour, directMinute].every(Number.isFinite)) {
    return {
      dateKey: `${String(directYear).padStart(4, "0")}-${String(directMonth).padStart(2, "0")}-${String(directDay).padStart(2, "0")}`,
      hour: directHour === 24 ? 0 : directHour,
      minute: directMinute,
    };
  }

  const dateTime = String(payload?.dateTime || payload?.local_time || "").trim();
  const dateTimeMatch = dateTime.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
  if (dateTimeMatch) {
    const [, year, month, day, hourRaw, minuteRaw] = dateTimeMatch;
    const hour = Number(hourRaw);
    return {
      dateKey: `${year}-${month}-${day}`,
      hour: hour === 24 ? 0 : hour,
      minute: Number(minuteRaw),
    };
  }

  const date = String(payload?.date || "").trim();
  const time = String(payload?.time || "").trim();
  const [hourRaw, minuteRaw] = time.split(":").map(Number);
  const isoDateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const slashDateMatch = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const matchedDate = isoDateMatch
    ? { year: isoDateMatch[1], month: isoDateMatch[2], day: isoDateMatch[3] }
    : slashDateMatch
      ? { year: slashDateMatch[3], month: slashDateMatch[1].padStart(2, "0"), day: slashDateMatch[2].padStart(2, "0") }
      : null;
  if (matchedDate && Number.isFinite(hourRaw) && Number.isFinite(minuteRaw)) {
    const hour = Number(hourRaw);
    return {
      dateKey: `${matchedDate.year}-${matchedDate.month}-${matchedDate.day}`,
      hour: hour === 24 ? 0 : hour,
      minute: Number(minuteRaw),
    };
  }

  return null;
}

async function moscowNowPartsFromTrustedSource() {
  if (moscowTimeCache && Date.now() - moscowTimeCache.updatedAt < 15_000) {
    return moscowTimeCache.value;
  }
  try {
    const response = await fetch(RENT_REPORT_TIME_SOURCE_URL, {
      headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" },
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const payload = (await response.json()) as any;
      const value = moscowNowPartsFromTimeApiPayload(payload);
      if (value) {
        moscowTimeCache = { value, updatedAt: Date.now() };
        return value;
      }
    }
  } catch {}
  return null;
}

function isRentReportRequestMinute(moscow: { hour: number; minute: number }) {
  return moscow.hour === RENT_REPORT_HOUR_MSK && moscow.minute >= RENT_REPORT_MINUTE_MSK && moscow.minute <= RENT_REPORT_MINUTE_MSK + 1;
}

function isRentalStartedAfterTodayReportTime(rental: any, dateKey: string) {
  const rentedAt = String(rental?.rented_at || "").trim();
  if (!rentedAt) return false;
  const parsed = new Date(rentedAt);
  if (Number.isNaN(parsed.getTime())) return false;
  const [year, month, day] = dateKey.split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return false;
  const reportTimeUtc = Date.UTC(year, month - 1, day, RENT_REPORT_HOUR_MSK - 3, RENT_REPORT_MINUTE_MSK, 0, 0);
  const nextReportDateUtc = Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0);
  return parsed.getTime() > reportTimeUtc && parsed.getTime() < nextReportDateUtc;
}

function activeRentalRows() {
  return (appState().rentals as any[]).filter((row) => Number(row.is_busy || 0) === 1 && Number(row.rented_by_user_id || 0));
}

function rentReports() {
  const stateData = appState();
  if (!Array.isArray(stateData.rent_reports)) stateData.rent_reports = [];
  return stateData.rent_reports as any[];
}

function reportRequestDateKey(report: any) {
  const explicitKey = String(report?.report_date || "").trim();
  if (explicitKey) return explicitKey;
  const requestedAt = String(report?.requested_at || "").trim();
  if (!requestedAt) return "";
  const parsed = new Date(requestedAt);
  if (Number.isNaN(parsed.getTime())) return "";
  const moscowTimestamp = parsed.getTime() + 3 * 60 * 60 * 1000;
  return new Date(moscowTimestamp).toISOString().slice(0, 10);
}

function findDailyRentReport(rental: any, dateKey: string) {
  return rentReports().find(
    (report) =>
      Number(report.rental_id || 0) === Number(rental.id || 0) &&
      Number(report.user_id || 0) === Number(rental.rented_by_user_id || 0) &&
      reportRequestDateKey(report) === dateKey,
  ) || null;
}

function rentReportReservationKey(rental: any, userId: number, dateKey: string) {
  return `${Number(rental.id || 0)}:${Number(userId || 0)}:${dateKey}`;
}

function reserveDailyRentReport(rental: any, renter: any, dateKey: string) {
  const key = rentReportReservationKey(rental, Number(renter.id || 0), dateKey);
  if (rentReportReservationKeys.has(key)) return null;
  const existingReport = findDailyRentReport(rental, dateKey);
  if (existingReport) {
    rental.last_report_date = dateKey;
    if (!rental.report_deadline_at && String(existingReport.deadline_at || "")) {
      rental.report_deadline_at = existingReport.deadline_at;
    }
    saveState();
    return null;
  }
  rentReportReservationKeys.add(key);
  const reports = rentReports();
  const report = {
    id: nextRowId(reports),
    rental_id: Number(rental.id),
    rental_number: Number(rental.number),
    user_id: Number(renter.id),
    report_date: dateKey,
    status: "REQUESTED",
    requested_at: nowIso(),
    deadline_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    submitted_at: null,
    reviewed_at: null,
    reviewed_by_user_id: null,
    file_id: null,
    file_unique_id: null,
    admin_comment: null,
  };
  reports.push(report);
  rental.report_deadline_at = report.deadline_at;
  rental.last_report_date = dateKey;
  saveState();
  return report;
}

function releaseDailyRentReportReservation(rental: any, renter: any, report: any, dateKey: string) {
  const key = rentReportReservationKey(rental, Number(renter.id || 0), dateKey);
  rentReportReservationKeys.delete(key);
  const reports = rentReports();
  const reportIndex = reports.findIndex((row) => Number(row.id || 0) === Number(report?.id || 0));
  if (reportIndex >= 0 && String(reports[reportIndex]?.status || "") === "REQUESTED" && !String(reports[reportIndex]?.file_id || "")) {
    reports.splice(reportIndex, 1);
  }
  if (String(rental.last_report_date || "") === dateKey) rental.last_report_date = null;
  if (String(rental.report_deadline_at || "") === String(report?.deadline_at || "")) rental.report_deadline_at = null;
  saveState();
}

function rentDiscordPendingRows() {
  const stateData = appState();
  if (!Array.isArray(stateData.rent_discord_pending)) stateData.rent_discord_pending = [];
  return stateData.rent_discord_pending as any[];
}

function createRentDiscordPending(rental: any, user: any) {
  const rows = rentDiscordPendingRows();
  for (const row of rows) {
    if (
      Number(row.rental_number) === Number(rental.number) &&
      Number(row.tg_user_id) === Number(user.id) &&
      String(row.status || "") === "PENDING"
    ) {
      row.updated_at = nowIso();
      saveState();
      return row;
    }
  }
  const row = {
    id: nextRowId(rows),
    rental_id: Number(rental.id),
    rental_number: Number(rental.number),
    tg_user_id: Number(user.id),
    tg_id: Number(user.tg_id || 0),
    status: "PENDING",
    discord_user_id: null,
    discord_username: null,
    discord_display_name: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    processed_at: null,
  };
  rows.push(row);
  saveState();
  return row;
}

function rentDiscordPendingFor(rentalNumber: number, userId: number) {
  return rentDiscordPendingRows()
    .filter((row) => Number(row.rental_number) === Number(rentalNumber) && Number(row.tg_user_id) === Number(userId))
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")))[0] || null;
}

function getRentReportById(reportId: number) {
  return rentReports().find((row) => Number(row.id) === Number(reportId)) || null;
}

function canSubmitRentReport(report: any) {
  const status = String(report?.status || "");
  const deadline = Date.parse(String(report?.deadline_at || ""));
  return (status === "REQUESTED" || status === "RETRY_REQUESTED") && Number.isFinite(deadline) && deadline > Date.now();
}

function findActiveRentReportForUser(userId: number) {
  return rentReports()
    .filter((report) => Number(report.user_id || 0) === Number(userId) && canSubmitRentReport(report))
    .sort((a, b) => String(b.requested_at || "").localeCompare(String(a.requested_at || "")))[0] || null;
}

function steamCookieHeaderFromRental(rental: any) {
  const cookies = [
    ["sessionid", rental?.steam_session_id],
    ["steamLoginSecure", rental?.steam_login_secure],
    ["browserid", rental?.steam_browser_id],
  ]
    .map(([name, value]) => [name, String(value || "").trim()])
    .filter(([, value]) => value);
  return cookies.map(([name, value]) => `${name}=${value}`).join("; ");
}

function parseSteamCookies(cookies: string[]) {
  const parsed: Record<string, string> = {};
  for (const cookie of cookies) {
    const [pair] = String(cookie || "").split(";");
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) continue;
    parsed[pair.slice(0, separatorIndex).trim()] = pair.slice(separatorIndex + 1).trim();
  }
  return parsed;
}

function steamCookieHeaderFromCookies(cookies: string[]) {
  return Object.entries(parseSteamCookies(cookies))
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function decodeJwtPayload(token: string) {
  const [, payload] = String(token || "").split(".");
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function loadSteamMafileFromRental(rental: any) {
  const mafilePath = String(rental?.mafile_path || rental?.mafile_archive_path || "").trim();
  if (!mafilePath) return null;
  try {
    return JSON.parse(await fs.readFile(mafilePath, "utf8"));
  } catch (error) {
    console.warn(`[STEAM MAFILE READ FAILED] rental=${rental?.number || rental?.id || "unknown"} path=${mafilePath}`, error);
    return null;
  }
}

function steamRefreshTokenCandidates(rental: any, mafile: any) {
  return Array.from(
    new Set(
      [
        rental?.steam_refresh_token,
        mafile?.Session?.RefreshToken,
        mafile?.Session?.refresh_token,
        mafile?.refresh_token,
      ]
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function steamTerminationKey(rental: any, mafile: any) {
  const session = mafile?.Session || {};
  return String(
    session.SteamID ||
      mafile?.steamid ||
      mafile?.SteamID ||
      mafile?.account_name ||
      rental?.login ||
      rental?.id ||
      rental?.number ||
      "unknown",
  ).trim();
}

function steamCookiesFromMafile(mafile: any) {
  const session = mafile?.Session || {};
  const steamId = String(session.SteamID || mafile?.steamid || mafile?.SteamID || "").trim();
  const accessToken = String(session.AccessToken || session.access_token || "").trim();
  const mobileLoginSecure = steamId && accessToken && decodeJwtPayload(accessToken) ? `${steamId}%7C%7C${accessToken}` : "";
  return [
    ["sessionid", session.SessionID || session.sessionid],
    ["steamLoginSecure", mobileLoginSecure || session.SteamLoginSecure || session.steamLoginSecure],
    ["browserid", session.BrowserID || session.browserid],
  ]
    .map(([name, value]) => [name, String(value || "").trim()])
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${value}`);
}

function tokenAudiences(token: string) {
  const payload = decodeJwtPayload(token);
  const aud = payload?.aud;
  if (Array.isArray(aud)) return aud.map((value) => String(value));
  if (aud) return [String(aud)];
  return [];
}

function isExpectedSteamNetworkError(error: any) {
  return error?.name === "AbortError" || error?.code === 429 || error?.cause?.code === "UND_ERR_CONNECT_TIMEOUT";
}

function steamTerminationCooldowns() {
  const stateData = appState() as any;
  if (!stateData.steam_termination_cooldowns || typeof stateData.steam_termination_cooldowns !== "object") {
    stateData.steam_termination_cooldowns = {};
  }
  return stateData.steam_termination_cooldowns as Record<string, number>;
}

function getSteamTerminationCooldown(terminationKey: string) {
  return Math.max(Number(steamTerminationCooldownUntil.get(terminationKey) || 0), Number(steamTerminationCooldowns()[terminationKey] || 0));
}

function setSteamTerminationCooldown(terminationKey: string, durationMs: number) {
  const until = Date.now() + durationMs;
  steamTerminationCooldownUntil.set(terminationKey, until);
  steamTerminationCooldowns()[terminationKey] = until;
  saveState();
}

function normalizeSteamProxyUrl(value: string) {
  const trimmed = String(value || "").trim();
  if (!trimmed || /^off$/i.test(trimmed) || /^clear$/i.test(trimmed) || /^none$/i.test(trimmed)) return "";
  const normalized = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `socks5://${trimmed}`;
  const parsed = new URL(normalized);
  if (!["socks4:", "socks4a:", "socks5:", "http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Unsupported proxy protocol");
  }
  if (!parsed.hostname || !parsed.port) throw new Error("Proxy host and port are required");
  return parsed.toString();
}

function steamProxyUrl() {
  if (steamProxyOverrideUrl !== null) {
    steamProxyLastUrl = steamProxyOverrideUrl;
    return steamProxyOverrideUrl;
  }
  const stateData = appState() as any;
  const proxies = steamProxyList();
  const now = Date.now();
  for (const [proxy, failedUntil] of Array.from(steamProxyFailureUntil.entries())) {
    if (failedUntil <= now) steamProxyFailureUntil.delete(proxy);
  }
  if (proxies.length) {
    const active = proxies
      .map((proxy) => String(proxy.url || "").trim())
      .filter((proxy) => proxy && (steamProxyFailureUntil.get(proxy) || 0) <= now);
    const picked = active.length ? active[Math.floor(Math.random() * active.length)] : "";
    steamProxyLastUrl = picked;
    return picked;
  }
  const picked = String(stateData.steam_session_proxy || "").trim();
  steamProxyLastUrl = (steamProxyFailureUntil.get(picked) || 0) > now ? "" : picked;
  return steamProxyLastUrl;
}

function activeSteamProxyUrls() {
  const now = Date.now();
  for (const [proxy, failedUntil] of Array.from(steamProxyFailureUntil.entries())) {
    if (failedUntil <= now) steamProxyFailureUntil.delete(proxy);
  }
  const urls = steamProxyList()
    .map((proxy) => String(proxy.url || "").trim())
    .filter((proxy) => proxy && (steamProxyFailureUntil.get(proxy) || 0) <= now);
  for (let index = urls.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [urls[index], urls[swapIndex]] = [urls[swapIndex], urls[index]];
  }
  return urls;
}

function steamProxyStatusText() {
  const proxies = steamProxyList();
  if (proxies.length) return `\u0441\u043b\u0443\u0447\u0430\u0439\u043d\u044b\u0439 \u0438\u0437 ${proxies.length}`;
  return steamProxyUrl() ? maskedProxyUrl() : "\u043e\u0442\u043a\u043b\u044e\u0447\u0435\u043d";
}

function setSteamProxyUrl(value: string) {
  (appState() as any).steam_session_proxy = value || null;
  steamTerminationCooldownUntil.clear();
  const cooldowns = steamTerminationCooldowns();
  for (const key of Object.keys(cooldowns)) delete cooldowns[key];
  saveState();
}

function steamProxyList() {
  const stateData = appState() as any;
  if (!Array.isArray(stateData.steam_session_proxies)) stateData.steam_session_proxies = [];
  return stateData.steam_session_proxies as Array<{ id: number; url: string; created_at: string }>;
}

function addSteamProxyUrl(url: string) {
  const proxies = steamProxyList();
  const existing = proxies.find((proxy) => proxy.url === url);
  if (existing) {
    setSteamProxyUrl(existing.url);
    return existing;
  }
  const row = { id: nextRowId(proxies), url, created_at: nowIso() };
  proxies.push(row);
  setSteamProxyUrl(row.url);
  return row;
}

function deleteSteamProxy(proxyId: number) {
  const stateData = appState() as any;
  const proxies = steamProxyList();
  const before = proxies.length;
  stateData.steam_session_proxies = proxies.filter((row) => Number(row.id) !== Number(proxyId));
  if (before === stateData.steam_session_proxies.length) return false;
  stateData.steam_session_proxy = stateData.steam_session_proxies[0]?.url || null;
  setSteamProxyUrl(String(stateData.steam_session_proxy || ""));
  return true;
}

function clearSteamProxies() {
  const stateData = appState() as any;
  stateData.steam_session_proxies = [];
  stateData.steam_session_proxy_active_id = null;
  setSteamProxyUrl("");
}

function maskedProxyUrl() {
  return maskedProxyValue(steamProxyUrl());
}

function maskedProxyValue(proxy: string) {
  if (!proxy) return "disabled";
  try {
    const parsed = new URL(proxy);
    if (parsed.password) parsed.password = "***";
    if (parsed.username) parsed.username = parsed.username ? `${parsed.username}` : "";
    return parsed.toString();
  } catch {
    return proxy.replace(/:\/\/([^:@]+):([^@]+)@/, "://$1:***@");
  }
}

function isSteamProxyError(error: any) {
  const text = `${String(error?.message || "")} ${String(error?.code || "")} ${String(error?.name || "")} ${String(error?.cause?.code || "")}`;
  return /SOCKS|ERR_SOCKS|NotAllowed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ENOTFOUND|EHOSTUNREACH/i.test(text);
}

function markSteamProxyFailure(error: any) {
  if (!steamProxyLastUrl || !isSteamProxyError(error)) return false;
  steamProxyFailureUntil.set(steamProxyLastUrl, Date.now() + 5 * 60 * 1000);
  console.warn(`[STEAM PROXY QUARANTINED] proxy=${maskedProxyValue(steamProxyLastUrl)} ttl=300s reason=${String(error?.message || error)}`);
  steamProxyLastUrl = "";
  return true;
}

async function withSteamProxyOverride<T>(proxyUrl: string, fn: () => Promise<T>) {
  const previous = steamProxyOverrideUrl;
  steamProxyOverrideUrl = proxyUrl;
  try {
    return await fn();
  } finally {
    steamProxyOverrideUrl = previous;
  }
}

async function runSteamProxySequence<T>(rental: any, label: string, fn: () => Promise<T>) {
  const attempts = [...activeSteamProxyUrls(), ""];
  let lastError: any = null;
  for (const proxyUrl of attempts) {
    try {
      return await withSteamProxyOverride(proxyUrl, fn);
    } catch (error) {
      lastError = error;
      if (proxyUrl && isSteamProxyError(error)) {
        steamProxyFailureUntil.set(proxyUrl, Date.now() + 5 * 60 * 1000);
        console.warn(`[STEAM PROXY QUARANTINED] proxy=${maskedProxyValue(proxyUrl)} ttl=300s reason=${String((error as any)?.message || error)}`);
      }
      console.warn(`[${label}${proxyUrl ? "" : " DIRECT"} FAILED] rental=${rental?.number || rental?.id || "unknown"}`, error);
    }
  }
  if (lastError) throw lastError;
  return null as T;
}

function steamSessionOptions() {
  const proxy = steamProxyUrl();
  if (!proxy) return {};
  return proxy.startsWith("socks") ? { socksProxy: proxy } : { httpProxy: proxy };
}

function steamUserOptions() {
  const proxy = steamProxyUrl();
  return proxy ? { renewRefreshTokens: false, ...(proxy.startsWith("socks") ? { socksProxy: proxy } : { httpProxy: proxy }) } : { renewRefreshTokens: false };
}

function playwrightProxyOptions() {
  const proxy = steamProxyUrl();
  return proxy ? { proxy: { server: proxy } } : {};
}

async function getSteamClientSessionFromRefreshToken(refreshToken: string) {
  if (!tokenAudiences(refreshToken).includes("client")) {
    return { cookies: [], sessionId: null, kickedPlayingSession: false };
  }

  const SteamUser = require("steam-user");
  const client = new SteamUser(steamUserOptions());
  let settled = false;

  return new Promise<{ cookies: string[]; sessionId: string | null; kickedPlayingSession: boolean }>((resolve) => {
    let webSessionRequested = false;
    let kickedPlayingSession = false;

    const finish = (value: { cookies: string[]; sessionId: string | null; kickedPlayingSession: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.logOff();
      resolve(value);
    };
    const timeout = setTimeout(() => finish({ cookies: [], sessionId: null, kickedPlayingSession }), 45_000);

    client.once("loggedOn", () => {
      webSessionRequested = true;
      client.kickPlayingSession((error: Error | null) => {
        kickedPlayingSession = !error;
      });
      client.webLogOn();
    });
    client.once("webSession", (sessionId: string, cookies: string[]) => {
      finish({ cookies, sessionId, kickedPlayingSession });
    });
    client.once("error", () => finish({ cookies: [], sessionId: null, kickedPlayingSession }));
    client.once("disconnected", () => {
      if (!settled && webSessionRequested) finish({ cookies: [], sessionId: null, kickedPlayingSession });
    });
    try {
      client.logOn({ refreshToken, logonID: Math.floor(Math.random() * 0x7fffffff), machineName: "rent-session-terminator" });
    } catch {
      finish({ cookies: [], sessionId: null, kickedPlayingSession });
    }
  });
}

async function getSteamWebSessionWithCredentials(rental: any, mafile: any) {
  const accountName = String(rental?.login || mafile?.account_name || mafile?.AccountName || "").trim();
  const password = String(rental?.pass || rental?.password || "").trim();
  const steamGuardCode = await generateSteamGuardCodeFromRentalAtSteamTime(rental);
  if (!accountName || !password || !steamGuardCode) return null;

  const session = new LoginSession(EAuthTokenPlatformType.MobileApp, steamSessionOptions());
  session.loginTimeout = 12_000;
  try {
    const authenticated = new Promise<{ ok: boolean; error?: Error }>((resolve) => {
      const timeout = setTimeout(() => resolve({ ok: false, error: new Error("Steam web login timed out") }), 15_000);
      const finish = (result: { ok: boolean; error?: Error }) => {
        clearTimeout(timeout);
        resolve(result);
      };
      session.once("authenticated", () => finish({ ok: true }));
      session.once("timeout", () => finish({ ok: false, error: new Error("Steam web login timed out") }));
      session.once("error", (error: Error) => finish({ ok: false, error }));
    });

    const response = await session.startWithCredentials({
      accountName,
      password,
      steamGuardCode,
    });
    if (response.actionRequired) {
      const needsDeviceCode = response.validActions?.some((action: any) => action.type === EAuthSessionGuardType.DeviceCode);
      if (needsDeviceCode) await session.submitSteamGuardCode(steamGuardCode);
    }

    const authResult = await authenticated;
    if (!authResult.ok) throw authResult.error || new Error("Steam web login failed");
    const cookies = await session.getWebCookies();
    const accessToken = String(session.accessToken || "").trim();
    const refreshToken = String(session.refreshToken || "").trim();
    session.cancelLoginAttempt?.();
    return { cookies, accessToken, refreshToken };
  } catch (error) {
    session.cancelLoginAttempt?.();
    throw error;
  }
}

async function postSteamForm(url: string, cookieHeader: string, body: URLSearchParams) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      cookie: cookieHeader,
      origin: new URL(url).origin,
      referer: "https://store.steampowered.com/twofactor/manage",
      "user-agent": "Mozilla/5.0",
    },
    body,
  });
  if (response.status === 302) return true;
  if (!response.ok || response.url.includes("/login/")) return false;
  const text = await response.text().catch(() => "");
  if (/login\/\?redir|Sign in|Войти/i.test(text)) return false;
  return true;
}

async function deauthorizeSteamDevicesWithApi(cookieHeader: string, sessionId: string) {
  if (!cookieHeader || !sessionId) return false;
  const bodies = [
    new URLSearchParams({ sessionid: sessionId, action: "deauthorize" }),
    new URLSearchParams({ sessionid: sessionId, action: "deauthorize_all_devices" }),
  ];
  const results = await Promise.allSettled([
    postSteamForm("https://store.steampowered.com/twofactor/manage_action", cookieHeader, bodies[0]),
    postSteamForm("https://store.steampowered.com/account/authorizeddevices", cookieHeader, bodies[0]),
    postSteamForm("https://store.steampowered.com/account/authorizeddevices", cookieHeader, bodies[1]),
  ]);
  return results.some((result) => result.status === "fulfilled" && result.value);
}

async function postSteamApi(method: string, accessToken: string, payload: Record<string, any>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  const body = new URLSearchParams({
    access_token: accessToken,
    input_json: JSON.stringify(payload),
  });
  try {
    const response = await fetch(`https://api.steampowered.com/IAuthenticationService/${method}/v1/`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "user-agent": "Mozilla/5.0",
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (!text.trim()) return {};
    try {
      return JSON.parse(text)?.response || {};
    } catch {
      return {};
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function revokeSteamTokenString(token: string, accessToken: string) {
  const result = await postSteamApi("RevokeToken", accessToken, {
    token,
    revoke_action: 1,
  });
  return !!result;
}

async function revokeSteamRefreshTokenIds(accessToken: string) {
  const enumerated = await postSteamApi("EnumerateTokens", accessToken, { include_revoked: false });
  const tokens = Array.isArray(enumerated?.refresh_tokens) ? enumerated.refresh_tokens : [];
  let revokedCount = 0;
  for (const token of tokens) {
    const tokenId = String(token?.token_id || "").trim();
    if (!tokenId) continue;
    const result = await postSteamApi("RevokeRefreshToken", accessToken, {
      token_id: tokenId,
      revoke_action: 1,
    });
    if (result) revokedCount += 1;
  }
  return revokedCount;
}

async function firstVisibleLocator(page: any, selectors: string[], timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count().catch(() => 0)) > 0 && (await locator.isVisible().catch(() => false))) {
        return locator;
      }
    }
    await page.waitForTimeout(250).catch(() => null);
  }
  return null;
}

async function fillFirstVisible(page: any, selectors: string[], value: string, timeoutMs = 10_000) {
  const locator = await firstVisibleLocator(page, selectors, timeoutMs);
  if (!locator) return false;
  await locator.fill(value);
  return true;
}

async function clickFirstVisible(page: any, selectors: string[], timeoutMs = 10_000) {
  const locator = await firstVisibleLocator(page, selectors, timeoutMs);
  if (!locator) return false;
  await locator.click();
  return true;
}

async function clickSteamActionByText(page: any, labels: string[], timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await page
      .evaluate((candidateLabels: string[]) => {
        const normalizedLabels = candidateLabels.map((label) => label.toLowerCase());
        const isClickable = (element: Element) => {
          const tag = element.tagName.toLowerCase();
          const role = element.getAttribute("role") || "";
          const className = String((element as HTMLElement).className || "");
          return (
            ["button", "a", "input"].includes(tag) ||
            role === "button" ||
            typeof (element as HTMLElement).onclick === "function" ||
            /\b(btn|button|DialogButton|action|remove|deauth)\b/i.test(className)
          );
        };
        const visibleMatches = Array.from(document.querySelectorAll("body *"))
          .map((element) => {
            const htmlElement = element as HTMLElement;
            const text = `${htmlElement.innerText || htmlElement.textContent || ""} ${(htmlElement as HTMLInputElement).value || ""}`.trim();
            const rect = htmlElement.getBoundingClientRect();
            const visible = rect.width > 20 && rect.height > 12 && rect.bottom > 0 && rect.top < window.innerHeight;
            const matches = normalizedLabels.some((label) => text.toLowerCase().includes(label));
            return { element: htmlElement, rect, visible, matches, text };
          })
          .filter((item) => item.visible && item.matches)
          .map((item) => {
            let target: HTMLElement | null = item.element;
            for (let depth = 0; target && depth < 5; depth += 1) {
              if (isClickable(target)) break;
              target = target.parentElement;
            }
            return target ? { target, rect: target.getBoundingClientRect() } : null;
          })
          .filter(Boolean) as Array<{ target: HTMLElement; rect: DOMRect }>;
        visibleMatches.sort((left, right) => right.rect.top - left.rect.top || right.rect.width * right.rect.height - left.rect.width * left.rect.height);
        const target = visibleMatches[0]?.target;
        if (!target) return false;
        target.scrollIntoView({ block: "center", inline: "center" });
        target.click();
        return true;
      }, labels)
      .catch(() => false);
    if (clicked) return true;
    await page.mouse.wheel(0, 1200).catch(() => null);
    await page.waitForTimeout(300).catch(() => null);
  }
  return false;
}

async function submitSteamAuthorizedDevicesForm(page: any) {
  const actionResult = await page
    .evaluate(() => {
      const forms = Array.from(document.querySelectorAll("form"));
      const form = forms.find((item) => /deauthorize|authorizeddevices|steamguard/i.test(item.getAttribute("action") || ""));
      if (!form) return null;
      const action = form.getAttribute("action") || window.location.href;
      const data = new FormData(form);
      const submitter = Array.from(form.querySelectorAll("button,input")).find((element) =>
        /sign out|deauthorize|выйти|деавтор/i.test(`${element.textContent || ""} ${(element as HTMLInputElement).value || ""}`),
      ) as HTMLButtonElement | HTMLInputElement | undefined;
      if (submitter?.name) data.set(submitter.name, submitter.value || "1");
      return {
        action: new URL(action, window.location.href).href,
        method: (form.getAttribute("method") || "POST").toUpperCase(),
        body: new URLSearchParams(Array.from(data.entries()).map(([key, value]) => [key, String(value)])).toString(),
      };
    })
    .catch(() => null);
  if (!actionResult?.action) return false;
  const response = await page.request.fetch(actionResult.action, {
    method: actionResult.method,
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      origin: "https://store.steampowered.com",
      referer: "https://store.steampowered.com/account/authorizeddevices",
    },
    data: actionResult.body,
  });
  return response.ok() || response.status() === 302;
}

async function clickSteamSignOutEverywhere(page: any) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => null);
  await page.waitForTimeout(700).catch(() => null);
  const labels = ["Sign out everywhere", "Deauthorize all devices", "Deauthorize all other devices", "Выйти везде", "Деавторизовать все устройства"];
  const clicked = await clickSteamActionByText(page, labels, 18_000);
  if (!clicked) return submitSteamAuthorizedDevicesForm(page);

  await page.waitForTimeout(900).catch(() => null);
  await clickSteamActionByText(page, ["Confirm", "OK", "Continue", "Sign out everywhere", "Подтвердить", "ОК", "Продолжить", "Выйти везде"], 7000).catch(
    () => false,
  );
  await page.waitForTimeout(2500).catch(() => null);
  return true;
}

async function submitSteamGuardCode(page: any, guardCode: string) {
  const code = String(guardCode || "").trim();
  if (!code) return false;

  await page.waitForTimeout(1200).catch(() => null);
  const oneCharInputs = page.locator('input[maxlength="1"], input[data-index]');
  const oneCharCount = await oneCharInputs.count().catch(() => 0);
  if (oneCharCount >= 5) {
    for (let index = 0; index < 5; index += 1) {
      await oneCharInputs.nth(index).fill(code[index] || "");
    }
    return true;
  }

  return fillFirstVisible(
    page,
    [
      'input[inputmode="numeric"]',
      'input[autocomplete="one-time-code"]',
      'input[type="tel"]',
      'input[type="text"]:not([name="username"])',
    ],
    code,
    2500,
  );
}

async function deauthorizeSteamDevicesWithBrowser(rental: any) {
  const login = String(rental?.login || "").trim();
  const password = String(rental?.pass || rental?.password || "").trim();
  if (!login || !password) return false;

  const guardCode = await generateSteamGuardCodeFromRental(rental);
  const { chromium } = (await import("playwright")) as any;
  const browser = await chromium.launch({ headless: true, ...playwrightProxyOptions() });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    await page.goto("https://store.steampowered.com/login/?redir=account%2Fauthorizeddevices", {
      waitUntil: "domcontentloaded",
      timeout: 35_000,
    });

    const filledLogin = await fillFirstVisible(
      page,
      ['input[name="username"]', 'input[type="text"]', 'input[autocomplete="username"]'],
      login,
      15_000,
    );
    const filledPassword = await fillFirstVisible(
      page,
      ['input[name="password"]', 'input[type="password"]', 'input[autocomplete="current-password"]'],
      password,
      15_000,
    );
    if (!filledLogin || !filledPassword) return false;

    const clickedLogin = await clickFirstVisible(
      page,
      ['button[type="submit"]', 'button:has-text("Sign in")', 'button:has-text("Войти")'],
      10_000,
    );
    if (!clickedLogin) return false;

    if (guardCode) {
      await submitSteamGuardCode(page, guardCode);
      await clickFirstVisible(page, ['button:has-text("Submit")', 'button:has-text("Continue")', 'button:has-text("Отправить")'], 2500).catch(
        () => false,
      );
    }

    await page.waitForURL((url: URL) => !url.pathname.includes("/login"), { timeout: 35_000 }).catch(() => null);
    await page.goto("https://store.steampowered.com/account/authorizeddevices", {
      waitUntil: "domcontentloaded",
      timeout: 35_000,
    });
    return clickSteamSignOutEverywhere(page);
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

async function deauthorizeSteamDevicesWithCookies(cookies: string[]) {
  const parsedCookies = parseSteamCookies(cookies);
  const steamLoginSecure = parsedCookies.steamLoginSecure;
  const sessionId = parsedCookies.sessionid;
  if (!steamLoginSecure || !sessionId) return false;

  const { chromium } = (await import("playwright")) as any;
  const browser = await chromium.launch({ headless: true, ...playwrightProxyOptions() });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    await context.addCookies(
      Object.entries(parsedCookies).map(([name, value]) => ({
        name,
        value,
        domain: ".steampowered.com",
        path: "/",
        httpOnly: name.toLowerCase().includes("secure"),
        secure: true,
        sameSite: "Lax" as const,
      })),
    );
    await page.goto("https://store.steampowered.com/account/authorizeddevices", {
      waitUntil: "domcontentloaded",
      timeout: 35_000,
    });
    return clickSteamSignOutEverywhere(page);
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

async function terminateSteamSessionsForRental(rental: any) {
  const mafile = await loadSteamMafileFromRental(rental);
  const terminationKey = steamTerminationKey(rental, mafile);
  const runningTermination = steamTerminationInFlight.get(terminationKey);
  if (runningTermination) {
    return runningTermination;
  }
  const termination = terminateSteamSessionsForRentalOnce(rental, mafile, terminationKey).finally(() => {
    steamTerminationInFlight.delete(terminationKey);
  });
  steamTerminationInFlight.set(terminationKey, termination);
  return termination;
}

async function terminateSteamSessionsForRentalOnce(rental: any, mafile: any, terminationKey: string) {
  const refreshTokens = steamRefreshTokenCandidates(rental, mafile);
  const mafileAccessToken = String(mafile?.Session?.AccessToken || mafile?.Session?.access_token || "").trim();
  const mafileCookies = steamCookiesFromMafile(mafile);
  let sessionId = String(rental?.steam_session_id || "").trim();
  let cookieHeader = steamCookieHeaderFromRental(rental);
  let terminated = false;
  const accessTokens = new Set<string>(
    [mafileAccessToken, rental?.steam_login_secure]
      .map((token) => String(token || "").trim())
      .filter((token) => token && decodeJwtPayload(token)),
  );

  if (mafileCookies.length) {
    const parsedCookies = parseSteamCookies(mafileCookies);
    if (parsedCookies.sessionid) sessionId = parsedCookies.sessionid;
    const mafileCookieHeader = steamCookieHeaderFromCookies(mafileCookies);
    if (mafileCookieHeader) cookieHeader = mafileCookieHeader;
    try {
      terminated = (await deauthorizeSteamDevicesWithApi(cookieHeader, sessionId)) || terminated;
      if (!terminated) {
        terminated = (await runSteamProxySequence(rental, "STEAM MAFILE COOKIE SESSION", () => deauthorizeSteamDevicesWithCookies(mafileCookies))) || terminated;
      }
    } catch (error) {
      console.warn(`[STEAM MAFILE COOKIE SESSION FAILED] rental=${rental?.number || rental?.id || "unknown"}`, error);
    }
  }

  if (!terminated && getSteamTerminationCooldown(terminationKey) <= Date.now()) {
    try {
      const freshSession = await runSteamProxySequence(rental, "STEAM FRESH WEB LOGIN", () => getSteamWebSessionWithCredentials(rental, mafile));
      if (freshSession?.accessToken && decodeJwtPayload(freshSession.accessToken)) accessTokens.add(freshSession.accessToken);
      if (freshSession?.refreshToken && decodeJwtPayload(freshSession.refreshToken)) {
        refreshTokens.push(freshSession.refreshToken);
        if (tokenAudiences(freshSession.refreshToken).includes("client") && getSteamTerminationCooldown(`${terminationKey}:cm`) <= Date.now()) {
          const clientSession = await getSteamClientSessionFromRefreshToken(freshSession.refreshToken);
          terminated = clientSession.kickedPlayingSession || terminated;
          setSteamTerminationCooldown(`${terminationKey}:cm`, 90_000);
        }
      }
      if (freshSession?.cookies?.length) {
        const parsedCookies = parseSteamCookies(freshSession.cookies);
        if (parsedCookies.sessionid) sessionId = parsedCookies.sessionid;
        const freshCookieHeader = steamCookieHeaderFromCookies(freshSession.cookies);
        if (freshCookieHeader) cookieHeader = freshCookieHeader;
        terminated = (await deauthorizeSteamDevicesWithApi(cookieHeader, sessionId)) || terminated;
      }
    } catch (error) {
      if ((error as any)?.code === 429) {
        setSteamTerminationCooldown(terminationKey, 10 * 60 * 1000);
      } else {
        console.warn(`[STEAM FRESH WEB LOGIN FAILED] rental=${rental?.number || rental?.id || "unknown"}`, error);
      }
    }
  }

  for (const refreshToken of refreshTokens) {
    if (!tokenAudiences(refreshToken).includes("client")) continue;
    try {
      const { cookies, sessionId: steamClientSessionId, kickedPlayingSession } = await getSteamClientSessionFromRefreshToken(refreshToken);
      terminated = kickedPlayingSession || terminated;
      const parsedCookies = parseSteamCookies(cookies);
      if (steamClientSessionId || parsedCookies.sessionid) sessionId = steamClientSessionId || parsedCookies.sessionid;
      const freshCookieHeader = steamCookieHeaderFromCookies(cookies);
      if (freshCookieHeader) cookieHeader = freshCookieHeader;
      if (cookies.length) terminated = (await deauthorizeSteamDevicesWithApi(cookieHeader, sessionId)) || terminated;
      break;
    } catch (error) {
      markSteamProxyFailure(error);
      console.warn(`[STEAM CLIENT SESSION FAILED] rental=${rental?.number || rental?.id || "unknown"}`, error);
    }
  }

  for (const accessToken of Array.from(accessTokens)) {
    try {
      const revokedTokenIds = await revokeSteamRefreshTokenIds(accessToken);
      if (revokedTokenIds > 0) terminated = true;
    } catch (error) {
      if (!isExpectedSteamNetworkError(error)) console.warn(`[STEAM TOKEN ENUMERATE FAILED] rental=${rental?.number || rental?.id || "unknown"}`, error);
    }
  }
  for (const refreshToken of refreshTokens) {
    for (const accessToken of Array.from(accessTokens)) {
      try {
        terminated = (await revokeSteamTokenString(refreshToken, accessToken)) || terminated;
        break;
      } catch (error) {
        if (!isExpectedSteamNetworkError(error)) console.warn(`[STEAM TOKEN REVOKE FAILED] rental=${rental?.number || rental?.id || "unknown"}`, error);
      }
    }
  }

  if (sessionId && cookieHeader) {
    const deauthorizeBody = new URLSearchParams({ sessionid: sessionId, action: "deauthorize" });
    const logoutBody = new URLSearchParams({ sessionid: sessionId });
    const results = await Promise.allSettled([
      postSteamForm("https://store.steampowered.com/twofactor/manage_action", cookieHeader, deauthorizeBody),
      postSteamForm("https://store.steampowered.com/login/logout/", cookieHeader, logoutBody),
      postSteamForm("https://steamcommunity.com/login/logout/", cookieHeader, logoutBody),
    ]);
    terminated = results.some((result) => result.status === "fulfilled" && result.value);
  }

  if (!terminated) {
    try {
      terminated = await runSteamProxySequence(rental, "STEAM BROWSER SESSION", () => deauthorizeSteamDevicesWithBrowser(rental));
    } catch (error) {
      console.warn(`[STEAM BROWSER SESSION FAILED] rental=${rental?.number || rental?.id || "unknown"}`, error);
    }
  }
  if (!terminated) {
    console.warn(`[STEAM SESSION TERMINATE SKIPPED] rental=${rental?.number || rental?.id || "unknown"}`);
  } else {
    setSteamTerminationCooldown(terminationKey, 90_000);
  }
  return terminated;
}

function cancelRental(rental: any) {
  if (!rental) return false;
  const renterId = Number(rental.rented_by_user_id || 0);
  rental.is_busy = 0;
  rental.rented_by_user_id = null;
  rental.report_deadline_at = null;
  rental.last_report_date = null;
  rental.last_report_message_id = null;
  rental.report_misses = [];
  rental.steam_refresh_token = null;
  rental.steam_login_secure = null;
  rental.steam_login_secure_exp = null;
  rental.steam_session_id = null;
  rental.steam_browser_id = null;
  appState().guard_attempts = (appState().guard_attempts as any[]).filter(
    (row) => Number(row.rental_id) !== Number(rental.id) || Number(row.user_id) !== renterId,
  );
  saveState();
  return true;
}

async function cancelRentalWithSteamSessions(rental: any) {
  if (!rental) return false;
  const rentalId = Number(rental.id || 0);
  const liveRental = rentalId ? getRentalById(rentalId) || rental : rental;
  const steamCleanupRental = { ...liveRental };
  const canceled = cancelRental(liveRental);
  terminateSteamSessionsForRental(steamCleanupRental).catch((error) => console.error("[STEAM SESSION TERMINATE ERROR]", error));
  return canceled;
}

function markRentalReportMiss(rental: any) {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const misses = Array.isArray(rental.report_misses) ? rental.report_misses : [];
  rental.report_misses = misses
    .map((value: any) => Date.parse(String(value)))
    .filter((value: number) => Number.isFinite(value) && value >= weekAgo)
    .map((value: number) => new Date(value).toISOString());
  rental.report_misses.push(new Date(now).toISOString());
  return rental.report_misses.length;
}

function removeRentalReportMisses(rental: any, count: number) {
  const removeCount = Math.max(0, Math.floor(Number(count || 0)));
  if (!rental || removeCount <= 0) return 0;
  const misses = (Array.isArray(rental.report_misses) ? rental.report_misses : [])
    .map((value: any) => Date.parse(String(value)))
    .filter((value: number) => Number.isFinite(value))
    .sort((a: number, b: number) => a - b);
  const before = misses.length;
  rental.report_misses = misses
    .slice(0, Math.max(0, misses.length - removeCount))
    .map((value: number) => new Date(value).toISOString());
  saveState();
  return before - rental.report_misses.length;
}

function rentalBackButton() {
  return Markup.button.callback("⬅️ Назад", "rent:list");
}

function activeReportMissCount(rental: any) {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return (Array.isArray(rental.report_misses) ? rental.report_misses : [])
    .map((value: any) => Date.parse(String(value)))
    .filter((value: number) => Number.isFinite(value) && value >= weekAgo).length;
}

function markExpiredRentReportAsMissed(rental: any, deadline: string) {
  const report = rentReports().find(
    (row) =>
      Number(row.rental_id || 0) === Number(rental.id || 0) &&
      String(row.deadline_at || "") === deadline &&
      (String(row.status || "") === "REQUESTED" || String(row.status || "") === "RETRY_REQUESTED"),
  );
  if (!report) return null;
  report.status = "MISSED";
  report.missed_at = nowIso();
  return report;
}

function rentalDiscordLabel(rental: any, renter: any) {
  const userDiscord = String(renter?.discord_tag || renter?.discord_id || "").trim();
  if (userDiscord) return userDiscord;
  const latest = rentDiscordPendingRows()
    .filter((row) => Number(row.rental_number) === Number(rental.number) && Number(row.tg_user_id) === Number(renter?.id || 0))
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")))[0];
  const name = String(latest?.discord_display_name || latest?.discord_username || "").trim();
  const id = String(latest?.discord_user_id || "").trim();
  return name && id ? `${name} (${id})` : name || id || "-";
}

async function renderRentalsList(ctx: Ctx, user: any) {
  const rows = rentalRows();
  const keyboardRows = rows.map((row) => [
    Markup.button.callback(rentalListLabel(row), `rent:view:${row.number}`),
  ]);
  keyboardRows.push([Markup.button.callback("📜 Правила", "rent:rules")]);
  if (canManageRentals(user)) {
    keyboardRows.push([Markup.button.callback("⚙️ Управление", "rent:manage")]);
  }

  const responsible = getRentResponsibleUsername() || "не назначен";
  const caption = rows.length
    ? `<tg-emoji emoji-id="5242657215751426928">🧾</tg-emoji> <b>Аренда аккаунтов.</b> Выберите аккаунт из списка\n\n<tg-emoji emoji-id="5240026767325961445">👤</tg-emoji> Ответственный: <b>${escapeHtml(responsible)}</b>\n\n<tg-emoji emoji-id="5242655665268232103">🔗</tg-emoji> Нажмите на нужный аккаунт ниже`
    : `<tg-emoji emoji-id="5242657215751426928">🧾</tg-emoji> <b>Аренда аккаунтов.</b> Аккаунтов для аренды пока нет.\n\n<tg-emoji emoji-id="5240026767325961445">👤</tg-emoji> Ответственный: <b>${escapeHtml(responsible)}</b>`;
  await renderPhotoPrompt(ctx, WELCOME_IMAGE_PATH, caption, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard(keyboardRows).reply_markup,
  });
}

async function renderRentalCard(ctx: Ctx, number: number) {
  const rental = getRentalByNumber(number);
  if (!rental) {
    await replaceOrReply(ctx, "<b>Аккаунт не найден.</b>", {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[rentalBackButton()]]).reply_markup,
    });
    return;
  }
  const busyText = Number(rental.is_busy || 0) ? "\n\n<b>Статус:</b> занят" : "";
  const renter = getUserById(Number(rental.rented_by_user_id || 0));
  const managerDetails = canManageRentals(ensureUser(ctx)) && renter
    ? `\n<b>Арендован:</b> ${escapeHtml(userLabel(renter))}\n<b>Discord:</b> ${escapeHtml(rentalDiscordLabel(rental, renter))}\n<b>Отчетов пропущено:</b> ${activeReportMissCount(rental)}`
    : "";
  const keyboardRows = Number(rental.is_busy || 0)
    ? [[rentalBackButton()]]
    : [
        [Markup.button.callback("🧾 Арендовать", `rent:take:${rental.number}`)],
        [rentalBackButton()],
      ];
  await replaceOrReply(
    ctx,
    `<b>${escapeHtml(String(rental.title || `Аккаунт #${rental.number}`))} №${rental.number}</b>\n\n${escapeHtml(String(rental.description || "Описание не указано."))}${managerDetails}${busyText}`,
    {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: Markup.inlineKeyboard(keyboardRows).reply_markup,
    },
  );
}

async function renderRentalsManage(ctx: Ctx) {
  const keyboardRows = [
    [Markup.button.callback("➕ Добавить аккаунт(ы)", "rent:add")],
    [Markup.button.callback("🗑 Удалить аккаунт(ы)", "rent:delete")],
    [Markup.button.callback("✏️ Редактировать", "rent:edit")],
    [Markup.button.callback("⛔ Отменить аренду", "rent:cancel")],
  ];
  const me = ensureUser(ctx);
  if (hasRole(me, ["ADMIN"])) {
    keyboardRows.push([Markup.button.callback("👤 Ответственный", "rent:responsible")]);
  }
  keyboardRows.push([rentalBackButton()]);
  await replaceOrReply(ctx, "<b>⚙️ Управление арендой</b>", {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard(keyboardRows).reply_markup,
  });
}

async function renderRentalsCancelMenu(ctx: Ctx) {
  const rows = activeRentalRows();
  const keyboardRows = rows.map((row) => [
    Markup.button.callback(
      `Отменить: ${String(row.title || `Аккаунт #${row.number}`)} №${row.number}`,
      `rent:cancel:${row.id}`,
    ),
  ]);
  keyboardRows.push([Markup.button.callback("⬅️ Назад", "rent:manage")]);
  await replaceOrReply(ctx, rows.length ? "<b>⛔ Выберите активную аренду</b>" : "<b>Активных аренд нет.</b>", {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard(keyboardRows).reply_markup,
  });
}

async function renderRentalsDeleteMenu(ctx: Ctx) {
  const rows = rentalRows();
  const keyboardRows = rows.map((row) => [
    Markup.button.callback(`Удалить: ${String(row.title || `Аккаунт #${row.number}`)}`, `rent:delete:${row.number}`),
  ]);
  if (rows.length) keyboardRows.unshift([Markup.button.callback("🧹 Удалить все аккаунты", "rent:delete_all")]);
  keyboardRows.push([Markup.button.callback("⬅️ Назад", "rent:manage")]);
  await replaceOrReply(ctx, rows.length ? "<b>🗑 Удаление аккаунтов</b>" : "<b>Удалять нечего.</b>", {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard(keyboardRows).reply_markup,
  });
}

async function renderRentalsEditList(ctx: Ctx) {
  const rows = rentalRows();
  const keyboardRows = rows.map((row) => [
    Markup.button.callback(rentalListLabel(row), `rent:edit:${row.number}`),
  ]);
  keyboardRows.push([Markup.button.callback("⬅️ Назад", "rent:manage")]);
  await replaceOrReply(ctx, rows.length ? "<b>✏️ Выберите объявление</b>" : "<b>Редактировать нечего.</b>", {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard(keyboardRows).reply_markup,
  });
}

async function renderRentalEditFields(ctx: Ctx, number: number) {
  const rental = getRentalByNumber(number);
  if (!rental) {
    await renderRentalsEditList(ctx);
    return;
  }
  await replaceOrReply(ctx, `<b>✏️ ${escapeHtml(String(rental.title || `Аккаунт #${number}`))}</b>\n\nЧто изменить?`, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("Название", `rent:edit:${number}:title`)],
      [Markup.button.callback("Описание", `rent:edit:${number}:description`)],
      [Markup.button.callback("⬅️ Назад", "rent:edit")],
    ]).reply_markup,
  });
}

function removeRentalByNumber(number: number) {
  const stateData = appState();
  const before = stateData.rentals.length;
  const removed = stateData.rentals.find((row: any) => Number(row.number) === Number(number));
  stateData.rentals = stateData.rentals.filter((row: any) => Number(row.number) !== Number(number));
  if (removed) {
    stateData.guard_attempts = (stateData.guard_attempts as any[]).filter((row) => Number(row.rental_id) !== Number(removed.id));
    stateData.rent_request_messages = (stateData.rent_request_messages as any[]).filter((row) => Number(row.rental_id) !== Number(removed.id));
  }
  if (before !== stateData.rentals.length) saveState();
  return before - stateData.rentals.length;
}

function removeAllRentals() {
  const stateData = appState();
  const count = stateData.rentals.length;
  stateData.rentals = [];
  stateData.guard_attempts = [];
  stateData.rent_request_messages = [];
  if (count) saveState();
  return count;
}

function parseLoginPassword(raw: string) {
  const match = String(raw || "").trim().match(/^([^:\s]+)\s*:\s*(.+)$/);
  if (!match) return null;
  return { login: match[1].trim(), password: match[2].trim() };
}

function addRentalAccount(ownerUserId: number, title: string, description: string, mafilePath: string, login: string, password: string) {
  const rows = appState().rentals as any[];
  const row = {
    id: rows.reduce((max, item) => Math.max(max, Number(item.id || 0)), 0) + 1,
    number: nextRentalNumber(),
    owner_user_id: Number(ownerUserId),
    title,
    login,
    pass: password,
    guard_code: null,
    steam_id: null,
    steam_refresh_token: null,
    steam_login_secure: null,
    steam_login_secure_exp: null,
    steam_session_id: null,
    steam_browser_id: null,
    mafile_path: mafilePath,
    mafile_archive_path: mafilePath,
    description,
    is_busy: 0,
    rented_by_user_id: null,
  };
  rows.push(row);
  saveState();
  return row;
}

async function saveTelegramDocument(ctx: Ctx, document: any) {
  const fileName = String(document.file_name || `mafile_${Date.now()}.maFile`).replace(/[^\w.\-() ]+/g, "_");
  const link = await ctx.telegram.getFileLink(document.file_id);
  const response = await fetch(link.toString());
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  const dir = path.join(process.cwd(), "data", "rentals");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${Date.now()}_${fileName}`);
  await fs.writeFile(filePath, buffer);
  return { filePath, buffer };
}

function managersForRentals() {
  const roleRows = appState().user_roles as any[];
  const userIds = new Set<number>();
  for (const row of roleRows) {
    const role = normalizeRole(row.role);
    if (role === "HELPER" || role === "ADMIN") userIds.add(Number(row.user_id));
  }
  for (const user of appState().users as any[]) {
    if (ADMIN_IDS.includes(Number(user.tg_id || 0))) userIds.add(Number(user.id));
  }
  const managers = [...userIds]
    .map((id) => getUserById(id))
    .filter((user) => user && Number(user.is_banned || 0) !== 1 && Number(user.tg_id || 0));
  const seenTgIds = new Set<number>();
  return managers.filter((user) => {
    const tgId = Number(user.tg_id || 0);
    if (!tgId || seenTgIds.has(tgId)) return false;
    seenTgIds.add(tgId);
    return true;
  });
}

async function notifyRentalManagers(ctx: Ctx, rental: any, requester: any, discordUser?: any) {
  const managers = managersForRentals();
  const discordLine = discordUser
    ? `\nDiscord: <b>${escapeHtml(String(discordUser.discord_display_name || discordUser.discord_username || "-"))}</b> <code>${escapeHtml(String(discordUser.discord_user_id || "-"))}</code>`
    : "";
  const text =
    `<b>Заявка на аренду</b>\n\n` +
    `Пользователь: <b>${escapeHtml(userLabel(requester))}</b>\n` +
    `TG ID: <code>${escapeHtml(String(requester.tg_id || "-"))}</code>\n` +
    `${discordLine}\n` +
    `Аккаунт: <b>${escapeHtml(String(rental.title || `Аккаунт #${rental.number}`))} №${rental.number}</b>`;
  for (const manager of managers) {
    const sent = await ctx.telegram.sendMessage(Number(manager.tg_id), text, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ Одобрить", `rent:req:approve:${rental.number}:${requester.id}`),
          Markup.button.callback("❌ Отклонить", `rent:req:decline:${rental.number}:${requester.id}`),
        ],
      ]).reply_markup,
    }).catch((error: unknown) => {
      console.error(`[RENT REQUEST MANAGER SEND FAILED] rental=${rental.number} manager_tg=${manager.tg_id}`, error);
      return null;
    });
    if (sent?.message_id) {
      db.prepare("INSERT INTO RENT_REQUEST_MESSAGES (RENTAL_ID, USER_ID, ADMIN_TG_ID, MESSAGE_ID) VALUES (?, ?, ?, ?)").run(
        rental.id,
        requester.id,
        manager.tg_id,
        sent.message_id,
      );
    }
  }
  return managers.length;
}

async function sendRentalReportReminder(rental: any, reportDate: string) {
  const renter = getUserById(Number(rental.rented_by_user_id || 0));
  if (!renter?.tg_id) return false;
  if (Number(rental.rented_by_user_id || 0) !== Number(renter.id || 0)) return false;
  const report = reserveDailyRentReport(rental, renter, reportDate);
  if (!report) return false;

  const text =
    `<b>Пора предоставить отчет по аренде аккаунта №${rental.number}.</b>\n\n` +
    `Нажмите кнопку ниже и отправьте скрин списка игр.\n\n` +
    `<b>Срок: 24 часа с момента этого сообщения.</b>\n` +
    `Если отчет не будет отправлен 2 раза за 7 дней, аренда отменится автоматически.`;
  const sent = await bot.telegram.sendMessage(Number(renter.tg_id), text, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback("📸 Отправить отчет", `rent:report:upload:${report.id}`)]]).reply_markup,
  }).catch(() => null);
  if (!sent?.message_id) {
    releaseDailyRentReportReservation(rental, renter, report, reportDate);
    return false;
  }
  if (sent?.message_id) {
    rental.last_report_message_id = sent.message_id;
    saveState();
  }
  return true;
}

async function notifyRentalReportManagers(ctx: Ctx, report: any) {
  const rental = getRentalById(Number(report.rental_id));
  const renter = getUserById(Number(report.user_id));
  if (!rental || !renter) return 0;
  const text =
    `<b>Отчет по аренде</b>\n\n` +
    `Аккаунт: <b>№${rental.number}</b>\n` +
    `Пользователь: <b>${escapeHtml(userLabel(renter))}</b>\n` +
    `TG ID: <code>${escapeHtml(String(renter.tg_id || "-"))}</code>`;
  let sentCount = 0;
  for (const manager of managersForRentals()) {
    const sent = await ctx.telegram.sendPhoto(Number(manager.tg_id), String(report.file_id), {
      caption: text,
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ Одобрить", `rent:report:approve:${report.id}`),
          Markup.button.callback("❌ Отклонить", `rent:report:reject:${report.id}`),
        ],
      ]).reply_markup,
    }).catch((error: unknown) => {
      console.error(`[RENT REPORT MANAGER SEND FAILED] report=${report.id} rental=${rental.number} manager_tg=${manager.tg_id}`, error);
      return null;
    });
    if (sent) sentCount += 1;
  }
  return sentCount;
}

async function runRentReportTick() {
  if (rentReportTickInFlight) return;
  rentReportTickInFlight = true;
  try {
    const moscow = await moscowNowPartsFromTrustedSource();
  for (const rental of activeRentalRows()) {
    const deadline = String(rental.report_deadline_at || "");
    if (deadline && Date.parse(deadline) <= Date.now()) {
      const renter = getUserById(Number(rental.rented_by_user_id || 0));
      markExpiredRentReportAsMissed(rental, deadline);
      const misses = markRentalReportMiss(rental);
      rental.report_deadline_at = null;
      saveState();
      if (misses >= 2) {
        await cancelRentalWithSteamSessions(rental);
        if (renter?.tg_id) {
          await bot.telegram.sendMessage(
            Number(renter.tg_id),
            `<b>Аренда аккаунта №${rental.number} отменена автоматически.</b>\nОтчет не был предоставлен 2 раза за последние 7 дней.`,
            { parse_mode: "HTML" },
          ).catch(() => null);
        }
      } else if (renter?.tg_id) {
        await bot.telegram.sendMessage(
          Number(renter.tg_id),
          `<b>Отчет по аренде аккаунта №${rental.number} не был отправлен вовремя.</b>\nЭто первое нарушение за последние 7 дней. При втором пропуске аренда будет отменена автоматически.`,
          { parse_mode: "HTML" },
        ).catch(() => null);
      }
      continue;
    }
    if (
      moscow &&
      isRentReportRequestMinute(moscow) &&
      !isRentalStartedAfterTodayReportTime(rental, moscow.dateKey) &&
      String(rental.last_report_date || "") !== moscow.dateKey &&
      !findDailyRentReport(rental, moscow.dateKey)
    ) {
      await sendRentalReportReminder(rental, moscow.dateKey);
    }
  }
  } finally {
    rentReportTickInFlight = false;
  }
}

function startRentReportLoop() {
  if (rentReportLoopStarted) return;
  rentReportLoopStarted = true;
  setInterval(() => {
    runRentReportTick().catch((error) => console.error("[RENT REPORT LOOP ERROR]", error));
  }, RENT_REPORT_POLL_INTERVAL_MS);
  runRentReportTick().catch(() => null);
}

async function runRentDiscordBridgeTick(ctxLike?: Ctx) {
  if (typeof store.reloadNow === "function") {
    store.reloadNow();
  }
  const rows = rentDiscordPendingRows().filter((row) => String(row.status || "") === "CONFIRMED" && !row.processed_at);
  for (const row of rows) {
    row.status = "PROCESSING";
    row.updated_at = nowIso();
    saveState();
    const rental = getRentalByNumber(Number(row.rental_number || 0));
    const requester = getUserById(Number(row.tg_user_id || 0));
    if (!rental || !requester) {
      row.status = "FAILED";
      row.processed_at = nowIso();
      row.updated_at = nowIso();
      saveState();
      continue;
    }
    if (Number(rental.is_busy || 0) === 1 && Number(rental.rented_by_user_id || 0) !== Number(requester.id)) {
      row.status = "FAILED";
      row.processed_at = nowIso();
      row.updated_at = nowIso();
      saveState();
      if (requester.tg_id) {
        await bot.telegram.sendMessage(Number(requester.tg_id), "<b>Аккаунт уже занят. Выберите другой аккаунт.</b>", {
          parse_mode: "HTML",
        }).catch(() => null);
      }
      continue;
    }
    const bridgeCtx = ctxLike || ({ telegram: bot.telegram } as any);
    const notified = await notifyRentalManagers(bridgeCtx, rental, requester, row);
    row.status = "SENT";
    row.processed_at = nowIso();
    row.updated_at = nowIso();
    saveState();
    if (requester.tg_id) {
      state.delete(Number(requester.tg_id));
      await bot.telegram.sendMessage(
        Number(requester.tg_id),
        `<b>Discord подтвержден.</b>\nЗаявка по аккаунту №${rental.number} отправлена на рассмотрение.`,
        { parse_mode: "HTML" },
      ).catch(() => null);
    }
    logEvent(requester, "rentals", `discord_confirmed:${rental.number}:managers:${notified}`);
  }
}

function startRentDiscordBridgeLoop() {
  if (rentDiscordBridgeLoopStarted) return;
  rentDiscordBridgeLoopStarted = true;
  setInterval(() => {
    runRentDiscordBridgeTick().catch((error) => console.error("[RENT DISCORD BRIDGE ERROR]", error));
  }, 5_000);
  runRentDiscordBridgeTick().catch(() => null);
}

function guardAttemptFor(rentalId: number, userId: number) {
  return (appState().guard_attempts as any[]).find(
    (row) => Number(row.rental_id) === Number(rentalId) && Number(row.user_id) === Number(userId),
  ) || null;
}

function steamGuardCodeFromSharedSecret(sharedSecret: string, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const alphabet = "23456789BCDFGHJKMNPQRTVWXY";
  const secret = Buffer.from(sharedSecret, "base64");
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(Math.floor(timestampSeconds / 30), 4);
  const hmac = crypto.createHmac("sha1", secret).update(timeBuffer).digest();
  const start = hmac[19] & 0x0f;
  let codePoint = hmac.readUInt32BE(start) & 0x7fffffff;
  let code = "";
  for (let index = 0; index < 5; index += 1) {
    code += alphabet[codePoint % alphabet.length];
    codePoint = Math.floor(codePoint / alphabet.length);
  }
  return code;
}

async function generateSteamGuardCodeFromRental(rental: any) {
  const mafilePath = String(rental.mafile_path || rental.mafile_archive_path || "").trim();
  if (!mafilePath) return null;
  try {
    const raw = await fs.readFile(mafilePath, "utf8");
    const parsed = JSON.parse(raw);
    const sharedSecret = String(parsed.shared_secret || parsed.SharedSecret || "").trim();
    if (!sharedSecret) return null;
    return steamGuardCodeFromSharedSecret(sharedSecret);
  } catch {
    return null;
  }
}

async function querySteamServerTime() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch("https://api.steampowered.com/ITwoFactorService/QueryTime/v1/?steamid=0", {
      headers: { "user-agent": "Mozilla/5.0" },
      signal: controller.signal,
    });
    if (!response.ok) return Math.floor(Date.now() / 1000);
    const parsed = await response.json().catch(() => null);
    return Number(parsed?.response?.server_time || parsed?.server_time || Math.floor(Date.now() / 1000));
  } catch {
    return Math.floor(Date.now() / 1000);
  } finally {
    clearTimeout(timeout);
  }
}

async function generateSteamGuardCodeFromRentalAtSteamTime(rental: any) {
  const mafilePath = String(rental.mafile_path || rental.mafile_archive_path || "").trim();
  if (!mafilePath) return null;
  try {
    const raw = await fs.readFile(mafilePath, "utf8");
    const parsed = JSON.parse(raw);
    const sharedSecret = String(parsed.shared_secret || parsed.SharedSecret || "").trim();
    if (!sharedSecret) return null;
    return steamGuardCodeFromSharedSecret(sharedSecret, await querySteamServerTime());
  } catch {
    return null;
  }
}

function ensureGuardAttempt(rentalId: number, userId: number, attemptsLeft: number) {
  const rows = appState().guard_attempts as any[];
  const row = guardAttemptFor(rentalId, userId);
  if (row) {
    row.attempts_left = attemptsLeft;
  } else {
    rows.push({
      id: rows.reduce((max, item) => Math.max(max, Number(item.id || 0)), 0) + 1,
      rental_id: Number(rentalId),
      user_id: Number(userId),
      attempts_left: attemptsLeft,
    });
  }
  saveState();
}

async function clearRentalRequestMessages(ctx: Ctx, rental: any, requester: any) {
  const rows = db.prepare("SELECT ADMIN_TG_ID, MESSAGE_ID FROM RENT_REQUEST_MESSAGES WHERE RENTAL_ID = ? AND USER_ID = ?").all(rental.id, requester.id) as any[];
  for (const row of rows) {
    await ctx.telegram.deleteMessage(Number(row.admin_tg_id), Number(row.message_id)).catch(() => null);
  }
  db.prepare("DELETE FROM RENT_REQUEST_MESSAGES WHERE RENTAL_ID = ? AND USER_ID = ?").run(rental.id, requester.id);
}

async function renderOnlineWatchList(ctx: Ctx, user: any) {
  const rows = getOnlineWatchRowsForUser(user.id);
  const text = rows.length
    ? `<b>Аккаунты на чекере:</b>\n\n${rows
        .map((row, index) => {
          const comment = String(row.comment || "").trim();
          return `${index + 1}. <a href="${escapeHtml(String(row.profile_url))}">Профиль</a>${comment ? ` — <b>${escapeHtml(comment)}</b>` : ""}`;
        })
        .join("\n")}`
    : "<b>Список чекера пуст.</b>";

  const keyboardRows = rows.length
    ? [
        [Markup.button.callback("🧹 Очистить все", "online_watch:clear")],
        [Markup.button.callback("⬅️ Назад", "online_watch:menu")],
      ]
    : [[Markup.button.callback("⬅️ Назад", "online_watch:menu")]];

  await replaceOrReply(ctx, text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: Markup.inlineKeyboard(keyboardRows).reply_markup,
  });
}

async function clearOnlineWatchRowsForUser(ctx: Ctx, user: any) {
  const stateData = appState();
  const rows = getOnlineWatchRowsForUser(user.id);
  const ids = new Set(rows.map((row) => Number(row.id)));
  stateData.online_watch = (stateData.online_watch as any[]).filter((row) => !ids.has(Number(row.id)));
  for (const id of ids) {
    syncStateForRemovedWatch(id);
  }
  saveState();
  await replaceOrReply(ctx, `<b>Чекер очищен.</b>\nУдалено аккаунтов: <b>${ids.size}</b>`, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "online_watch:menu")]]).reply_markup,
  });
}

async function handleOnlineWatchProfile(ctx: Ctx, me: any, text: string) {
  const normalized = normalizeProfileInput(text.trim());
  if (!normalized) {
    await ctx.reply(
      "Неверный формат ссылки.\nУкажите Steam ID (16 цифр, начинается с 7) или ссылку:\nhttps://steamcommunity.com/profiles/76561199077889738/\nhttps://steamcommunity.com/id/ktese/\nhttps://my.steamchina.com/profiles/76561199881567552/\nhttps://my.steamchina.com/id/ktese/",
    );
    return;
  }

  const existing = db.prepare("SELECT id FROM online_watch WHERE user_id = ? AND profile_url = ?").get(me.id, normalized.profileUrl) as any;
  if (existing?.id) {
    db.prepare("DELETE FROM online_watch WHERE id = ?").run(existing.id);
    syncStateForRemovedWatch(Number(existing.id));
    state.delete(ctx.from.id);
    await sendCleanPrompt(
      ctx,
      `<tg-emoji emoji-id="5240187442052510372">🔔</tg-emoji> <b>Чекер отключен для этого <a href="${escapeHtml(normalized.profileUrl)}">профиля</a>.</b>`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
    return;
  }

  state.set(ctx.from.id, { mode: "online_watch_comment_input", payload: { profileUrl: normalized.profileUrl } });
  await sendCleanPrompt(
    ctx,
    `<tg-emoji emoji-id="5240026767325961445">🔗</tg-emoji> Профиль: <b>${escapeHtml(normalized.profileUrl)}</b>\n\n<tg-emoji emoji-id="5240446651918753852">💬</tg-emoji> Пришлите комментарий для этого профиля.`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );
}

async function handleOnlineWatchComment(ctx: Ctx, me: any, flow: Extract<UserFlow, { mode: "online_watch_comment_input" }>, text: string) {
  const profileUrl = String(flow.payload.profileUrl || "");
  if (!profileUrl) {
    state.delete(ctx.from.id);
    await ctx.reply("Профиль потерялся, начните заново.");
    return;
  }
  const comment = text.trim() === "-" ? null : text.trim();
  db.prepare("INSERT INTO online_watch (user_id, profile_url, comment) VALUES (?, ?, ?)").run(me.id, profileUrl, comment);
  state.delete(ctx.from.id);
  uiPromptMsg.delete(ctx.from.id);
  startOnlineWatchLoop();
  await ctx
    .reply(
      `<b>Отслеживание профиля успешно включено.</b>\n\nКак только профиль появится онлайн, бот отправит уведомление.`,
      { parse_mode: "HTML" },
    )
    .catch(() => null);
}

async function syncBotCommands() {
  await bot.telegram
    .setMyCommands([
      { command: "start", description: "Главное меню" },
      { command: "admin", description: "Админка" },
    ])
    .catch(() => null);
}

async function prepareSteamPageForFastRender(page: any) {
  if (page.__fastRenderPrepared) return;
  await page.route("**/*", (route: any) => {
    const request = route.request();
    const type = request.resourceType();
    const url = request.url().toLowerCase();
    if (type === "font" && (url.startsWith("file:") || url.includes("steamstatic.com/public/shared/fonts/"))) {
      return route.continue();
    }
    if (STEAM_ABORT_RESOURCE_TYPES.has(type)) return route.abort();
    if (type === "image" && (url.includes("/videos/") || url.includes("broadcast"))) return route.abort();
    return route.continue();
  });
  page.__fastRenderPrepared = true;
}

async function ensureSteamRendererReady() {
  if (steamReadyPromise) {
    await steamReadyPromise;
    return;
  }

  steamReadyPromise = (async () => {
    const { chromium } = (await import("playwright")) as any;
    if (!steamBrowser) {
      steamBrowser = await chromium.launch({ headless: true });
    }
    if (!steamPage || steamPage.isClosed?.()) {
      steamPage = await steamBrowser.newPage({ viewport: { width: 1920, height: 1080 } });
      await prepareSteamPageForFastRender(steamPage);
      await steamPage.goto("about:blank").catch(() => null);
    }
    if (!steamAddFriendPage || steamAddFriendPage.isClosed?.()) {
      steamAddFriendPage = await steamBrowser.newPage({ viewport: { width: 1920, height: 1080 } });
      await prepareSteamPageForFastRender(steamAddFriendPage);
      await steamAddFriendPage.goto("about:blank").catch(() => null);
    }
    if (!steamSourcePage || steamSourcePage.isClosed?.()) {
      steamSourcePage = await steamBrowser.newPage({ viewport: { width: 1920, height: 1080 } });
      await prepareSteamPageForFastRender(steamSourcePage);
      await steamSourcePage.goto("about:blank").catch(() => null);
    }
    if (!steamTemplatePage || steamTemplatePage.isClosed?.()) {
      steamTemplatePage = await steamBrowser.newPage({ viewport: { width: 1920, height: 1080 } });
      await prepareSteamPageForFastRender(steamTemplatePage);
      await steamTemplatePage.goto("about:blank").catch(() => null);
    }
  })();

  await steamReadyPromise;
}

async function ensureSteamProfileQuickLoaded(page: any) {
  await page.waitForLoadState("domcontentloaded", { timeout: 1200 }).catch(() => null);
  await Promise.race([
    (async () => {
      await page.waitForLoadState("networkidle", { timeout: 4200 }).catch(() => null);
      await page.waitForTimeout(220).catch(() => null);
    })(),
    page.waitForTimeout(4200),
  ]).catch(() => null);
  await page.waitForSelector(".profile_page, .responsive_page_template_content", { timeout: 500 }).catch(() => null);
}

async function ensureSteamProfileFullyLoaded(page: any) {
  await page.waitForLoadState("domcontentloaded", { timeout: 2500 }).catch(() => null);
  await page
    .evaluate(async () => {
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const maxY = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - window.innerHeight;
      for (let i = 1; i <= 4; i += 1) {
        window.scrollTo(0, Math.floor((maxY * i) / 4));
        await sleep(70);
      }
      window.scrollTo(0, 0);
    })
    .catch(() => null);
  await page
    .waitForFunction(
      () => {
        const images = Array.from(document.querySelectorAll("img")) as HTMLImageElement[];
        if (!images.length) return false;
        const relevant = images.filter((img) => {
          const src = img.currentSrc || img.src || "";
          return src.includes("steamstatic.com") || src.includes("steamcommunity");
        });
        const set = relevant.length ? relevant : images;
        const loaded = set.filter((img) => img.complete && (img.naturalWidth || 0) > 0).length;
        return loaded / set.length >= 0.9;
      },
      { timeout: 2200, polling: 120 },
    )
    .catch(() => null);
}

async function warmupSteamRenderer() {
  try {
    await ensureSteamRendererReady();
    const pages = [steamPage, steamAddFriendPage, steamSourcePage].filter(Boolean);
    await Promise.all(
      pages.map((page: any) =>
        page.goto("https://steamcommunity.com/", { waitUntil: "domcontentloaded", timeout: 4500 }).catch(() => null),
      ),
    );
  } catch {}
}

async function cleanupSteamTempDirs() {
  try {
    const entries = await fs.readdir(process.cwd(), { withFileTypes: true });
    const targets = entries
      .filter((entry) => entry.isDirectory() && /^\.tmp-steam/i.test(entry.name))
      .map((entry) => path.join(process.cwd(), entry.name));
    await Promise.all(targets.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => null)));
  } catch {}
}

async function closeSteamRenderer() {
  await steamBrowser?.close().catch(() => null);
  steamBrowser = null;
  steamPage = null;
  steamAddFriendPage = null;
  steamSourcePage = null;
  steamTemplatePage = null;
  steamReadyPromise = null;
}

async function loadInvitePageData(inviteUrl: string): Promise<InvitePageData> {
  const cached = invitePageCache.get(inviteUrl);
  if (cached && Date.now() - cached.updatedAt < 10 * 60 * 1000) {
    return {
      name: cached.name,
      avatarFull: cached.avatarFull,
      avatarMedium: cached.avatarMedium,
      avatarFrame: cached.avatarFrame,
      miniprofile: cached.miniprofile,
      profileUrl: cached.profileUrl,
    };
  }

  try {
    await ensureSteamRendererReady();
    await steamSourcePage.goto(inviteUrl, { waitUntil: "domcontentloaded", timeout: 12000 });
    await steamSourcePage
      .waitForSelector(".actual_persona_name, .persona_name, .playerAvatarAutoSizeInner", { timeout: 1800 })
      .catch(() => null);
    const parsed = (await steamSourcePage.evaluate(() => {
      const name =
        (document.querySelector(".actual_persona_name") as HTMLElement | null)?.innerText?.trim() ||
        (document.querySelector(".persona_name .actual_persona_name") as HTMLElement | null)?.innerText?.trim() ||
        "";
      const avatarWrap = (document.querySelector(".playerAvatarAutoSizeInner") as HTMLElement | null) || null;
      const avatarImg =
        (avatarWrap?.querySelector("img[srcset*='_full']") as HTMLImageElement | null) ||
        (avatarWrap?.querySelector("img[src*='_full']") as HTMLImageElement | null) ||
        (avatarWrap?.querySelector("img[srcset*='avatar.']") as HTMLImageElement | null) ||
        (avatarWrap?.querySelector("img[src*='avatar.']") as HTMLImageElement | null) ||
        (avatarWrap?.querySelector("img") as HTMLImageElement | null) ||
        null;
      const avatarSrc = avatarImg?.getAttribute("srcset") || avatarImg?.getAttribute("src") || null;
      const frameSrc =
        (avatarWrap?.querySelector(".profile_avatar_frame img") as HTMLImageElement | null)?.getAttribute("src") ||
        (avatarWrap?.querySelector(".profile_avatar_frame source") as HTMLSourceElement | null)?.getAttribute("srcset") ||
        null;
      const miniprofile =
        (document.querySelector("[data-miniprofile]") as HTMLElement | null)?.getAttribute("data-miniprofile") ||
        "";
      return {
        name: String(name || "").trim(),
        avatarSrc: String(avatarSrc || "").trim(),
        frameSrc: String(frameSrc || "").trim(),
        miniprofile: String(miniprofile || "").trim(),
        profileUrl:
          String(
            (document.querySelector(".actual_persona_name") as HTMLElement | null)?.closest("a")?.getAttribute("href") ||
              (document.querySelector(".persona_name a") as HTMLAnchorElement | null)?.href ||
              "",
          ).trim(),
      };
    })) as any;

    const toAbs = (raw: string | null) => {
      if (!raw) return null;
      const clean = String(raw).split(",")[0]?.replace(/\s+\d+x$/i, "").trim();
      try {
        return new URL(clean, inviteUrl).toString();
      } catch {
        return clean;
      }
    };

    const name = String(parsed?.name || "").trim();
    if (name && !/^sign\s*in$/i.test(name)) {
      const avatarFull = toAbs(parsed.avatarSrc || null) || STEAM_FRIEND_FALLBACK_AVATAR_URL;
      const result = {
        name,
        avatarFull,
        avatarMedium: avatarFull ? avatarFull.replace(/_full\.(jpg|png|webp)$/i, "_medium.$1") : null,
        avatarFrame: toAbs(parsed.frameSrc || null),
        miniprofile: String(parsed.miniprofile || ""),
        profileUrl: toAbs(parsed.profileUrl || null),
      };
      invitePageCache.set(inviteUrl, { ...result, updatedAt: Date.now() });
      return result;
    }
  } catch {}

  const fallback = {
    name: "Cute",
    avatarFull: STEAM_FRIEND_FALLBACK_AVATAR_URL,
    avatarMedium: STEAM_FRIEND_FALLBACK_AVATAR_URL.replace(/_full\.jpg$/i, "_medium.jpg"),
    avatarFrame: null,
    miniprofile: "",
    profileUrl: inviteUrl,
  };
  invitePageCache.set(inviteUrl, { ...fallback, updatedAt: Date.now() });
  return fallback;
}

const PROFILE_ACTIONS_HTML = `<a role="button" id="btn_add_friend" class="btn_profile_action btn_medium" href="javascript:void(0)"><span>Add Friend</span></a>
<span role="button" class="btn_profile_action btn_medium" id="profile_action_dropdown_link"><span>More... <img src="https://community.fastly.steamstatic.com/public/images/profile/profile_action_dropdown.png"></span></span>`;
const ADD_FRIEND_ERROR_MODAL_HTML = `<div class="newmodal" style="position: fixed; z-index: 1000; max-width: 841px; left: 210px; top: 338px;"><div class="modal_top_bar"></div><div class="newmodal_header_border"><div class="newmodal_header"><div class="newmodal_close"></div><div class="title_text">Add Friend</div></div></div><div class="newmodal_content_border"><div class="newmodal_content" style="max-height: 726px;"><div>Error adding friend. Please try again.</div><div class="newmodal_buttons"><div class="btn_grey_steamui btn_medium"><span>OK</span></div></div></div></div></div>`;
const STEAM_GUARD_ERROR_MODAL_HTML = `<div class="newmodal" style="position: fixed; z-index: 1000; max-width: 841px; left: 210px; top: 338px;"><div class="modal_top_bar"></div><div class="newmodal_header_border"><div class="newmodal_header"><div class="newmodal_close"></div><div class="title_text">Add Friend</div></div></div><div class="newmodal_content_border"><div class="newmodal_content" style="max-height: 726px;"><div>Error adding friend. This user is required to have Steam Guard enabled before they can be added as a friend.</div><div class="newmodal_buttons"><div class="btn_grey_steamui btn_medium"><span>OK</span></div></div></div></div></div>`;
const ACCOUNT_BLOCKED_MODAL_HTML = `<div class="newmodal" style="position: fixed; z-index: 1000; max-width: 841px; left: 189px; top: 317px;"><div class="modal_top_bar"></div><div class="newmodal_header_border"><div class="newmodal_header"><div class="newmodal_close"></div><div class="title_text">Add Friend</div></div></div><div class="newmodal_content_border"><div class="newmodal_content" style="max-height: 726px;"><div>The account has been blocked and is currently being checked by Steam Support.</div><div class="newmodal_buttons"><div class="btn_grey_steamui btn_medium"><span>OK</span></div></div></div></div></div>`;
const ADD_FRIEND_INVITE_BANNER_HTML = `<div class="invite_banner" id="invite_banner"><div class="invite_ctn"><div class="header">Invitation to connect</div><div class="content"><p>You have been invited to be friends on Steam!</p><div class="invite_banner_actions"><a class="btn_profile_action btn_medium" href="#"><span>Add As Friend</span></a><a class="btn_profile_action btn_medium" href="#"><span>Ignore</span></a></div></div></div></div>`;

async function sizeSteamTemplatePageFromBackground(page: any, fallback: { w: number; h: number }) {
  await page
    .waitForFunction(
      () => {
        const bg = document.querySelector(".bg") as HTMLImageElement | null;
        return Boolean(bg && bg.complete && bg.naturalWidth > 0 && bg.naturalHeight > 0);
      },
      { timeout: 5000, polling: 100 },
    )
    .catch(() => null);

  const dims = await page.evaluate((fallbackSize: { w: number; h: number }) => {
    const bg = document.querySelector(".bg") as HTMLImageElement | null;
    const w = bg?.naturalWidth || fallbackSize.w;
    const h = bg?.naturalHeight || fallbackSize.h;
    document.documentElement.style.width = `${w}px`;
    document.documentElement.style.height = `${h}px`;
    document.body.style.width = `${w}px`;
    document.body.style.height = `${h}px`;
    if (bg) {
      bg.style.width = `${w}px`;
      bg.style.height = `${h}px`;
    }
    return { w, h };
  }, fallback);
  await page.setViewportSize({ width: dims.w, height: dims.h });
  return dims;
}

async function makeSteamProfileScreenshot(
  profileUrl: string,
  options?: {
    includeTopBar?: boolean;
    headerInviteUrl?: string;
    showAddFriendErrorModal?: boolean;
    showAddFriendInviteBanner?: boolean;
    showAccountBlockedModal?: boolean;
    addFriendErrorTextVariant?: "default" | "steam_guard";
  },
) {
  const task = async () => {
    const isAddFriendRender = Boolean(options?.showAddFriendErrorModal || options?.showAddFriendInviteBanner);
    const screenshotClip = options?.includeTopBar ? STEAM_SCREENSHOT_CLIP_WITH_HEADER : STEAM_SCREENSHOT_CLIP_DEFAULT;
    await ensureSteamRendererReady();
    const page = isAddFriendRender ? steamAddFriendPage : steamPage;
    const tmpDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-steam-profile-"));
    const screenshotPath = path.join(tmpDir, `profile_${Date.now()}.png`);
    const headerPromise = options?.headerInviteUrl ? loadInvitePageData(options.headerInviteUrl) : Promise.resolve(null);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 12000 });
    if (isAddFriendRender) {
      await ensureSteamProfileQuickLoaded(page);
    } else {
      await ensureSteamProfileFullyLoaded(page);
    }
    const authenticatedHeader = await headerPromise;
    if (authenticatedHeader) {
      await page.evaluate((data: { name: string; avatarFull: string }) => {
        const currentHeader = document.querySelector("#global_header") as HTMLElement | null;
        const content = currentHeader?.querySelector(":scope > .content") as HTMLElement | null;
        const navigation = currentHeader?.querySelector(".supernav_container") as HTMLElement | null;
        const actions = currentHeader?.querySelector("#global_actions") as HTMLElement | null;
        if (!currentHeader || !content || !navigation || !actions) throw new Error("Unable to apply authenticated Steam header");

        navigation.innerHTML = `
          <a class="menuitem supernav" href="https://store.steampowered.com/">STORE</a>
          <a class="menuitem supernav" href="https://steamcommunity.com/">COMMUNITY</a>
          <a class="menuitem supernav supernav_active username" href="https://steamcommunity.com/my/"></a>
          <a class="menuitem" href="https://steamcommunity.com/chat/">CHAT</a>
          <a class="menuitem" href="https://help.steampowered.com/en/">SUPPORT</a>
        `;
        const username = navigation.querySelector(".username") as HTMLElement | null;
        if (username) username.textContent = data.name;

        actions.innerHTML = `
          <div role="navigation" id="global_action_menu" aria-label="Account Menu">
            <a class="header_installsteam_btn header_installsteam_btn_gray" href="https://store.steampowered.com/about/">
              <div class="header_installsteam_btn_content">Install Steam</div>
            </a>
            <div id="header_notification_area">
              <button id="green_envelope_menu_root" class="_1jW5_Ycv6jGKu28A1OSIQK _2Hpe0_DGY0TBz45Lg0zUr9">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" fill="none" class="_13fwmIK8Ajo0qndUS5zb7E" aria-label="Notifications">
                  <g class="SVGIcon_Notification">
                    <path fill-rule="evenodd" clip-rule="evenodd" d="M32 24V26H4V24L8 19V12C8 9.34784 9.05357 6.8043 10.9289 4.92893C12.8043 3.05357 15.3478 2 18 2C20.6522 2 23.1957 3.05357 25.0711 4.92893C26.9464 6.8043 28 9.34784 28 12V19L32 24Z" fill="currentColor"></path>
                    <path class="SVGIcon_Notification_Uvula" fill-rule="evenodd" clip-rule="evenodd" d="M18 34C19.2396 33.9986 20.4483 33.6133 21.46 32.897C22.4718 32.1807 23.2368 31.1687 23.65 30H12.35C12.7632 31.1687 13.5282 32.1807 14.54 32.897C15.5517 33.6133 16.7604 33.9986 18 34Z" fill="currentColor"></path>
                  </g>
                </svg>
              </button>
            </div>
            <button class="pulldown global_action_link persona_name_text_content" id="account_pulldown"></button>
            <div id="header_wallet_ctn">
              <a class="global_action_link" id="header_wallet_balance" href="https://store.steampowered.com/account/store_transactions/">$ 0.12</a>
            </div>
          </div>
          <a href="https://steamcommunity.com/my/" class="user_avatar playerAvatar online" aria-label="View your profile">
            <img alt="">
          </a>
        `;
        const accountName = actions.querySelector("#account_pulldown") as HTMLElement | null;
        if (accountName) accountName.textContent = data.name;
        const avatar = actions.querySelector(".user_avatar img") as HTMLImageElement | null;
        if (avatar) {
          avatar.src = data.avatarFull;
          avatar.srcset = data.avatarFull;
          avatar.alt = data.name;
        }

        document.querySelector("#codex-authenticated-header-style")?.remove();
        const style = document.createElement("style");
        style.id = "codex-authenticated-header-style";
        style.textContent = `
          div#global_header .content {
            position: relative !important;
            width: 940px !important;
            min-width: 940px !important;
            max-width: 940px !important;
            height: 104px !important;
            margin: 0 auto !important;
          }
          div#global_header div.logo {
            float: left !important;
            padding-top: 30px !important;
            margin-right: 40px !important;
            width: 176px !important;
            height: 44px !important;
          }
          #global_header .supernav_container {
            position: absolute !important;
            left: 200px !important;
            top: 0 !important;
          }
          div#global_actions {
            position: absolute !important;
            right: 0 !important;
            top: 6px !important;
            width: 268px !important;
            height: 46px !important;
            line-height: 21px !important;
            z-index: 401 !important;
            white-space: nowrap !important;
            color: #b8b6b4 !important;
            font-size: 11px !important;
          }
          div#global_actions #global_action_menu {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            display: block !important;
            width: 230px !important;
            height: 46px !important;
            line-height: 24px !important;
          }
          div#global_actions .header_installsteam_btn {
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            right: auto !important;
            width: 111px !important;
            height: 22px !important;
            line-height: 22px !important;
          }
          div#global_actions .header_installsteam_btn_content {
            height: 22px !important;
            line-height: 22px !important;
          }
          div#global_actions #header_notification_area {
            position: absolute !important;
            top: 0 !important;
            left: 116px !important;
            right: auto !important;
            display: block !important;
            width: 44px !important;
            height: 24px !important;
            line-height: 24px !important;
          }
          div#global_actions #green_envelope_menu_root {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            width: 44px !important;
            height: 24px !important;
            min-width: 44px !important;
            min-height: 24px !important;
            margin: 0 !important;
            padding: 0 !important;
            border: 0 !important;
            border-radius: 0 !important;
            background: #5c7e10 !important;
            color: #dfe3da !important;
            transform: none !important;
          }
          div#global_actions #green_envelope_menu_root svg {
            width: 14px !important;
            height: 14px !important;
            margin: 0 !important;
            color: #ffffff !important;
            fill: none !important;
          }
          div#global_actions #account_pulldown {
            position: absolute !important;
            top: 1px !important;
            left: 168px !important;
            right: auto !important;
            height: 24px !important;
            line-height: 24px !important;
            padding: 0 10px 0 0 !important;
            max-width: 61px !important;
            overflow: hidden !important;
            text-overflow: ellipsis !important;
            border: none !important;
            background: transparent !important;
            color: #b8b6b4 !important;
            font: inherit !important;
          }
          div#global_actions #account_pulldown::after {
            content: "" !important;
            position: absolute !important;
            right: 0 !important;
            top: 10px !important;
            border-left: 4px solid transparent !important;
            border-right: 4px solid transparent !important;
            border-top: 4px solid #b8b6b4 !important;
          }
          div#global_actions #header_wallet_ctn {
            position: absolute !important;
            top: 28px !important;
            left: 176px !important;
            right: auto !important;
            padding: 0 !important;
            margin: 0 !important;
            text-align: left !important;
            line-height: 13px !important;
          }
          div#global_actions #header_wallet_balance {
            display: block !important;
            padding: 0 !important;
            line-height: 13px !important;
          }
          div#global_actions .user_avatar {
            position: absolute !important;
            top: 0 !important;
            left: 234px !important;
            right: auto !important;
            display: block !important;
            width: 34px !important;
            height: 34px !important;
            margin: 0 !important;
          }
          div#global_actions .user_avatar img {
            display: block !important;
            width: 32px !important;
            height: 32px !important;
          }
          .responsive_header, .responsive_page_menu_ctn, .responsive_page_content_overlay {
            display: none !important;
          }
        `;
        document.head.appendChild(style);
      }, {
        name: authenticatedHeader.name,
        avatarFull: authenticatedHeader.avatarFull || STEAM_FRIEND_FALLBACK_AVATAR_URL,
      });
      await page
        .waitForFunction(() => {
          const signIn = document.querySelector("#global_header .global_action_link[href*='login']");
          const avatar = document.querySelector("#global_actions .user_avatar img") as HTMLImageElement | null;
          return Boolean(!signIn && avatar && avatar.complete && avatar.naturalWidth > 0);
        }, { timeout: 2000, polling: 60 })
        .catch(() => null);
    }
    await page.evaluate(({ actionsHtml }: { actionsHtml: string }) => {
      const actions = document.querySelector(".profile_header_actions") as HTMLElement | null;
      if (actions) actions.innerHTML = actionsHtml;
    }, { actionsHtml: PROFILE_ACTIONS_HTML });

    if (options?.showAddFriendInviteBanner) {
      await page.evaluate(({ bannerHtml }: { bannerHtml: string }) => {
        document.querySelector("#invite_banner")?.remove();
        document.querySelector(".responsive_page_template_content")?.insertAdjacentHTML("afterbegin", bannerHtml);
      }, { bannerHtml: ADD_FRIEND_INVITE_BANNER_HTML });
    }

    if (options?.showAddFriendErrorModal || options?.showAccountBlockedModal) {
      const modalHtml = options.showAccountBlockedModal
        ? ACCOUNT_BLOCKED_MODAL_HTML
        : options?.addFriendErrorTextVariant === "steam_guard"
          ? STEAM_GUARD_ERROR_MODAL_HTML
          : ADD_FRIEND_ERROR_MODAL_HTML;
      await page.evaluate(
        ({ html, clip, dimTopBar }: { html: string; clip: { x: number; y: number; width: number; height: number }; dimTopBar: boolean }) => {
          document.querySelector(".newmodal_background")?.remove();
          document.querySelector(".newmodal")?.remove();
          document.querySelector("#codex-modal-no-shadow")?.remove();
          const overlay = document.createElement("div");
          overlay.className = "newmodal_background";
          overlay.style.opacity = "0.8";
          overlay.style.top = dimTopBar ? "0" : `${clip.y}px`;
          overlay.style.height = dimTopBar ? "100%" : `calc(100% - ${clip.y}px)`;
          document.body.appendChild(overlay);
          document.body.insertAdjacentHTML("beforeend", html);
          const style = document.createElement("style");
          style.id = "codex-modal-no-shadow";
          style.textContent = `
            .newmodal_content_border {
              box-shadow: none !important;
              filter: none !important;
              padding-bottom: 0 !important;
            }
            .newmodal_content_border::before,
            .newmodal_content_border::after {
              display: none !important;
              content: none !important;
              box-shadow: none !important;
            }
          `;
          document.head.appendChild(style);
          const modal = document.querySelector(".newmodal") as HTMLElement | null;
          if (modal) {
            modal.style.position = "absolute";
            modal.style.margin = "0";
            modal.style.right = "auto";
            modal.style.bottom = "auto";
            modal.style.transform = "none";
            const modalWidth = modal.offsetWidth || modal.getBoundingClientRect().width || 500;
            const modalHeight = modal.offsetHeight || modal.getBoundingClientRect().height || 168;
            const left = clip.x + Math.round((clip.width - modalWidth) / 2);
            const top = clip.y + Math.round((clip.height - modalHeight) / 2);
            modal.style.left = `${left}px`;
            modal.style.top = `${top}px`;
          }
        },
        { html: modalHtml, clip: screenshotClip, dimTopBar: Boolean(authenticatedHeader) },
      );
    }

    await page.waitForTimeout(55);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: screenshotPath, clip: screenshotClip });
    return screenshotPath;
  };

  const run = steamRenderChain.then(task, task);
  steamRenderChain = run.then(() => undefined, () => undefined);
  return run;
}

const STEAM_TEMPLATE_HTML_PATH = process.env.STEAM_TEMPLATE_HTML_PATH || "";

async function resolveSteamFriendTemplatePath() {
  if (STEAM_TEMPLATE_HTML_PATH) return STEAM_TEMPLATE_HTML_PATH;
  const templateDir = path.join(process.cwd(), "src", "templates");
  const files = await fs.readdir(templateDir);
  const picked = files.find((file) => /^Ryan Cooper .*\.html$/i.test(file));
  if (!picked) {
    throw new Error("Steam friend template HTML not found");
  }
  return path.join(templateDir, picked);
}

async function makeSteamFriendPageFromTemplateScreenshot(
  inviteUrl: string,
  options?: { variant?: "normal" | "not_found"; friendCode?: string; showRegionMismatch?: boolean },
) {
  const task = async () => {
    await ensureSteamRendererReady();
    const profile = await loadInvitePageData(inviteUrl);
    const templatePath = await resolveSteamFriendTemplatePath();
    const templateDir = path.dirname(templatePath);
    const templateBase = path.basename(templatePath, path.extname(templatePath));
    const filesDir = path.join(templateDir, `${templateBase}_files`).replace(/\\/g, "/");
    const templateRaw = await fs.readFile(templatePath, "utf8");
    const templateHtml = templateRaw.replace(/(["'(])(?:\.\/)?[^"'()]*_files\//g, `$1file:///${filesDir}/`);

    const tmpDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-steam-template-"));
    const tempHtmlPath = path.join(tmpDir, `friend_${Date.now()}.html`);
    const screenshotPath = path.join(tmpDir, `friend_${Date.now()}.png`);
    await fs.writeFile(tempHtmlPath, templateHtml, "utf8");
    await steamTemplatePage.setViewportSize(STEAM_FRIEND_TEMPLATE_VIEWPORT);
    await steamTemplatePage.goto(`file:///${tempHtmlPath.replace(/\\/g, "/")}`, { waitUntil: "domcontentloaded", timeout: 12000 });
    await steamTemplatePage.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => null);
    await steamTemplatePage.evaluate(() => document.fonts?.ready).catch(() => null);
    await steamTemplatePage.waitForTimeout(220);

    await steamTemplatePage.evaluate(
      (data: {
        name: string;
        avatarFull: string | null;
        avatarFrame: string | null;
        miniprofile: string;
        profileUrl: string | null;
        fallbackAvatarFull: string;
        friendCode: string;
        inviteLink: string;
        variant: "normal" | "not_found";
        showRegionMismatch: boolean;
      }) => {
        const setText = (selector: string, value: string) => {
          const element = document.querySelector(selector);
          if (element) element.textContent = value;
        };
        const setAttr = (selector: string, attr: string, value: string | null) => {
          if (!value) return;
          const element = document.querySelector(selector) as HTMLElement | null;
          if (element) element.setAttribute(attr, value);
        };

        document.documentElement.classList.add("responsive", "DesktopUI");
        document.documentElement.classList.remove("tablet", "mobile", "touch", "GamepadMode");
        document.body.classList.add("responsive_page");
        document.body.style.minWidth = "1920px";
        document.body.style.width = "1920px";
        document.body.style.margin = "0";
        document.body.style.overflowX = "hidden";

        const style = document.createElement("style");
        style.id = "codex-desktop-friend-render";
        style.textContent = `
          html, body { min-width: 1920px !important; width: 1920px !important; }
          .responsive_header,
          .responsive_page_menu_ctn,
          .responsive_local_menu_tab,
          .responsive_page_content_overlay { display: none !important; }
          #global_header { display: block !important; }
          .responsive_page_content { padding-top: 0 !important; }
          #pagecontent.pagecontent {
            max-width: 1220px !important;
            width: 1220px !important;
            margin-left: auto !important;
            margin-right: auto !important;
          }
          .friends_container {
            flex-direction: row !important;
            margin-left: 10px !important;
            margin-right: 10px !important;
          }
          .friends_nav {
            display: block !important;
            min-width: 250px !important;
            margin: 0 20px 0 10px !important;
          }
          .friends_nav > *,
          .friends_nav > a {
            display: block !important;
          }
          #codex-region-mismatch {
            margin-top: 12px !important;
            max-width: 590px !important;
            width: 590px !important;
            padding: 21px 15px !important;
          }
          #codex-region-mismatch .codex-region-status {
            margin-top: 0 !important;
            color: #8f98a0 !important;
            overflow-wrap: anywhere !important;
          }
          #codex-region-mismatch .codex-region-status h1 {
            color: #c7c7c7 !important;
            font-size: 17px !important;
            line-height: 20px !important;
            font-weight: normal !important;
            margin: 0 0 4px 0 !important;
            max-width: 560px !important;
            overflow-wrap: anywhere !important;
          }
          #codex-region-mismatch .codex-region-status div {
            font-size: 14px !important;
            line-height: 18px !important;
            max-width: 560px !important;
            overflow-wrap: anywhere !important;
          }
          #codex-region-mismatch .codex-region-link {
            color: #3792e9 !important;
          }
          .friends_header_ctn,
          .friends_header_avatar {
            overflow: visible !important;
          }
          .friends_header_avatar {
            width: 64px !important;
            height: 64px !important;
          }
          .friends_header_avatar .codex-friends-avatar {
            width: 64px !important;
            height: 64px !important;
            position: relative !important;
            display: block !important;
            overflow: visible !important;
            padding: 0 !important;
            background: transparent !important;
            filter: none !important;
            box-shadow: none !important;
          }
          .friends_header_avatar .codex-friends-avatar .playerAvatarAutoSizeInner {
            position: absolute !important;
            inset: 0 !important;
            width: 64px !important;
            height: 64px !important;
            overflow: visible !important;
          }
          .friends_header_avatar .codex-friends-avatar .profile_avatar_frame {
            position: absolute !important;
            inset: 0 !important;
            width: 64px !important;
            height: 64px !important;
            z-index: 2 !important;
            pointer-events: none !important;
            overflow: visible !important;
          }
          .friends_header_avatar .codex-friends-avatar img {
            box-shadow: none !important;
          }
          .friends_header_avatar .codex-friends-avatar .profile_avatar_frame img {
            width: 64px !important;
            height: 64px !important;
            padding: 0 !important;
            transform: scale(1.07) !important;
            transform-origin: center center !important;
            background: none !important;
          }
          .friends_header_avatar .codex-friends-avatar .codex-avatar-picture,
          .friends_header_avatar .codex-friends-avatar .codex-avatar-picture img {
            display: block !important;
            width: 64px !important;
            height: 64px !important;
          }
          .friends_header_avatar .codex-friends-avatar .codex-avatar-picture img {
            padding: 0 !important;
            object-fit: cover !important;
            background: none !important;
          }
        `;
        document.head.appendChild(style);

        setText(".friends_header_name a", data.name);
        setText("#global_header .supernav_active.username", data.name);
        setText("#account_pulldown", data.name);
        setText("#global_action_menu .global_action_link", data.name);
        setText("#header_wallet_balance", "$ 0.12");
        document.querySelectorAll("#global_header .account_name, .responsive_menu_user_wallet a").forEach((element) => {
          if ((element.textContent || "").includes("Mex$")) {
            element.textContent = "$ 0.12";
          }
        });

        const headerAvatar = document.querySelector(".friends_header_avatar") as HTMLElement | null;
        if (headerAvatar) {
          const avatarFull = data.avatarFull || data.fallbackAvatarFull;
          const profileHref = data.profileUrl || data.inviteLink;
          const miniprofileAttr = data.miniprofile ? ` data-miniprofile="${data.miniprofile}"` : "";
          const frameHtml = data.avatarFrame
            ? `<div class="profile_avatar_frame"><picture><source media="(prefers-reduced-motion: reduce)" srcset="${data.avatarFrame}"><source srcset="${data.avatarFrame}"><img src="${data.avatarFrame}"></picture></div>`
            : "";
          headerAvatar.innerHTML = `<a href="${profileHref}"><div class="playerAvatar medium offline codex-friends-avatar"${miniprofileAttr}><div class="playerAvatarAutoSizeInner">${frameHtml}<picture class="codex-avatar-picture"><source media="(prefers-reduced-motion: reduce)" srcset="${avatarFull}"><source srcset="${avatarFull}"><img srcset="${avatarFull}" src="${avatarFull}"></picture></div></div></a>`;
        }
        setAttr("#global_action_menu img", "src", data.avatarFull);
        setAttr("#global_actions .user_avatar img", "src", data.avatarFull);

        if (data.avatarFrame) {
          setAttr(".friends_header_avatar .profile_avatar_frame img", "src", data.avatarFrame);
        }

        const quickInviteSection = document.querySelector("._2N55HNCo3jLIzL6RNNlRUo") as HTMLElement | null;
        let copyContainer = quickInviteSection?.querySelector("._1HjkZ3ooQw-4TV518YPtvp") as HTMLElement | null;
        if (quickInviteSection && !copyContainer) {
          copyContainer = document.createElement("div");
          copyContainer.className = "_1HjkZ3ooQw-4TV518YPtvp";
          quickInviteSection.appendChild(copyContainer);
        }
        if (copyContainer) {
          let quickInvite = copyContainer.querySelector("._18Sc08YQfmAIVx8H1h8A1V") as HTMLElement | null;
          if (!quickInvite) {
            quickInvite = document.createElement("div");
            quickInvite.className = "_18Sc08YQfmAIVx8H1h8A1V";
            copyContainer.prepend(quickInvite);
          }
          quickInvite.textContent = data.inviteLink;
          if (!copyContainer.querySelector("button")) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "_2772E6skxrFIemLRdp0EKv DialogButton _DialogLayout Primary Focusable";
            button.setAttribute("role", "button");
            button.textContent = "Copy";
            copyContainer.appendChild(button);
          } else {
            const button = copyContainer.querySelector("button") as HTMLButtonElement | null;
            if (button) button.textContent = "Copy";
          }
        }

        const friendCodeInput = Array.from(document.querySelectorAll("input[type='text'], input.DialogInput")).find((input) =>
          /friend code/i.test(String((input as HTMLInputElement).placeholder || "")),
        ) as HTMLInputElement | undefined;
        if (data.variant === "not_found" && friendCodeInput) {
          friendCodeInput.value = data.friendCode;
        }

        document.querySelector("#codex-region-mismatch")?.remove();
        if (data.variant === "not_found" && data.showRegionMismatch && friendCodeInput) {
          const selector =
            (friendCodeInput.closest("._3nmSpgo_T_V0-Er7h8J2Ar") as HTMLElement | null) ||
            (friendCodeInput.parentElement as HTMLElement | null);
          const card = document.createElement("div");
          card.id = "codex-region-mismatch";
          card.className = "_28a_CNvDls7VgWoPW2-9Kz";

          const status = document.createElement("div");
          status.className = "_1tEt0fYckNbFAqGLEfrsfj codex-region-status";
          const statusTitle = document.createElement("h1");
          statusTitle.className = "_3kTQIYYiQiVR_DeJepkOwJ";
          statusTitle.textContent = "Unable adding friend. Region mismatch";
          const statusNote = document.createElement("div");
          statusNote.append("Note: You can still be added by this user using a ");
          const quickInviteLinkText = document.createElement("span");
          quickInviteLinkText.className = "codex-region-link";
          quickInviteLinkText.textContent = "Quick Invite link";
          statusNote.appendChild(quickInviteLinkText);
          statusNote.append(".");
          status.appendChild(statusTitle);
          status.appendChild(statusNote);

          card.appendChild(status);
          selector?.appendChild(card);
        }
      },
      {
        name: profile.name,
        avatarFull: profile.avatarFull,
        avatarFrame: profile.avatarFrame,
        miniprofile: profile.miniprofile || "",
        profileUrl: profile.profileUrl || null,
        fallbackAvatarFull: STEAM_FRIEND_FALLBACK_AVATAR_URL,
        friendCode: String(options?.friendCode || "11016760945"),
        inviteLink: inviteUrl,
        variant: options?.variant === "not_found" ? "not_found" : "normal",
        showRegionMismatch: Boolean(options?.showRegionMismatch),
      },
    );

    await steamTemplatePage
      .waitForFunction(
        () => {
          const img = document.querySelector(".friends_header_avatar .codex-avatar-picture img") as HTMLImageElement | null;
          return Boolean(img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
        },
        { timeout: 5000, polling: 100 },
      )
      .catch(() => null);

    const dims = await steamTemplatePage.evaluate((viewport: { width: number; height: number }) => {
      const doc = document.documentElement;
      const body = document.body;
      return {
        w: viewport.width,
        h: Math.min(Math.max(doc.scrollHeight, body.scrollHeight, viewport.height), viewport.height),
      };
    }, STEAM_FRIEND_TEMPLATE_VIEWPORT);
    await steamTemplatePage.setViewportSize({ width: dims.w, height: dims.h });
    await steamTemplatePage.screenshot({ path: screenshotPath, clip: { x: 0, y: 0, width: dims.w, height: dims.h } });
    return screenshotPath;
  };

  const run = steamRenderChain.then(task, task);
  steamRenderChain = run.then(() => undefined, () => undefined);
  return run;
}

async function makeSteamQrPageScreenshot(displayTime: string, inviteLink: string) {
    const task = async () => {
    await ensureSteamRendererReady();
    const templatePng = path.join(process.cwd(), "src", "templates", "photo.png");
    const binanceFontPath = path.join(process.cwd(), "src", "templates", "fonts", "binancePlex", "BinancePlex-Regular.otf");
    const templateUrl = `file:///${templatePng.replace(/\\/g, "/")}`;
    const binanceFontUrl = `file:///${binanceFontPath.replace(/\\/g, "/")}`;
    const tmpDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-steam-qr-"));
    const tempHtmlPath = path.join(tmpDir, `qr_${Date.now()}.html`);
    const screenshotPath = path.join(tmpDir, `qr_${Date.now()}.png`);
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=0&data=${encodeURIComponent(inviteLink)}`;
    const profile = await loadInvitePageData(inviteLink);
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    @font-face {
      font-family: "Binance PLEX";
      src:
        url("${binanceFontUrl}") format("opentype"),
        url("https://db.onlinewebfonts.com/t/d05c19ccecf7003d248c60ffd6b5e8f7.woff2") format("woff2");
      font-weight: 400;
      font-style: normal;
      font-display: block;
    }
    * { box-sizing: border-box; }
    body { margin: 0; overflow: hidden; position: relative; color: #fff; display: inline-block; background: #000; font-family: "Binance PLEX", Arial, sans-serif; font-weight: 400; }
    .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
    .avatar-main { position: absolute; left: 48px; top: 184px; width: 97px; height: 97px; object-fit: cover; }
    .avatar-mini { position: absolute; left: 513px; top: 105px; width: 60px; height: 60px; object-fit: cover; }
    .profile-name { position: absolute; left: 169px; top: 205px; font-family: "Binance PLEX", Arial, sans-serif; font-size: 36px; font-weight: 400; color: #ebebeb; white-space: nowrap; }
    .ios-time { position: absolute; left: 58px; top: 30px; font-size: 26px; font-weight: 500; }
    .qr { position: absolute; left: 212px; top: 519px; width: 176px; height: 176px; background: #fff; }
    .link-box { position: absolute; left: 45px; top: 1033px; width: 327px; height: 96px; display: flex; align-items: center; justify-content: center; text-align: center; padding: 6px 10px; }
    .link { color: #cecece; width: 100%; font-family: "Binance PLEX", Arial, sans-serif; font-size: 22px; font-weight: 400; line-height: 1.12; overflow-wrap: anywhere; word-break: break-word; }
  </style>
</head>
<body>
  <img class="bg" src="${templateUrl}" alt="template" />
  ${profile.avatarFull ? `<img class="avatar-main" src="${escapeHtml(profile.avatarFull)}" alt="avatar" />` : ""}
  ${profile.avatarFull ? `<img class="avatar-mini" src="${escapeHtml(profile.avatarFull)}" alt="avatar" />` : ""}
  <div class="profile-name">${escapeHtml(profile.name)}</div>
  <div class="ios-time">${escapeHtml(displayTime)}</div>
  <img class="qr" src="${qrUrl}" alt="qr" />
  <div class="link-box"><div class="link">${escapeHtml(inviteLink)}</div></div>
</body>
</html>`;
    await fs.writeFile(tempHtmlPath, html, "utf8");
    await steamTemplatePage.goto(`file:///${tempHtmlPath.replace(/\\/g, "/")}`, { waitUntil: "domcontentloaded", timeout: 12000 });
    await steamTemplatePage.evaluate(() => document.fonts?.ready).catch(() => null);
    const dims = await steamTemplatePage.evaluate(() => {
      const img = document.querySelector(".bg") as HTMLImageElement | null;
      const w = img?.naturalWidth || 590;
      const h = img?.naturalHeight || 1280;
      document.body.style.width = `${w}px`;
      document.body.style.height = `${h}px`;
      return { w, h };
    });
    await steamTemplatePage.setViewportSize({ width: dims.w, height: dims.h });
    await steamTemplatePage.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => null);
    await steamTemplatePage.waitForTimeout(350);
    await steamTemplatePage.screenshot({ path: screenshotPath, clip: { x: 0, y: 0, width: dims.w, height: dims.h } });
    return screenshotPath;
  };

  const run = steamRenderChain.then(task, task);
  steamRenderChain = run.then(() => undefined, () => undefined);
  return run;
}

async function makeDota2FakeCodeScreenshot() {
  const templatePath = path.join(process.cwd(), "src", "templates", "code-dota2-fake.png");
  const tmpDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-dota2-code-fake-"));
  const screenshotPath = path.join(tmpDir, `code_dota2_fake_${Date.now()}.png`);
  await fs.copyFile(templatePath, screenshotPath);
  return screenshotPath;
}

async function makeDota2CodeNotFoundScreenshot(mammothCode: string) {
  const task = async () => {
    await ensureSteamRendererReady();
    const templatePath = path.join(process.cwd(), "src", "templates", "code-dota2-not-found.png");
    const fontPath = path.join(process.cwd(), "src", "templates", "radiance.ttf");
    const templateUrl = `file:///${templatePath.replace(/\\/g, "/")}`;
    const fontUrl = `file:///${fontPath.replace(/\\/g, "/")}`;
    const tmpDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-dota2-code-not-found-"));
    const tempHtmlPath = path.join(tmpDir, `code_dota2_nf_${Date.now()}.html`);
    const screenshotPath = path.join(tmpDir, `code_dota2_nf_${Date.now()}.png`);
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    @font-face { font-family: "Radiance"; src: url("${fontUrl}") format("truetype"); font-weight: normal; font-style: normal; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; overflow: hidden; background: #000; }
    body { position: relative; }
    .bg { position: absolute; left: 0; top: 0; width: auto; height: auto; }
    .code {
      position: absolute;
      left: 802px;
      top: 255px;
      font-family: "Radiance", sans-serif;
      color: #b9bec9;
      font-size: 18.75px;
      line-height: 22px;
      white-space: nowrap;
      letter-spacing: 0.2px;
      text-shadow:
        0 1px 1px rgba(0, 0, 0, 0.75),
        0 0 2px rgba(185, 190, 202, 0.25);
      -webkit-font-smoothing: antialiased;
      text-rendering: geometricPrecision;
    }
  </style>
</head>
<body>
  <img class="bg" src="${templateUrl}" alt="template" />
  <div class="code">${escapeHtml(mammothCode)}</div>
</body>
</html>`;
    await fs.writeFile(tempHtmlPath, html, "utf8");
    await steamTemplatePage.goto(`file:///${tempHtmlPath.replace(/\\/g, "/")}`, { waitUntil: "domcontentloaded", timeout: 12000 });
    await steamTemplatePage.evaluate(() => document.fonts?.ready).catch(() => null);
    const dims = await sizeSteamTemplatePageFromBackground(steamTemplatePage, { w: 1996, h: 1216 });
    await steamTemplatePage.screenshot({ path: screenshotPath, clip: { x: 0, y: 0, width: dims.w, height: dims.h } });
    return screenshotPath;
  };

  const run = steamRenderChain.then(task, task);
  steamRenderChain = run.then(() => undefined, () => undefined);
  return run;
}

bot.catch(async (error, ctx) => {
  console.error("[BOT ERROR]", error);
  await ctx.reply("Что-то сломалось во время обработки запроса. Попробуйте еще раз.").catch(() => null);
});

bot.on("document", async (ctx) => {
  const me = ensureUser(ctx);
  if (!me || Number(me.is_banned || 0) === 1) return;

  const flow = state.get(ctx.from.id);
  if (flow?.mode !== "rent_add_mafile") return;
  if (!canManageRentals(me)) {
    state.delete(ctx.from.id);
    await ctx.reply("<b>Раздел доступен только помощникам и администраторам.</b>", { parse_mode: "HTML" }).catch(() => null);
    return;
  }

  const saved = await saveTelegramDocument(ctx, (ctx.message as any).document).catch(() => null);
  if (!saved) {
    await ctx.reply("<b>Пришлите MaFile документом.</b>", { parse_mode: "HTML" }).catch(() => null);
    return;
  }

  const rental = addRentalAccount(
    me.id,
    flow.payload.title,
    flow.payload.description,
    saved.filePath,
    flow.payload.login,
    flow.payload.password,
  );
  state.delete(ctx.from.id);
  logEvent(me, "rentals", `add:${rental.number}`);
  await ctx.reply(`<b>Аккаунт добавлен.</b>\nНомер: <b>№${rental.number}</b>\nНазвание: <b>${escapeHtml(rental.title)}</b>`, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback("Открыть", `rent:view:${rental.number}`)]]).reply_markup,
  }).catch(() => null);
});

bot.on("photo", async (ctx) => {
  const me = ensureUser(ctx);
  if (!me || Number(me.is_banned || 0) === 1) return;

  const flow = state.get(ctx.from.id);
  const reportId = flow?.mode === "rent_report_upload" ? Number(flow.payload.reportId) : Number(findActiveRentReportForUser(me.id)?.id || 0);
  if (!reportId) return;

  const report = getRentReportById(reportId);
  const rental = report ? getRentalById(Number(report.rental_id)) : null;
  if (!report || !rental || Number(rental.rented_by_user_id || 0) !== Number(me.id) || !canSubmitRentReport(report)) {
    state.delete(ctx.from.id);
    await ctx.reply("<b>Активный запрос отчета не найден.</b>", { parse_mode: "HTML" }).catch(() => null);
    return;
  }

  const photos = (ctx.message as any).photo as any[];
  const photo = photos?.[photos.length - 1];
  if (!photo?.file_id) {
    await ctx.reply("<b>Пришлите скрин изображением.</b>", { parse_mode: "HTML" }).catch(() => null);
    return;
  }

  report.file_id = photo.file_id;
  report.file_unique_id = photo.file_unique_id || null;

  const sent = await notifyRentalReportManagers(ctx, report);
  if (sent <= 0) {
    report.file_id = null;
    report.file_unique_id = null;
    saveState();
    await ctx.reply("<b>Не удалось отправить отчет проверяющим. Попробуйте отправить фото еще раз чуть позже.</b>", { parse_mode: "HTML" }).catch(() => null);
    logEvent(me, "rent_report", `submit_failed:${report.id}:rental:${rental.number}:managers:0`);
    return;
  }

  report.status = "SUBMITTED";
  report.submitted_at = nowIso();
  rental.report_deadline_at = null;
  saveState();
  state.delete(ctx.from.id);
  await ctx.reply(`<b>Отчет отправлен на проверку.</b>\nПроверяющих уведомлено: <b>${sent}</b>`, { parse_mode: "HTML" }).catch(() => null);
  logEvent(me, "rent_report", `submit:${report.id}:rental:${rental.number}:managers:${sent}`);
});

bot.on("text", async (ctx) => {
  const me = ensureUser(ctx);
  if (!me || Number(me.is_banned || 0) === 1) return;

  const text = String(ctx.message.text || "");
  const trimmed = text.trim();
  const normalized = trimmed.normalize("NFKC").replace(/\uFE0F/g, "");
  const plain = normalized.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const isSettingsBtn = plain.startsWith("Настройки");
  const isDrawBtn = plain.startsWith("Отрисовка");
  const isOnlineBtn = plain.startsWith("Чекер онлайна");
  const isRentalsBtn = plain.startsWith("Аренда аккаунтов");

  if (/^\/start(?:@[\w_]+)?$/i.test(trimmed)) {
    await clearUserFlowOnly(ctx);
    await showMainMenu(ctx, me);
    return;
  }

  if (/^\/admin(?:@[\w_]+)?$/i.test(trimmed)) {
    await resetUserFlow(ctx);
    if (!hasRole(me, ["ADMIN"])) {
      await showMainMenu(ctx, me, "Этот раздел доступен только администраторам.");
      return;
    }
    await ctx.reply("Админка:", adminKb).catch(() => null);
    return;
  }

  if (isRentalsBtn) {
    await clearUserFlowOnly(ctx);
    if (hasAcceptedRentRules(me.id)) {
      await renderRentalsMenu(ctx);
    } else {
      await renderRentalsRules(ctx);
    }
    logEvent(me, "rentals", "open_menu");
    return;
  }

  const activeFlow = state.get(ctx.from.id);
  if (activeFlow?.mode === "admin_broadcast_input" && hasRole(me, ["ADMIN"])) {
    await sendAdminBroadcast(ctx, me);
    return;
  }

  const guardMatch = trimmed.match(/^\/guard(?:@[\w_]+)?\s+(\d+)$/i);
  if (guardMatch) {
    const rental = getRentalByNumber(Number(guardMatch[1]));
    if (!rental || Number(rental.rented_by_user_id || 0) !== Number(me.id)) {
      await ctx.reply("<b>Этот аккаунт не арендован вами.</b>", { parse_mode: "HTML" }).catch(() => null);
      return;
    }
    const attempt = guardAttemptFor(Number(rental.id), Number(me.id));
    if (!attempt || Number(attempt.attempts_left || 0) <= 0) {
      await ctx.reply("<b>Код уже был получен. Запросите новый код у помощника или администратора.</b>", { parse_mode: "HTML" }).catch(() => null);
      return;
    }
    const guardCode = await generateSteamGuardCodeFromRental(rental);
    if (!guardCode) {
      await ctx.reply("<b>Не удалось получить Guard код из MaFile.</b>", { parse_mode: "HTML" }).catch(() => null);
      return;
    }
    attempt.attempts_left = 0;
    saveState();
    await ctx.reply(`<b>Guard код для входа:</b> <code>${escapeHtml(guardCode)}</code>`, { parse_mode: "HTML" }).catch(() => null);
    logEvent(me, "rentals", `guard:${rental.number}`);
    return;
  }

  const guardSetMatch = trimmed.match(/^\/guardset(?:@[\w_]+)?\s+(\d+)$/i);
  if (guardSetMatch) {
    if (!canManageRentals(me)) {
      await ctx.reply("<b>Нет доступа.</b>", { parse_mode: "HTML" }).catch(() => null);
      return;
    }
    const rental = getRentalByNumber(Number(guardSetMatch[1]));
    if (!rental || !Number(rental.rented_by_user_id || 0)) {
      await ctx.reply("<b>Аккаунт не найден или не находится в аренде.</b>", { parse_mode: "HTML" }).catch(() => null);
      return;
    }
    ensureGuardAttempt(Number(rental.id), Number(rental.rented_by_user_id), 1);
    await ctx.reply(`<b>Guard доступ выдан.</b>\nАккаунт: <b>№${rental.number}</b>`, { parse_mode: "HTML" }).catch(() => null);
    const renter = getUserById(Number(rental.rented_by_user_id));
    if (renter?.tg_id) {
      await ctx.telegram.sendMessage(
        Number(renter.tg_id),
        `<b>Доступен новый код для входа.</b>\nПолучить код: <code>/guard ${rental.number}</code>`,
        { parse_mode: "HTML" },
      ).catch(() => null);
    }
    logEvent(me, "rentals", `guardset:${rental.number}`);
    return;
  }

  const deleteMissesMatch = trimmed.match(/^\/del(?:@[\w_]+)?\s+(\d+)\s+(\d+)$/i);
  if (deleteMissesMatch) {
    if (!canManageRentals(me)) {
      await ctx.reply("<b>Нет доступа.</b>", { parse_mode: "HTML" }).catch(() => null);
      return;
    }
    const rentalNumber = Number(deleteMissesMatch[1] || 0);
    const count = Number(deleteMissesMatch[2] || 0);
    const rental = getRentalByNumber(rentalNumber);
    if (!rental) {
      await ctx.reply("<b>Аккаунт не найден.</b>", { parse_mode: "HTML" }).catch(() => null);
      return;
    }
    const before = activeReportMissCount(rental);
    const removed = removeRentalReportMisses(rental, count);
    const after = activeReportMissCount(rental);
    await ctx.reply(
      `<b>Пропущенные отчеты списаны.</b>\n` +
        `Аккаунт: <b>№${rental.number}</b>\n` +
        `Было: <b>${before}</b>\n` +
        `Убрано: <b>${removed}</b>\n` +
        `Осталось: <b>${after}</b>`,
      { parse_mode: "HTML" },
    ).catch(() => null);
    logEvent(me, "rent_report", `delete_misses:rental:${rental.number}:count:${removed}`);
    return;
  }

  if (activeFlow?.mode === "rent_add_title") {
    if (!canManageRentals(me)) {
      state.delete(ctx.from.id);
      await showMainMenu(ctx, me, "Раздел доступен только помощникам и администраторам.");
      return;
    }
    const title = trimmed.slice(0, 80);
    if (!title) {
      await ctx.reply("<b>Введите название аккаунта.</b>", { parse_mode: "HTML" }).catch(() => null);
      return;
    }
    state.set(ctx.from.id, { mode: "rent_add_description", payload: { title } });
    await ctx.reply("<b>Введите описание аккаунта.</b>", { parse_mode: "HTML" }).catch(() => null);
    return;
  }

  if (activeFlow?.mode === "rent_add_description") {
    if (!canManageRentals(me)) {
      state.delete(ctx.from.id);
      await showMainMenu(ctx, me, "Раздел доступен только помощникам и администраторам.");
      return;
    }
    const description = trimmed.slice(0, 2000);
    state.set(ctx.from.id, { mode: "rent_add_credentials", payload: { title: activeFlow.payload.title, description } });
    await ctx.reply("<b>Введите данные аккаунта в формате:</b>\n<code>login:pass</code>", { parse_mode: "HTML" }).catch(() => null);
    return;
  }

  if (activeFlow?.mode === "rent_add_credentials") {
    if (!canManageRentals(me)) {
      state.delete(ctx.from.id);
      await showMainMenu(ctx, me, "Раздел доступен только помощникам и администраторам.");
      return;
    }
    const credentials = parseLoginPassword(trimmed);
    if (!credentials) {
      await ctx.reply("<b>Нужен формат:</b> <code>login:pass</code>", { parse_mode: "HTML" }).catch(() => null);
      return;
    }
    state.set(ctx.from.id, {
      mode: "rent_add_mafile",
      payload: {
        title: activeFlow.payload.title,
        description: activeFlow.payload.description,
        login: credentials.login,
        password: credentials.password,
      },
    });
    await ctx.reply("<b>Теперь пришлите MaFile документом.</b>", { parse_mode: "HTML" }).catch(() => null);
    return;
  }

  if (activeFlow?.mode === "rent_edit_input") {
    if (!canManageRentals(me)) {
      state.delete(ctx.from.id);
      await showMainMenu(ctx, me, "Раздел доступен только помощникам и администраторам.");
      return;
    }
    const rental = getRentalByNumber(activeFlow.payload.number);
    if (!rental) {
      state.delete(ctx.from.id);
      await ctx.reply("<b>Объявление не найдено.</b>", { parse_mode: "HTML" }).catch(() => null);
      return;
    }
    if (activeFlow.payload.field === "title") {
      rental.title = trimmed.slice(0, 80);
    } else {
      rental.description = trimmed.slice(0, 2000);
    }
    saveState();
    state.delete(ctx.from.id);
    logEvent(me, "rentals", `edit:${rental.number}:${activeFlow.payload.field}`);
    await ctx.reply("<b>Объявление обновлено.</b>", {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("Открыть", `rent:view:${rental.number}`)]]).reply_markup,
    }).catch(() => null);
    return;
  }

  if (activeFlow?.mode === "rent_set_responsible") {
    if (!hasRole(me, ["ADMIN"])) {
      state.delete(ctx.from.id);
      await ctx.reply("<b>Нет доступа.</b>", { parse_mode: "HTML" }).catch(() => null);
      return;
    }
    const username = setRentResponsibleUsername(trimmed);
    state.delete(ctx.from.id);
    await ctx.reply(`<b>Ответственный обновлен:</b> <b>${escapeHtml(username || "не назначен")}</b>`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "rent:manage")]]).reply_markup,
    }).catch(() => null);
    logEvent(me, "rentals", `responsible:${username || "-"}`);
    return;
  }

  if (activeFlow?.mode === "rent_discord_handoff") {
    if (isDrawBtn || isOnlineBtn || isSettingsBtn || isRentalsBtn) {
      state.delete(ctx.from.id);
      if (isDrawBtn) {
        await renderDrawMenu(ctx);
        logEvent(me, "draw", "open_menu");
        return;
      }
      if (isSettingsBtn) {
        await renderSettingsMenu(ctx, me);
        return;
      }
      if (isOnlineBtn) {
        state.set(ctx.from.id, { mode: "online_watch_profile_input" });
        await renderOnlineWatchPrompt(ctx);
        return;
      }
    }
    const rental = getRentalByNumber(activeFlow.payload.rentalNumber);
    if (!rental) {
      state.delete(ctx.from.id);
      await ctx.reply("<b>Аккаунт не найден.</b>", { parse_mode: "HTML" }).catch(() => null);
      return;
    }
    const pending = rentDiscordPendingFor(Number(rental.number), Number(me.id));
    if (pending && ["CONFIRMED", "PROCESSING", "SENT"].includes(String(pending.status || ""))) {
      state.delete(ctx.from.id);
      await runRentDiscordBridgeTick(ctx).catch((error) => console.error("[RENT DISCORD BRIDGE ERROR]", error));
      return;
    }
    await ctx.reply(formatDiscordRentalInstruction(rental), {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", `rent:view:${rental.number}`)]]).reply_markup,
    }).catch(() => null);
    return;
  }

  if (activeFlow?.mode === "rent_report_reject_comment") {
    if (!canManageRentals(me)) {
      state.delete(ctx.from.id);
      await ctx.reply("<b>Нет доступа.</b>", { parse_mode: "HTML" }).catch(() => null);
      return;
    }
    const report = getRentReportById(activeFlow.payload.reportId);
    const rental = report ? getRentalById(Number(report.rental_id)) : null;
    const renter = report ? getUserById(Number(report.user_id)) : null;
    if (!report || !rental || !renter) {
      state.delete(ctx.from.id);
      await ctx.reply("<b>Отчет не найден.</b>", { parse_mode: "HTML" }).catch(() => null);
      return;
    }
    const comment = trimmed.slice(0, 1000) || "Без комментария.";
    report.status = activeFlow.payload.requestRepeat ? "RETRY_REQUESTED" : "REJECTED";
    report.admin_comment = comment;
    report.reviewed_at = nowIso();
    report.reviewed_by_user_id = me.id;
    if (activeFlow.payload.requestRepeat) {
      report.deadline_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      rental.report_deadline_at = report.deadline_at;
    }
    saveState();
    state.delete(ctx.from.id);

    if (activeFlow.payload.requestRepeat && renter.tg_id) {
      await ctx.telegram.sendMessage(
        Number(renter.tg_id),
        `<b>Ваш отчет по аренде аккаунта №${rental.number} отклонен.</b>\n\nКомментарий: <b>${escapeHtml(comment)}</b>\n\nНажмите кнопку ниже и отправьте новый скрин игр. На повторный отчет снова есть 24 часа.`,
        {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([[Markup.button.callback("📸 Отправить отчет повторно", `rent:report:upload:${report.id}`)]]).reply_markup,
        },
      ).catch(() => null);
    }

    await ctx.reply("<b>Отменить аренду?</b>", {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ Да", `rent:report:cancel_yes:${report.id}`),
          Markup.button.callback("❌ Нет", `rent:report:cancel_no:${report.id}`),
        ],
      ]).reply_markup,
    }).catch(() => null);
    logEvent(me, "rent_report", `reject_comment:${report.id}:repeat:${activeFlow.payload.requestRepeat}`);
    return;
  }

  if (isDrawBtn || isOnlineBtn || isSettingsBtn || isRentalsBtn) {
    if (isDrawBtn) {
      await clearUserFlowOnly(ctx);
      await renderDrawMenu(ctx);
      logEvent(me, "draw", "open_menu");
      return;
    }
    if (isSettingsBtn) {
      await clearUserFlowOnly(ctx);
      await renderSettingsMenu(ctx, me);
      return;
    }
    await clearUserFlowOnly(ctx);
    state.set(ctx.from.id, { mode: "online_watch_profile_input" });
    await renderOnlineWatchPrompt(ctx);
    return;
  }

  const flow = state.get(ctx.from.id);

  if (flow?.mode === "settings_phishing_link") {
    const parsed = parseHttpUrl(trimmed);
    if (!parsed) {
      await ctx.reply("Нужна корректная фишинг-ссылка http/https.");
      return;
    }
    state.delete(ctx.from.id);
    setUserPhishingLink(me.id, parsed);
    await renderSettingsMenu(ctx, me);
    return;
  }

  if (flow?.mode === "admin_logs_search" && hasRole(me, ["ADMIN"])) {
    adminLogsViewState.set(ctx.from.id, { query: trimmed });
    state.delete(ctx.from.id);
    await renderAdminLogs(ctx, 0, trimmed);
    return;
  }

  if (flow?.mode === "admin_find_user" && hasRole(me, ["ADMIN"])) {
    const target = getUserByQuery(trimmed);
    state.delete(ctx.from.id);
    if (!target) {
      await ctx.reply("Пользователь не найден.");
      return;
    }
    await renderAdminUserCard(ctx, target, flow.payload.returnPage);
    return;
  }

  if (flow?.mode === "admin_steam_proxy_input" && hasRole(me, ["ADMIN"])) {
    try {
      const lines = trimmed.split(/\r?\n+/).map((line) => line.trim()).filter(Boolean);
      const normalized = lines.map((line) => normalizeSteamProxyUrl(line)).filter(Boolean);
      if (normalized.length) {
        for (const proxy of normalized) addSteamProxyUrl(proxy);
      } else {
        clearSteamProxies();
      }
      state.delete(ctx.from.id);
      const resultText = normalized.length
        ? `\u0434\u043e\u0431\u0430\u0432\u043b\u0435\u043d\u044b: ${normalized.length}`
        : "\u043e\u0442\u043a\u043b\u044e\u0447\u0435\u043d\u044b";
      await ctx.reply(`<b>Steam \u043f\u0440\u043e\u043a\u0441\u0438 ${resultText}.</b>\n\u0420\u0435\u0436\u0438\u043c: <b>${escapeHtml(steamProxyStatusText())}</b>`, {
        parse_mode: "HTML",
      }).catch(() => null);
      logEvent(me, "admin_steam_proxy", normalized.length ? `add:${normalized.length}` : "clear");
    } catch {
      await ctx.reply("<b>\u041f\u0440\u043e\u043a\u0441\u0438 \u043d\u0435 \u043f\u0440\u0438\u043d\u044f\u0442.</b>\n\u0424\u043e\u0440\u043c\u0430\u0442: <code>socks5://user:pass@host:port</code>\n\u0418\u043b\u0438: <code>off</code>", {
        parse_mode: "HTML",
      }).catch(() => null);
    }
    return;
  }

  if (flow?.mode?.startsWith("draw_input:")) {
    await handleDrawInput(ctx, flow as any, trimmed);
    return;
  }

  if (flow?.mode === "online_watch_profile_input") {
    await handleOnlineWatchProfile(ctx, me, trimmed);
    logEvent(me, "online_watch", `profile:${trimmed.slice(0, 120)}`);
    return;
  }

  if (flow?.mode === "online_watch_comment_input") {
    await handleOnlineWatchComment(ctx, me, flow, trimmed);
    logEvent(me, "online_watch", `comment:${trimmed.slice(0, 120)}`);
    return;
  }

  if (trimmed === "Пользователи" && hasRole(me, ["ADMIN"])) {
    await renderAdminUsersPage(ctx, 0);
    return;
  }

  if (trimmed === "Логи" && hasRole(me, ["ADMIN"])) {
    adminLogsViewState.set(ctx.from.id, { query: "" });
    await renderAdminLogs(ctx, 0, "");
    return;
  }

  if (trimmed === "Статистика" && hasRole(me, ["ADMIN"])) {
    await renderAdminStats(ctx, "all");
    return;
  }

  if (trimmed === "Рассылка" && hasRole(me, ["ADMIN"])) {
    state.set(ctx.from.id, { mode: "admin_broadcast_input" });
    await ctx.reply("<b>Отправьте сообщение для рассылки.</b>\nПоддерживается текст, фото, видео, стикеры, документы и другое.", {
      parse_mode: "HTML",
    });
    return;
  }

  if (/^(Steam Proxy|Steam \u043f\u0440\u043e\u043a\u0441\u0438)$/i.test(trimmed) && hasRole(me, ["ADMIN"])) {
    await renderAdminSteamProxy(ctx);
    return;
  }

  await showMainMenu(ctx, me);
});

bot.on("message", async (ctx) => {
  if ("text" in (ctx.message || {})) return;
  const me = ensureUser(ctx);
  if (!me || Number(me.is_banned || 0) === 1 || !hasRole(me, ["ADMIN"])) return;

  const flow = state.get(ctx.from.id);
  if (flow?.mode !== "admin_broadcast_input") return;

  await sendAdminBroadcast(ctx, me);
});

bot.on("callback_query", async (ctx, next) => {
  if (!("data" in ctx.callbackQuery)) return next();
  const me = ensureUser(ctx);
  if (!me || Number(me.is_banned || 0) === 1) return;
  const data = String(ctx.callbackQuery.data || "");

  if (data === "admin:userlist:noop" || data === "logs:noop") {
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "admin:steam_proxy") {
    await renderAdminSteamProxy(ctx);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "admin:steam_proxy:set") {
    state.set(ctx.from.id, { mode: "admin_steam_proxy_input" });
    await replaceOrReply(ctx, "<b>\u041e\u0442\u043f\u0440\u0430\u0432\u044c\u0442\u0435 Steam \u043f\u0440\u043e\u043a\u0441\u0438.</b>\n\u041c\u043e\u0436\u043d\u043e \u043f\u0430\u0447\u043a\u043e\u0439, \u043a\u0430\u0436\u0434\u044b\u0439 \u0441 \u043d\u043e\u0432\u043e\u0439 \u0441\u0442\u0440\u043e\u043a\u0438:\n<code>user:pass@host:port</code>\n<code>socks5://user:pass@host:port</code>\n\u041e\u0442\u043a\u043b\u044e\u0447\u0438\u0442\u044c \u0432\u0441\u0435: <code>off</code>", {
      parse_mode: "HTML",
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "admin:steam_proxy:clear") {
    clearSteamProxies();
    await renderAdminSteamProxy(ctx);
    await ctx.answerCbQuery("Steam \u043f\u0440\u043e\u043a\u0441\u0438 \u043e\u0442\u043a\u043b\u044e\u0447\u0435\u043d\u044b").catch(() => null);
    return;
  }

  if (data === "admin:steam_proxy:delete_menu") {
    await renderAdminSteamProxyDeleteMenu(ctx);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "admin:steam_proxy:delete_all") {
    clearSteamProxies();
    await renderAdminSteamProxy(ctx);
    await ctx.answerCbQuery("\u0412\u0441\u0435 \u043f\u0440\u043e\u043a\u0441\u0438 \u0443\u0434\u0430\u043b\u0435\u043d\u044b").catch(() => null);
    return;
  }

  if (data.startsWith("admin:steam_proxy:delete:")) {
    const proxyId = Number(data.split(":").pop() || 0);
    const ok = deleteSteamProxy(proxyId);
    await renderAdminSteamProxy(ctx);
    await ctx.answerCbQuery(ok ? "\u041f\u0440\u043e\u043a\u0441\u0438 \u0443\u0434\u0430\u043b\u0435\u043d" : "\u041f\u0440\u043e\u043a\u0441\u0438 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d", { show_alert: !ok }).catch(() => null);
    return;
  }

  if (data === "settings:menu") {
    await clearUserFlowOnly(ctx);
    await renderSettingsMenu(ctx, me);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "settings:set_phishing") {
    state.set(ctx.from.id, { mode: "settings_phishing_link" });
    await replaceOrReply(ctx, `<b>Введите фишинг-ссылку.</b>`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "settings:menu")]]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "online_watch:menu") {
    state.set(ctx.from.id, { mode: "online_watch_profile_input" });
    await renderOnlineWatchPrompt(ctx);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "online_watch:list") {
    await renderOnlineWatchList(ctx, me);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "online_watch:clear") {
    state.delete(ctx.from.id);
    await clearOnlineWatchRowsForUser(ctx, me);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "rent:list") {
    state.delete(ctx.from.id);
    await renderRentalsList(ctx, me);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "rent:rules") {
    state.delete(ctx.from.id);
    await renderRentalsRules(ctx, { instant: true });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("rent:rules_accept:")) {
    state.delete(ctx.from.id);
    const availableAt = Number(data.split(":")[2] || 0);
    const secondsLeft = Math.ceil((availableAt - Date.now()) / 1000);
    if (secondsLeft > 0) {
      await ctx.answerCbQuery(`Правила можно подтвердить через ${secondsLeft} сек.`, { show_alert: true }).catch(() => null);
      return;
    }
    setRentRulesAccepted(me.id);
    await renderRentalsList(ctx, me);
    await ctx.answerCbQuery("Раздел открыт").catch(() => null);
    return;
  }

  if (data === "rent:back_main") {
    state.delete(ctx.from.id);
    await showMainMenu(ctx, me);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("rent:view:")) {
    state.delete(ctx.from.id);
    await renderRentalCard(ctx, Number(data.split(":")[2] || 0));
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("rent:take:")) {
    state.delete(ctx.from.id);
    const rental = getRentalByNumber(Number(data.split(":")[2] || 0));
    if (!rental) {
      await ctx.answerCbQuery("Аккаунт не найден", { show_alert: true }).catch(() => null);
      return;
    }
    if (Number(rental.is_busy || 0) === 1 && Number(rental.rented_by_user_id || 0) !== Number(me.id)) {
      await ctx.answerCbQuery("Аккаунт уже занят", { show_alert: true }).catch(() => null);
      await renderRentalCard(ctx, Number(rental.number));
      return;
    }
    if (Number(rental.is_busy || 0) === 1 && Number(rental.rented_by_user_id || 0) === Number(me.id)) {
      await ctx.reply(`<b>Этот аккаунт уже арендован вами.</b>\nПолучить код для входа: <code>/guard ${rental.number}</code>`, {
        parse_mode: "HTML",
      }).catch(() => null);
      await ctx.answerCbQuery("Уже арендован").catch(() => null);
      return;
    }
    createRentDiscordPending(rental, me);
    state.set(ctx.from.id, { mode: "rent_discord_handoff", payload: { rentalNumber: Number(rental.number) } });
    logEvent(me, "rentals", `discord_handoff:${rental.number}`);
    await replaceOrReply(ctx, formatDiscordRentalInstruction(rental), {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", `rent:view:${rental.number}`)]]).reply_markup,
    });
    await ctx.answerCbQuery("Подтвердите Discord").catch(() => null);
    return;
  }

  if (/^rent:req:(approve|decline):\d+:\d+$/.test(data)) {
    if (!canManageRentals(me)) {
      await ctx.answerCbQuery("Нет доступа", { show_alert: true }).catch(() => null);
      return;
    }
    const parts = data.split(":");
    const action = parts[2];
    const rental = getRentalByNumber(Number(parts[3] || 0));
    const requester = getUserById(Number(parts[4] || 0));
    if (!rental || !requester) {
      await ctx.answerCbQuery("Заявка не найдена", { show_alert: true }).catch(() => null);
      return;
    }

    if (action === "decline") {
      await clearRentalRequestMessages(ctx, rental, requester);
      await ctx.telegram.sendMessage(Number(requester.tg_id), `<b>Заявка на аренду отклонена.</b>\nАккаунт: <b>№${rental.number}</b>`, {
        parse_mode: "HTML",
      }).catch(() => null);
      await ctx.answerCbQuery("Отклонено").catch(() => null);
      logEvent(me, "rentals", `decline:${rental.number}:user:${requester.id}`);
      return;
    }

    if (Number(rental.is_busy || 0) === 1 && Number(rental.rented_by_user_id || 0) !== Number(requester.id)) {
      await ctx.answerCbQuery("Аккаунт уже занят", { show_alert: true }).catch(() => null);
      return;
    }

    rental.is_busy = 1;
    rental.rented_by_user_id = requester.id;
    rental.rented_at = nowIso();
    ensureGuardAttempt(Number(rental.id), Number(requester.id), 1);
    saveState();
    await clearRentalRequestMessages(ctx, rental, requester);
    await ctx.telegram.sendMessage(
      Number(requester.tg_id),
      `<b>Одобрена аренда</b>\n` +
        `Номер аккаунта: <b>№${rental.number}</b>\n` +
        `Логин: <code>${escapeHtml(String(rental.login || "-"))}</code>\n` +
        `Пароль: <code>${escapeHtml(String(rental.pass || "-"))}</code>\n` +
        `Получить код для входа: <code>/guard ${rental.number}</code>`,
      { parse_mode: "HTML" },
    ).catch(() => null);
    await ctx.answerCbQuery("Одобрено").catch(() => null);
    logEvent(me, "rentals", `approve:${rental.number}:user:${requester.id}`);
    return;
  }

  if (data.startsWith("rent:report:upload:")) {
    const report = getRentReportById(Number(data.split(":")[3] || 0));
    const rental = report ? getRentalById(Number(report.rental_id)) : null;
    if (!report || !rental || Number(rental.rented_by_user_id || 0) !== Number(me.id) || !canSubmitRentReport(report)) {
      await ctx.answerCbQuery("Запрос отчета не найден", { show_alert: true }).catch(() => null);
      return;
    }
    state.set(ctx.from.id, { mode: "rent_report_upload", payload: { reportId: Number(report.id) } });
    await replaceOrReply(ctx, `<b>Пришлите скрин списка игр по аккаунту №${rental.number}.</b>`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "rent:list")]]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("rent:report:approve:")) {
    if (!canManageRentals(me)) {
      await ctx.answerCbQuery("Нет доступа", { show_alert: true }).catch(() => null);
      return;
    }
    const report = getRentReportById(Number(data.split(":")[3] || 0));
    const rental = report ? getRentalById(Number(report.rental_id)) : null;
    const renter = report ? getUserById(Number(report.user_id)) : null;
    if (!report || !rental || !renter) {
      await ctx.answerCbQuery("Отчет не найден", { show_alert: true }).catch(() => null);
      return;
    }
    report.status = "APPROVED";
    report.reviewed_at = nowIso();
    report.reviewed_by_user_id = me.id;
    rental.report_deadline_at = null;
    saveState();
    if (renter.tg_id) {
      await ctx.telegram.sendMessage(Number(renter.tg_id), `<b>Отчет по аренде аккаунта №${rental.number} одобрен.</b>`, {
        parse_mode: "HTML",
      }).catch(() => null);
    }
    await ctx.answerCbQuery("Отчет одобрен").catch(() => null);
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => null);
    logEvent(me, "rent_report", `approve:${report.id}:rental:${rental.number}`);
    return;
  }

  if (data.startsWith("rent:report:reject:")) {
    if (!canManageRentals(me)) {
      await ctx.answerCbQuery("Нет доступ", { show_alert: true }).catch(() => null);
      return;
    }
    const reportId = Number(data.split(":")[3] || 0);
    const report = getRentReportById(reportId);
    if (!report) {
      await ctx.answerCbQuery("Отчет не найден", { show_alert: true }).catch(() => null);
      return;
    }
    await ctx.reply("<b>Запросить отчет повторно?</b>", {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ Да", `rent:report:repeat_yes:${reportId}`),
          Markup.button.callback("❌ Нет", `rent:report:repeat_no:${reportId}`),
        ],
      ]).reply_markup,
    }).catch(() => null);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("rent:report:repeat_yes:") || data.startsWith("rent:report:repeat_no:")) {
    if (!canManageRentals(me)) {
      await ctx.answerCbQuery("Нет доступа", { show_alert: true }).catch(() => null);
      return;
    }
    const requestRepeat = data.startsWith("rent:report:repeat_yes:");
    const reportId = Number(data.split(":")[3] || 0);
    if (!getRentReportById(reportId)) {
      await ctx.answerCbQuery("Отчет не найден", { show_alert: true }).catch(() => null);
      return;
    }
    state.set(ctx.from.id, { mode: "rent_report_reject_comment", payload: { reportId, requestRepeat } });
    await replaceOrReply(ctx, "<b>Укажите комментарий администратора/помощника.</b>", { parse_mode: "HTML" });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("rent:report:cancel_yes:") || data.startsWith("rent:report:cancel_no:")) {
    if (!canManageRentals(me)) {
      await ctx.answerCbQuery("Нет доступа", { show_alert: true }).catch(() => null);
      return;
    }
    const shouldCancel = data.startsWith("rent:report:cancel_yes:");
    const report = getRentReportById(Number(data.split(":")[3] || 0));
    const rental = report ? getRentalById(Number(report.rental_id)) : null;
    if (!report || !rental) {
      await ctx.answerCbQuery("Отчет не найден", { show_alert: true }).catch(() => null);
      return;
    }
    if (shouldCancel) {
      await cancelRentalWithSteamSessions(rental);
      logEvent(me, "rent_report", `cancel:${report.id}:rental:${rental.number}`);
      await replaceOrReply(ctx, "<b>Аренда отменена.</b>", { parse_mode: "HTML" });
    } else {
      await replaceOrReply(ctx, "<b>Аренда оставлена активной.</b>", { parse_mode: "HTML" });
    }
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "rent:manage") {
    state.delete(ctx.from.id);
    if (!canManageRentals(me)) {
      await ctx.answerCbQuery("Нет доступа", { show_alert: true }).catch(() => null);
      return;
    }
    await renderRentalsManage(ctx);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "rent:responsible") {
    state.delete(ctx.from.id);
    if (!hasRole(me, ["ADMIN"])) {
      await ctx.answerCbQuery("Только администраторы", { show_alert: true }).catch(() => null);
      return;
    }
    state.set(ctx.from.id, { mode: "rent_set_responsible" });
    await replaceOrReply(ctx, "<b>Пришлите Telegram username ответственного.</b>\nНапример: <code>@username</code>", {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "rent:manage")]]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "rent:cancel") {
    state.delete(ctx.from.id);
    if (!canManageRentals(me)) {
      await ctx.answerCbQuery("Нет доступа", { show_alert: true }).catch(() => null);
      return;
    }
    await renderRentalsCancelMenu(ctx);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("rent:cancel:")) {
    state.delete(ctx.from.id);
    if (!canManageRentals(me)) {
      await ctx.answerCbQuery("Нет доступа", { show_alert: true }).catch(() => null);
      return;
    }
    const rental = getRentalById(Number(data.split(":")[2] || 0));
    if (!rental || Number(rental.is_busy || 0) !== 1) {
      await ctx.answerCbQuery("Активная аренда не найдена", { show_alert: true }).catch(() => null);
      await renderRentalsCancelMenu(ctx);
      return;
    }
    const renter = getUserById(Number(rental.rented_by_user_id || 0));
    await cancelRentalWithSteamSessions(rental);
    logEvent(me, "rentals", `cancel:${rental.number}:user:${renter?.id || 0}`);
    await ctx.answerCbQuery("Аренда отменена").catch(() => null);
    await renderRentalsCancelMenu(ctx);
    return;
  }

  if (data === "rent:add") {
    if (!canManageRentals(me)) {
      await ctx.answerCbQuery("Нет доступа", { show_alert: true }).catch(() => null);
      return;
    }
    state.set(ctx.from.id, { mode: "rent_add_title" });
    await replaceOrReply(ctx, "<b>Введите название аккаунта.</b>", {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "rent:manage")]]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "rent:delete") {
    state.delete(ctx.from.id);
    if (!canManageRentals(me)) {
      await ctx.answerCbQuery("Нет доступа", { show_alert: true }).catch(() => null);
      return;
    }
    await renderRentalsDeleteMenu(ctx);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "rent:delete_all") {
    state.delete(ctx.from.id);
    if (!canManageRentals(me)) {
      await ctx.answerCbQuery("Нет доступа", { show_alert: true }).catch(() => null);
      return;
    }
    const count = removeAllRentals();
    logEvent(me, "rentals", `delete_all:${count}`);
    await renderRentalsDeleteMenu(ctx);
    await ctx.answerCbQuery(`Удалено: ${count}`).catch(() => null);
    return;
  }

  if (data.startsWith("rent:delete:")) {
    state.delete(ctx.from.id);
    if (!canManageRentals(me)) {
      await ctx.answerCbQuery("Нет доступа", { show_alert: true }).catch(() => null);
      return;
    }
    const number = Number(data.split(":")[2] || 0);
    const changes = removeRentalByNumber(number);
    logEvent(me, "rentals", `delete:${number}`);
    await renderRentalsDeleteMenu(ctx);
    await ctx.answerCbQuery(changes ? "Удалено" : "Не найдено").catch(() => null);
    return;
  }

  if (data === "rent:edit") {
    state.delete(ctx.from.id);
    if (!canManageRentals(me)) {
      await ctx.answerCbQuery("Нет доступа", { show_alert: true }).catch(() => null);
      return;
    }
    await renderRentalsEditList(ctx);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (/^rent:edit:\d+$/.test(data)) {
    state.delete(ctx.from.id);
    if (!canManageRentals(me)) {
      await ctx.answerCbQuery("Нет доступа", { show_alert: true }).catch(() => null);
      return;
    }
    await renderRentalEditFields(ctx, Number(data.split(":")[2] || 0));
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (/^rent:edit:\d+:(title|description)$/.test(data)) {
    if (!canManageRentals(me)) {
      await ctx.answerCbQuery("Нет доступа", { show_alert: true }).catch(() => null);
      return;
    }
    const parts = data.split(":");
    const number = Number(parts[2] || 0);
    const field = parts[3] as "title" | "description";
    state.set(ctx.from.id, { mode: "rent_edit_input", payload: { number, field } });
    await replaceOrReply(ctx, field === "title" ? "<b>Введите новое название.</b>" : "<b>Введите новое описание.</b>", {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", `rent:edit:${number}`)]]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("admin:userlist:page:") && hasRole(me, ["ADMIN"])) {
    await renderAdminUsersPage(ctx, Number(data.split(":").pop() || 0));
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("admin:userlist:search:") && hasRole(me, ["ADMIN"])) {
    const page = Math.max(0, Number(data.split(":").pop() || 0));
    state.set(ctx.from.id, { mode: "admin_find_user", payload: { returnPage: page } });
    await replaceOrReply(ctx, `<b>Введите Telegram username, Discord или ID пользователя.</b>`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("Назад", `admin:userlist:page:${page}`)]]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("admin:usercard:") && hasRole(me, ["ADMIN"])) {
    const parts = data.split(":");
    const userId = Number(parts[2] || 0);
    const page = Number(parts[3] || 0);
    const target = getUserById(userId);
    if (!target) {
      await ctx.answerCbQuery("Пользователь не найден", { show_alert: true }).catch(() => null);
      return;
    }
    await renderAdminUserCard(ctx, target, page);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("admin:ban:") && hasRole(me, ["ADMIN"])) {
    const parts = data.split(":");
    const userId = Number(parts[2] || 0);
    const page = Number(parts[3] || 0);
    const target = toggleUserBan(userId);
    if (!target) {
      await ctx.answerCbQuery("Пользователь не найден", { show_alert: true }).catch(() => null);
      return;
    }
    await renderAdminUserCard(ctx, target, page);
    await ctx.answerCbQuery(Number(target.is_banned || 0) ? "Пользователь забанен" : "Пользователь разбанен").catch(() => null);
    logEvent(me, "admin_ban", `user:${userId}:${target.is_banned ? "ban" : "unban"}`);
    return;
  }

  if (data.startsWith("admin:role:") && hasRole(me, ["ADMIN"])) {
    const parts = data.split(":");
    const userId = Number(parts[2] || 0);
    const role = String(parts[3] || "") as Role;
    const page = Number(parts[4] || 0);
    const target = toggleUserRole(userId, role);
    if (!target) {
      await ctx.answerCbQuery("Роль или пользователь не найдены", { show_alert: true }).catch(() => null);
      return;
    }
    await renderAdminUserCard(ctx, target, page);
    await ctx.answerCbQuery("Роли обновлены").catch(() => null);
    logEvent(me, "admin_role", `user:${userId}:role:${role}`);
    return;
  }

  if (data === "logs:search" && hasRole(me, ["ADMIN"])) {
    state.set(ctx.from.id, { mode: "admin_logs_search" });
    await replaceOrReply(ctx, `<b>Введите слово для поиска по логам.</b>`, { parse_mode: "HTML" });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "logs:clear" && hasRole(me, ["ADMIN"])) {
    adminLogsViewState.set(ctx.from.id, { query: "" });
    await renderAdminLogs(ctx, 0, "");
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("logs:page:") && hasRole(me, ["ADMIN"])) {
    const page = Number(data.split(":").pop() || 0);
    const query = adminLogsViewState.get(ctx.from.id)?.query || "";
    await renderAdminLogs(ctx, page, query);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("stats:range:") && hasRole(me, ["ADMIN"])) {
    const range = String(data.split(":").pop() || "all") as StatsRangeKey;
    const allowed = new Set<StatsRangeKey>(["today", "week", "month", "all"]);
    await renderAdminStats(ctx, allowed.has(range) ? range : "all");
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "draw:menu") {
    await renderDrawMenu(ctx);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "draw:acc_blocked" || data === "draw:steam_guard_error") {
    const mode = data === "draw:acc_blocked" ? "acc_blocked" : "steam_guard_error";
    const modeTitle = mode === "acc_blocked" ? "⛔ Account Blocked" : "🛡️ Steam Guard Error";
    const modeDescription =
      mode === "acc_blocked"
        ? "отрисовка окна блокировки аккаунта для Steam-профиля"
        : "отрисовка ошибки Steam Guard для Steam-профиля";
    state.set(ctx.from.id, {
      mode: `draw_input:${mode}` as "draw_input:acc_blocked" | "draw_input:steam_guard_error",
      payload: { variant: "id", promptMessageId: (ctx.callbackQuery as any)?.message?.message_id || null },
    });
    await renderPhotoPrompt(ctx, mode === "acc_blocked" ? DRAW_ACC_BLOCKED_IMAGE_PATH : DRAW_STEAM_GUARD_ERROR_IMAGE_PATH, `<blockquote>${modeTitle}\n     ╰ ${modeDescription}</blockquote>\n\n👀 Отправь ссылку на профиль или SteamID:\n\n❗️ Для корректной работы отрисовщика, сначала проверьте профиль и следом скопируйте адрес из адресной строки`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "draw:menu")]]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "draw:add_friend") {
    const base = data.split(":")[1];
    await renderPhotoPrompt(
      ctx,
      DRAW_ADD_FRIEND_IMAGE_PATH,
      `<blockquote>👥 Add Friend\n     ╰ отрисовка ошибки добавления в друзья</blockquote>\n\n👀 Выбери, что предоставил мамонт:`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("🔗 Ссылка", `draw:${base}:link`), Markup.button.callback("🆔 Код друга", `draw:${base}:id`)],
          [Markup.button.callback("⬅️ Назад", "draw:menu")],
        ]).reply_markup,
      },
    );
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("draw:add_friend:") || data.startsWith("draw:acc_blocked:") || data.startsWith("draw:steam_guard_error:")) {
    const parts = data.split(":");
    const mode = `${parts[0]}:${parts[1]}`.replace("draw:", "");
    const variant = mode === "acc_blocked" || mode === "steam_guard_error" || parts[2] === "id" ? "id" : "link";
    state.set(ctx.from.id, {
      mode: `draw_input:${mode}` as any,
      payload: { variant, promptMessageId: (ctx.callbackQuery as any)?.message?.message_id || null },
    });
    const imagePath =
      mode === "acc_blocked"
        ? DRAW_ACC_BLOCKED_IMAGE_PATH
        : mode === "steam_guard_error"
          ? DRAW_STEAM_GUARD_ERROR_IMAGE_PATH
          : DRAW_ADD_FRIEND_IMAGE_PATH;
    await renderPhotoPrompt(ctx, imagePath, `<blockquote>👥 Add Friend\n     ╰ отрисовка ошибки добавления в друзья по данным профиля</blockquote>\n\n👀 Отправь ссылку на профиль или SteamID:\n\n❗️ Для корректной работы отрисовщика, сначала проверьте профиль и следом скопируйте адрес из адресной строки`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", `draw:${mode}`)]]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "draw:code_dota2" || data === "draw:ban_dota2") {
    await renderPhotoPrompt(ctx, DRAW_CODE_DOTA2_IMAGE_PATH, `<blockquote>🔑 DOTA 2 Code\n     ╰ отрисовка кода DOTA 2 в выбранном режиме</blockquote>\n\n👀 Выбери режим:`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([
        [
          Markup.button.callback("🔎 Не найдено", "draw:code_dota2:not_found"),
          Markup.button.callback("🎭 Фейк-код", "draw:code_dota2:fake"),
        ],
        [Markup.button.callback("⬅️ Назад", "draw:menu")],
      ]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "draw:code_dota2:fake") {
    state.delete(ctx.from.id);
    await ctx.answerCbQuery().catch(() => null);
    await runDrawJob(
      ctx,
      makeDota2FakeCodeScreenshot,
      "Не удалось отправить скриншот кода DOTA 2.",
      Number((ctx.callbackQuery as any)?.message?.message_id || 0),
    );
    return;
  }

  if (data === "draw:code_dota2:not_found") {
    state.set(ctx.from.id, {
      mode: "draw_input:code_dota2_mammoth_code",
      payload: { promptMessageId: (ctx.callbackQuery as any)?.message?.message_id || null },
    });
    await renderPhotoPrompt(ctx, DRAW_CODE_DOTA2_IMAGE_PATH, `<blockquote>🔎 DOTA 2 Code Not Found\n     ╰ отрисовка ошибки поиска по коду DOTA 2</blockquote>\n\n👀 Отправь код мамонта:`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "draw:code_dota2")]]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "draw:qr_page") {
    const phishingLink = await getRequiredPhishingLink(ctx, me);
    if (!phishingLink) {
      await ctx.answerCbQuery().catch(() => null);
      return;
    }
    state.set(ctx.from.id, {
      mode: "draw_input:qr_page_time",
      payload: { inviteLink: phishingLink, promptMessageId: (ctx.callbackQuery as any)?.message?.message_id || null },
    });
    await renderPhotoPrompt(ctx, DRAW_QR_PAGE_IMAGE_PATH, `<blockquote>📱 QR Friend Page\n     ╰ отрисовка QR-кода на странице друзей с твоим фейком</blockquote>\n\n👀 Отправь время для скриншота:\n\n❗️ Для корректной работы отрисовщика, сначала зайдите сами на ссылку и следом скопируйте адрес из адресной строки`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "draw:menu")]]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "draw:friend_page") {
    await renderPhotoPrompt(ctx, DRAW_FRIEND_PAGE_IMAGE_PATH, `<blockquote>🧾 Friend Page\n     ╰ отрисовка страницы друга в выбранном режиме</blockquote>\n\n👀 Выбери режим:`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("✅ Обычный", "draw:friend_page:normal"), Markup.button.callback("🔎 Не найдено", "draw:friend_page:not_found")],
        [Markup.button.callback("⬅️ Назад", "draw:menu")],
      ]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "draw:friend_page:not_found") {
    await renderPhotoPrompt(ctx, DRAW_FRIEND_PAGE_IMAGE_PATH, `<blockquote>🔎 Friend Page Not Found\n     ╰ отрисовка ошибки поиска друга по коду</blockquote>\n\n👀 Выбери тип ошибки:`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ Обычный", "draw:friend_page:not_found:plain"),
          Markup.button.callback("🌍 Ошибка региона", "draw:friend_page:not_found:region_error"),
        ],
        [Markup.button.callback("⬅️ Назад", "draw:friend_page")],
      ]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("draw:friend_page:")) {
    const variant = data.includes(":not_found:") ? "not_found" : "normal";
    const showRegionMismatch = data.endsWith(":region_error");
    if (variant === "normal") {
      state.set(ctx.from.id, {
        mode: "draw_input:friend_page_normal_link",
        payload: { promptMessageId: (ctx.callbackQuery as any)?.message?.message_id || null },
      });
      await renderPhotoPrompt(ctx, DRAW_FRIEND_PAGE_IMAGE_PATH, `<blockquote>🧾 Friend Page\n     ╰ отрисовка обычной страницы друга с твоим фейком</blockquote>\n\n👀 Отправь fake-invite ссылку:\n\n❗️ Для корректной работы отрисовщика, сначала зайдите сами на ссылку и следом скопируйте адрес из адресной строки`, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "draw:friend_page")]]).reply_markup,
      });
      await ctx.answerCbQuery().catch(() => null);
      return;
    }
    const phishingLink = await getRequiredPhishingLink(ctx, me);
    if (!phishingLink) {
      await ctx.answerCbQuery().catch(() => null);
      return;
    }
    if (variant === "not_found") {
      state.set(ctx.from.id, {
        mode: "draw_input:friend_page_code",
        payload: { inviteLink: phishingLink, showRegionMismatch, promptMessageId: (ctx.callbackQuery as any)?.message?.message_id || null },
      });
      await renderPhotoPrompt(ctx, DRAW_FRIEND_PAGE_IMAGE_PATH, `<blockquote>🔎 Friend Code Not Found\n     ╰ отрисовка ошибки поиска друга по коду</blockquote>\n\n👀 Отправь код друга мамонта:`, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "draw:friend_page:not_found")]]).reply_markup,
      });
      await ctx.answerCbQuery().catch(() => null);
      return;
    }
  }

  await next();
});

async function startBot() {
  await cleanupSteamTempDirs();
  await syncBotCommands();
  startOnlineWatchLoop();
  startRentReportLoop();
  startRentDiscordBridgeLoop();
  warmupSteamRenderer().catch(() => null);
  await bot.launch();
  console.log("Bot started");
}

void startBot();

process.once("SIGINT", async () => {
  bot.stop("SIGINT");
  await closeSteamRenderer();
});

process.once("SIGTERM", async () => {
  bot.stop("SIGTERM");
  await closeSteamRenderer();
});
