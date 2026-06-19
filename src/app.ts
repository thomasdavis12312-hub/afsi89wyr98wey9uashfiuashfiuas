import "dotenv/config";
import { Input, Markup, Telegraf } from "telegraf";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ADMIN_IDS,
  BOT_TOKEN,
  STEAM_WEB_API_KEY,
  STEAMWEBAPI_BASE_URL,
  STEAMWEBAPI_KEY,
} from "./core/config";
import { adminKb, mainKbForRole } from "./core/ui";
import { createFileStoreDatabase } from "./core/fileStore";
import type { Role } from "./core/types";
import { formatOnlineWatchOfflineText, formatOnlineWatchOnlineText } from "./features/online/text";
import { escapeHtml, nowIso } from "./utils/text";

type Ctx = any;
type StatsRangeKey = "today" | "week" | "month" | "all";
type UserFlow =
  | { mode: "online_watch_profile_input" }
  | { mode: "online_watch_comment_input"; payload: { profileUrl: string } }
  | { mode: "admin_logs_search" }
  | { mode: "admin_find_user"; payload: { returnPage: number } }
  | { mode: "draw_input:add_friend"; payload: { variant: "link" | "id"; promptMessageId: number | null } }
  | { mode: "draw_input:acc_blocked"; payload: { variant: "link" | "id"; promptMessageId: number | null } }
  | { mode: "draw_input:steam_guard_error"; payload: { variant: "link" | "id"; promptMessageId: number | null } }
  | { mode: "draw_input:ban_cs2"; payload: { promptMessageId: number | null } }
  | { mode: "draw_input:code_cs2"; payload: { variant: "fake" | "not_found"; promptMessageId: number | null } }
  | { mode: "draw_input:code_cs2_mammoth_code"; payload: { profileUrl: string; promptMessageId: number | null } }
  | { mode: "draw_input:qr_page_link"; payload: { promptMessageId: number | null } }
  | { mode: "draw_input:qr_page_time"; payload: { inviteLink: string; promptMessageId: number | null } }
  | { mode: "draw_input:friend_page"; payload: { variant: "normal" | "not_found"; promptMessageId: number | null } }
  | { mode: "draw_input:friend_page_code"; payload: { inviteLink: string; promptMessageId: number | null } };

type RuntimeWatch = {
  onlineSince: number;
  messageChatId: number;
  messageId: number;
  profileUrl: string;
  comment: string | null;
  lastStatusCheckAt: number;
};

type SteamProfileData = {
  name: string;
  avatarFull: string | null;
  avatarMedium: string | null;
  avatarIcon: string | null;
  avatarFrame: string | null;
  level: string | null;
  levelClass: string | null;
  profilePageHtml: string | null;
  bodyClass: string | null;
  headerContentHtml: string | null;
  badgeHtml: string | null;
  rightColHtml: string | null;
};

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN missing");
}

const bot = new Telegraf(BOT_TOKEN);
const db = createFileStoreDatabase(process.env.STORE_PATH || "./data/bot-store.json") as any;
const store = db.store;

const LABEL_DRAW = "Отрисовка";
const LABEL_ONLINE = "Чекер онлайна";

const state = new Map<number, UserFlow>();
const uiPromptMsg = new Map<number, number>();
const adminLogsViewState = new Map<number, { query: string }>();
const onlineWatchRuntime = new Map<number, RuntimeWatch>();
const onlineWatchProbeState = new Map<number, { lastStatusCheckAt: number; onlineStreak: number }>();
let onlineWatchLoopStarted = false;

const steamIdResolveCache = new Map<string, { steamId: string; updatedAt: number }>();
const steamProfileCache = new Map<string, SteamProfileData & { updatedAt: number }>();
const STEAM_ABORT_RESOURCE_TYPES = new Set(["media", "font", "websocket"]);
const STEAM_SCREENSHOT_CLIP_DEFAULT = { x: 0, y: 122, width: 1920, height: 810 };
const STEAM_FRIEND_TEMPLATE_VIEWPORT = { width: 1920, height: 1080 };
const STEAM_FRIEND_FALLBACK_AVATAR_URL = "https://avatars.akamai.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg";

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

function rolesByUserId(userId: number): Role[] {
  return appState()
    .user_roles.filter((row: any) => Number(row.user_id) === Number(userId))
    .map((row: any) => String(row.role)) as Role[];
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
  return Array.isArray(user?.roles) && user.roles.some((role: Role) => roles.includes(role));
}

function getMainKeyboard(user: any) {
  return mainKbForRole(hasRole(user, ["ADMIN"]));
}

function formatCountLabel(value: number, singular: string, plural: string) {
  return `${value} ${value === 1 ? singular : plural}`;
}

async function showMainMenu(ctx: Ctx, user: any, text?: string) {
  const approvedCount = appState().users.filter((row: any) => Number(row.is_approved || 0) === 1).length;
  const message =
    text ||
    `<tg-emoji emoji-id="5242732781406033436">👋</tg-emoji> Добро пожаловать в <a href="https://discord.gg/criminalchina"><b>CC TEAM BOT</b></a>.\n` +
      `╰ Пользователей в боте: <b>${approvedCount}</b>`;
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
    await ctx.telegram.deleteMessage(ctx.chat.id, previousMessageId).catch(() => null);
  }
  const sent = await ctx.reply(text, extra).catch(() => null);
  if (sent?.message_id) {
    uiPromptMsg.set(userId, sent.message_id);
  }
  return sent;
}

async function sendPersistentPrompt(ctx: Ctx, text: string, extra?: any) {
  return await ctx.reply(text, extra).catch(() => null);
}

async function replaceOrReply(ctx: Ctx, text: string, extra?: any) {
  if (ctx.updateType === "callback_query" && typeof ctx.editMessageText === "function") {
    const edited = await ctx.editMessageText(text, extra).then(() => true).catch(() => false);
    if (edited) return true;
  }
  await ctx.reply(text, extra).catch(() => null);
  return false;
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
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchJsonSafe(url: string) {
  const text = await fetchTextSafe(url);
  if (!text) return null;
  try {
    return JSON.parse(text);
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

  if (STEAM_WEB_API_KEY) {
    const apiUrl = new URL("https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/");
    apiUrl.searchParams.set("key", STEAM_WEB_API_KEY);
    apiUrl.searchParams.set("vanityurl", vanity);
    const json = await fetchJsonSafe(apiUrl.toString());
    const steamId = String(json?.response?.steamid || "").trim();
    if (/^7\d{15,18}$/.test(steamId)) {
      steamIdResolveCache.set(normalized, { steamId, updatedAt: Date.now() });
      return steamId;
    }
  }

  const xml = await fetchTextSafe(`${normalized.replace(/\/+$/, "/")}?xml=1`);
  const steamId = xml?.match(/<steamID64>\s*(7\d{15,18})\s*<\/steamID64>/i)?.[1] || null;
  if (steamId) {
    steamIdResolveCache.set(normalized, { steamId, updatedAt: Date.now() });
  }
  return steamId;
}

async function detectSteamProfileOnline(profileUrl: string): Promise<boolean | null> {
  if (STEAMWEBAPI_KEY) {
    const normalized = normalizeProfileInput(profileUrl);
    const idParam = normalized?.steamId || normalized?.profileUrl || profileUrl;
    const apiUrl = new URL("/steam/api/profile", `${STEAMWEBAPI_BASE_URL}/`);
    apiUrl.searchParams.set("key", STEAMWEBAPI_KEY);
    apiUrl.searchParams.set("id", idParam);
    apiUrl.searchParams.set("format", "json");
    apiUrl.searchParams.set("production", "1");
    apiUrl.searchParams.set("no_cache", "1");
    const json = await fetchJsonSafe(apiUrl.toString());
    const onlineState = String(json?.onlinestate || "").trim().toLowerCase();
    if (onlineState) {
      return onlineState !== "offline";
    }
  }

  const steamId = await resolveSteamId64FromProfileUrl(profileUrl);
  if (!steamId) return null;

  if (STEAM_WEB_API_KEY) {
    const apiUrl = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/");
    apiUrl.searchParams.set("key", STEAM_WEB_API_KEY);
    apiUrl.searchParams.set("steamids", steamId);
    const json = await fetchJsonSafe(apiUrl.toString());
    const stateValue = Number(json?.response?.players?.[0]?.personastate);
    if (!Number.isNaN(stateValue)) {
      return stateValue > 0;
    }
  }

  const xml = await fetchTextSafe(`https://steamcommunity.com/profiles/${steamId}/?xml=1`);
  if (!xml) return null;
  if (/<onlineState>\s*online\s*<\/onlineState>/i.test(xml)) return true;
  if (/<onlineState>\s*offline\s*<\/onlineState>/i.test(xml)) return false;
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
    `Роли: <b>${escapeHtml(roles.length ? roles.join(", ") : "USER")}</b>`,
    `Статус: <b>${Number(target.is_banned || 0) ? "Забанен" : "Активен"}</b>`,
    `Регистрация: <b>${escapeHtml(formatAdminListDate(target.registered_at))}</b>`,
  ];
  const kb = Markup.inlineKeyboard([
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

function toggleUserBan(userId: number) {
  const user = getUserById(userId);
  if (!user) return null;
  user.is_banned = Number(user.is_banned || 0) ? 0 : 1;
  saveState();
  return user;
}

async function renderDrawMenu(ctx: Ctx) {
  await replaceOrReply(
    ctx,
    `<tg-emoji emoji-id="5242657215751426928">🎨</tg-emoji> <b>Отрисовка.</b> Позволяет максимально быстро создать нужный шаблон под рабочие задачи.`,
    {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("👥 Добавление в друзья", "draw:add_friend")],
        [Markup.button.callback("🧾 Страница друга", "draw:friend_page")],
        [Markup.button.callback("🔳 QR-Код страница друга", "draw:qr_page")],
        [Markup.button.callback("⛔ Аккаунт заблокирован", "draw:acc_blocked")],
        [Markup.button.callback("🛡️ Ошибка Steam Guard", "draw:steam_guard_error")],
        [Markup.button.callback("🚫 Бан CS2", "draw:ban_cs2")],
        [Markup.button.callback("🔑 Код CS2", "draw:code_cs2")],
        [Markup.button.callback("⚔️ Бан DOTA 2", "draw:ban_dota2")],
      ]).reply_markup,
    },
  );
}

async function runDrawJob(ctx: Ctx, job: () => Promise<string>, errorMessage: string) {
  let ticker: NodeJS.Timeout | null = null;
  let drawMessageId = 0;
  let screenshotPath = "";
  try {
    const frames = ["Рисую.", "Рисую..", "Рисую..."] as const;
    let frameIndex = 0;
    const statusText = () => `<b>${frames[frameIndex]}</b>`;
    const statusMessage = await ctx.reply(statusText(), { parse_mode: "HTML" });
    drawMessageId = statusMessage.message_id;
    ticker = setInterval(async () => {
      frameIndex = (frameIndex + 1) % frames.length;
      await ctx.telegram.editMessageText(ctx.chat.id, drawMessageId, undefined, statusText(), { parse_mode: "HTML" }).catch(() => null);
    }, 800);

    screenshotPath = await job();
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    await ctx.deleteMessage(drawMessageId).catch(() => null);
    await ctx.replyWithDocument(Input.fromLocalFile(screenshotPath, `IMG_${Date.now()}.png`));
    return true;
  } catch {
    if (ticker) clearInterval(ticker);
    if (drawMessageId) {
      await ctx.deleteMessage(drawMessageId).catch(() => null);
    }
    await ctx.reply(errorMessage).catch(() => null);
    return false;
  } finally {
    if (screenshotPath) {
      await fs.rm(path.dirname(screenshotPath), { recursive: true, force: true }).catch(() => null);
    }
  }
}

async function handleDrawInput(ctx: Ctx, flow: Extract<UserFlow, { mode: string }>, rawText: string) {
  const promptMessageId = Number((flow as any).payload?.promptMessageId || 0);
  if (promptMessageId > 0) {
    await ctx.telegram.deleteMessage(ctx.chat.id, promptMessageId).catch(() => null);
  }
  if (ctx.message?.message_id) {
    await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => null);
  }

  const mode = flow.mode.replace("draw_input:", "");
  const text = rawText.trim();

  if (mode === "qr_page_link") {
    try {
      const parsed = new URL(text);
      if (!/^https?:$/i.test(parsed.protocol)) throw new Error("bad");
      const sent = await ctx.reply(`<b>Введите время для скриншота.</b>`, { parse_mode: "HTML" });
      state.set(ctx.from.id, {
        mode: "draw_input:qr_page_time",
        payload: { inviteLink: parsed.toString(), promptMessageId: sent.message_id },
      });
      return;
    } catch {
      await ctx.reply("Нужна корректная ссылка http/https.");
      return;
    }
  }

  if (mode === "qr_page_time") {
    const inviteLink = String((flow as any).payload?.inviteLink || "");
    if (!inviteLink || !text) {
      await ctx.reply("Время не должно быть пустым.");
      return;
    }
    state.delete(ctx.from.id);
    await runDrawJob(ctx, () => makeSteamQrPageScreenshot(text, inviteLink), "Не удалось создать QR-страницу.");
    return;
  }

  if (mode === "friend_page_code") {
    const inviteLink = String((flow as any).payload?.inviteLink || "");
    if (!inviteLink || !text) {
      await ctx.reply("Код друга не должен быть пустым.");
      return;
    }
    state.delete(ctx.from.id);
    await runDrawJob(
      ctx,
      () => makeSteamFriendPageFromTemplateScreenshot(inviteLink, { variant: "not_found", friendCode: text }),
      "Не удалось создать страницу друга.",
    );
    return;
  }

  if (mode === "code_cs2_mammoth_code") {
    const profileUrl = String((flow as any).payload?.profileUrl || "");
    if (!profileUrl || !text) {
      await ctx.reply("Код CS2 не должен быть пустым.");
      return;
    }
    state.delete(ctx.from.id);
    await runDrawJob(
      ctx,
      () => makeSteamCodeCs2NotFoundScreenshot(profileUrl, text),
      "Не удалось создать скриншот кода CS2.",
    );
    return;
  }

  if (mode === "friend_page") {
    try {
      const parsed = new URL(text);
      if (!/^https?:$/i.test(parsed.protocol)) throw new Error("bad");
      if ((flow as any).payload?.variant === "not_found") {
        const sent = await ctx.reply(`<b>Введите код друга мамонта.</b>`, { parse_mode: "HTML" });
        state.set(ctx.from.id, {
          mode: "draw_input:friend_page_code",
          payload: { inviteLink: parsed.toString(), promptMessageId: sent.message_id },
        });
        return;
      }
      state.delete(ctx.from.id);
      await runDrawJob(
        ctx,
        () => makeSteamFriendPageFromTemplateScreenshot(parsed.toString(), { variant: "normal" }),
        "Не удалось создать страницу друга.",
      );
      return;
    } catch {
      await ctx.reply("Нужна корректная фишинг-ссылка.");
      return;
    }
  }

  const normalized = normalizeProfileInput(text);
  if (!normalized) {
    await ctx.reply(
      "Нужен SteamID или ссылка вида:\nhttps://steamcommunity.com/profiles/7656...\nhttps://steamcommunity.com/id/name/",
    );
    return;
  }

  if (mode === "code_cs2" && (flow as any).payload?.variant === "not_found") {
    const sent = await ctx.reply(`<b>Введите код CS2 мамонта.</b>`, { parse_mode: "HTML" });
    state.set(ctx.from.id, {
      mode: "draw_input:code_cs2_mammoth_code",
      payload: { profileUrl: normalized.profileUrl, promptMessageId: sent.message_id },
    });
    return;
  }

  state.delete(ctx.from.id);
  await runDrawJob(
    ctx,
    async () => {
      if (mode === "ban_cs2") {
        return makeSteamBanCs2Screenshot(normalized.profileUrl);
      }
      if (mode === "code_cs2") {
        return makeSteamCodeCs2Screenshot(normalized.profileUrl);
      }
      const variant = (flow as any).payload?.variant;
      if (mode === "add_friend" || mode === "acc_blocked" || mode === "steam_guard_error") {
        return makeSteamProfileScreenshot(normalized.profileUrl, {
          showAddFriendErrorModal: mode === "add_friend" || mode === "steam_guard_error",
          showAddFriendInviteBanner: variant === "link",
          showAccountBlockedModal: mode === "acc_blocked",
          addFriendErrorTextVariant: mode === "steam_guard_error" ? "steam_guard" : "default",
        });
      }
      return makeSteamProfileScreenshot(normalized.profileUrl);
    },
    "Не удалось создать скриншот.",
  );
}

function syncStateForRemovedWatch(watchId: number) {
  onlineWatchRuntime.delete(watchId);
  onlineWatchProbeState.delete(watchId);
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
  startOnlineWatchLoop();
  await sendCleanPrompt(
    ctx,
    `<tg-emoji emoji-id="5240187442052510372">🔔</tg-emoji> <b>Отслеживание профиля успешно включено.</b>\n\nКак только профиль появится онлайн, бот отправит уведомление.`,
    { parse_mode: "HTML" },
  );
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

async function fetchSteamProfileData(profileUrl: string): Promise<SteamProfileData | null> {
  const cached = steamProfileCache.get(profileUrl);
  if (cached && Date.now() - cached.updatedAt < 10 * 60 * 1000) {
    return { ...cached };
  }
  const normalizedRaw = profileUrl.replace(/\/+$/, "");
  const canonicalMatch = normalizedRaw.match(/(https?:\/\/[^/]+\/(?:profiles\/7\d{15,18}|id\/[A-Za-z0-9_-]{2,64}))\/?/i);
  const normalized = canonicalMatch ? canonicalMatch[1] : normalizedRaw;

  try {
    await ensureSteamRendererReady();
    await steamSourcePage.goto(normalized, { waitUntil: "domcontentloaded", timeout: 7000 });
    await steamSourcePage.waitForTimeout(90);
    const parsed = (await steamSourcePage.evaluate(() => {
      const name = (document.querySelector(".actual_persona_name") as HTMLElement | null)?.innerText?.trim() || "";
      const levelNode = document.querySelector(".friendPlayerLevelNum") as HTMLElement | null;
      const level = levelNode?.innerText?.trim() || null;
      const levelWrap = document.querySelector(".friendPlayerLevel") as HTMLElement | null;
      const levelClass = levelWrap?.className.match(/\blvl_\d+\b/)?.[0] || null;
      const avatarCandidates = Array.from(
        document.querySelectorAll(".playerAvatarAutoSizeInner img, .playerAvatar img"),
      ) as HTMLImageElement[];
      const nonFrame = avatarCandidates.filter((img) => !img.closest(".profile_avatar_frame"));
      const pick = (items: HTMLImageElement[]) =>
        items.find((img) => {
          const srcset = String(img.getAttribute("srcset") || "");
          const src = String(img.getAttribute("src") || img.src || "");
          const all = `${srcset} ${src}`.toLowerCase();
          return /_full\.(jpg|png|webp)/.test(all) || /avatars\./.test(all);
        }) || items[0] || null;
      const avatar = pick(nonFrame) || pick(avatarCandidates);
      const rawSet = String(avatar?.getAttribute("srcset") || "").split(",")[0]?.trim() || "";
      const avatarFull = rawSet.split(" ")[0] || avatar?.getAttribute("src") || avatar?.src || null;
      const frameNode =
        (document.querySelector(".profile_avatar_frame img") as HTMLImageElement | null) ||
        (document.querySelector(".profile_avatar_frame source[srcset]") as HTMLSourceElement | null);
      const frameRaw = String(frameNode?.getAttribute("srcset") || frameNode?.getAttribute("src") || "").split(",")[0]?.trim() || "";
      return {
        name,
        avatarFull,
        avatarFrame: frameRaw.split(" ")[0] || null,
        level,
        levelClass,
        profilePageHtml: (document.querySelector(".profile_page") as HTMLElement | null)?.outerHTML || null,
        bodyClass: document.body?.className || null,
        headerContentHtml: (document.querySelector(".profile_header_content") as HTMLElement | null)?.outerHTML || null,
        badgeHtml: (document.querySelector(".profile_header_badge") as HTMLElement | null)?.outerHTML || null,
        rightColHtml: (document.querySelector(".profile_rightcol") as HTMLElement | null)?.outerHTML || null,
      };
    })) as any;

    if (parsed?.name && !/^sign\s*in$/i.test(String(parsed.name).trim())) {
      const toAbs = (url: string | null) => {
        if (!url) return null;
        try {
          return new URL(url, `${normalized}/`).toString();
        } catch {
          return url;
        }
      };
      const avatarFull = toAbs(parsed.avatarFull || null);
      const avatarFrame = toAbs(parsed.avatarFrame || null);
      const result: SteamProfileData = {
        name: parsed.name,
        avatarFull,
        avatarMedium: avatarFull ? avatarFull.replace(/_full\.jpg$/i, "_medium.jpg") : null,
        avatarIcon: avatarFull ? avatarFull.replace(/_full\.jpg$/i, ".jpg") : null,
        avatarFrame,
        level: parsed.level || null,
        levelClass: parsed.levelClass || null,
        profilePageHtml: parsed.profilePageHtml || null,
        bodyClass: parsed.bodyClass || null,
        headerContentHtml: parsed.headerContentHtml || null,
        badgeHtml: parsed.badgeHtml || null,
        rightColHtml: parsed.rightColHtml || null,
      };
      steamProfileCache.set(profileUrl, { ...result, updatedAt: Date.now() });
      return result;
    }
  } catch {}

  const xml = await fetchTextSafe(`${normalized}/?xml=1`);
  if (xml) {
    const rawName = String(xml.match(/<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/i)?.[1] || "").trim();
    const avatarFull = String(xml.match(/<avatarFull><!\[CDATA\[(.*?)\]\]><\/avatarFull>/i)?.[1] || "").trim() || null;
    const avatarMedium = String(xml.match(/<avatarMedium><!\[CDATA\[(.*?)\]\]><\/avatarMedium>/i)?.[1] || "").trim() || null;
    const avatarIcon = String(xml.match(/<avatarIcon><!\[CDATA\[(.*?)\]\]><\/avatarIcon>/i)?.[1] || "").trim() || null;
    if (rawName && !/^sign\s*in$/i.test(rawName)) {
      const result: SteamProfileData = {
        name: rawName,
        avatarFull,
        avatarMedium,
        avatarIcon,
        avatarFrame: null,
        level: null,
        levelClass: null,
        profilePageHtml: null,
        bodyClass: null,
        headerContentHtml: null,
        badgeHtml: null,
        rightColHtml: null,
      };
      steamProfileCache.set(profileUrl, { ...result, updatedAt: Date.now() });
      return result;
    }
  }

  const oembed = await fetchJsonSafe(`https://steamcommunity.com/oembed?url=${encodeURIComponent(profileUrl)}`);
  const rawName = String(oembed?.author_name || oembed?.title || "").trim().replace(/^Steam Community ::\s*/i, "");
  if (!rawName || /^sign\s*in$/i.test(rawName)) return null;

  const result: SteamProfileData = {
    name: rawName,
    avatarFull: STEAM_FRIEND_FALLBACK_AVATAR_URL,
    avatarMedium: STEAM_FRIEND_FALLBACK_AVATAR_URL.replace(/_full\.jpg$/i, "_medium.jpg"),
    avatarIcon: STEAM_FRIEND_FALLBACK_AVATAR_URL.replace(/_full\.jpg$/i, ".jpg"),
    avatarFrame: null,
    level: null,
    levelClass: null,
    profilePageHtml: null,
    bodyClass: null,
    headerContentHtml: null,
    badgeHtml: null,
    rightColHtml: null,
  };
  steamProfileCache.set(profileUrl, { ...result, updatedAt: Date.now() });
  return result;
}

async function extractFriendPageDataFromInviteLink(inviteUrl: string) {
  try {
    await ensureSteamRendererReady();
    await steamSourcePage.goto(inviteUrl, { waitUntil: "domcontentloaded", timeout: 12000 });
    await steamSourcePage.waitForTimeout(120);
    const parsed = (await steamSourcePage.evaluate(() => {
      const name =
        (document.querySelector(".actual_persona_name") as HTMLElement | null)?.innerText?.trim() ||
        (document.querySelector(".persona_name .actual_persona_name") as HTMLElement | null)?.innerText?.trim() ||
        "";
      const avatarWrap = (document.querySelector(".playerAvatarAutoSizeInner") as HTMLElement | null) || null;
      const avatarSrc =
        (avatarWrap?.querySelector("img[srcset*='_full']") as HTMLImageElement | null)?.getAttribute("srcset") ||
        (avatarWrap?.querySelector("img[src*='_full']") as HTMLImageElement | null)?.getAttribute("src") ||
        null;
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
      return {
        name,
        avatarFull,
        avatarMedium: avatarFull ? avatarFull.replace(/_full\.(jpg|png|webp)$/i, "_medium.$1") : null,
        avatarFrame: toAbs(parsed.frameSrc || null),
        miniprofile: String(parsed.miniprofile || ""),
        profileUrl: toAbs(parsed.profileUrl || null),
      };
    }
  } catch {}

  return {
    name: "Cute",
    avatarFull: STEAM_FRIEND_FALLBACK_AVATAR_URL,
    avatarMedium: STEAM_FRIEND_FALLBACK_AVATAR_URL.replace(/_full\.jpg$/i, "_medium.jpg"),
    avatarFrame: null,
    miniprofile: "",
    profileUrl: inviteUrl,
  };
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

async function waitForSteamTemplateAvatar(page: any) {
  await page
    .waitForFunction(
      () => {
        const img = document.querySelector(".avatar") as HTMLImageElement | null;
        return Boolean(!img || (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0));
      },
      { timeout: 5000, polling: 100 },
    )
    .catch(() => null);
}

async function makeSteamProfileScreenshot(
  profileUrl: string,
  options?: {
    showAddFriendErrorModal?: boolean;
    showAddFriendInviteBanner?: boolean;
    showAccountBlockedModal?: boolean;
    addFriendErrorTextVariant?: "default" | "steam_guard";
  },
) {
  const task = async () => {
    const isAddFriendRender = Boolean(options?.showAddFriendErrorModal || options?.showAddFriendInviteBanner);
    await ensureSteamRendererReady();
    const page = isAddFriendRender ? steamAddFriendPage : steamPage;
    const tmpDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-steam-profile-"));
    const screenshotPath = path.join(tmpDir, `profile_${Date.now()}.png`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 12000 });
    if (isAddFriendRender) {
      await ensureSteamProfileQuickLoaded(page);
    } else {
      await ensureSteamProfileFullyLoaded(page);
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
        ({ html, clip }: { html: string; clip: { x: number; y: number; width: number; height: number } }) => {
          document.querySelector(".newmodal_background")?.remove();
          document.querySelector(".newmodal")?.remove();
          const overlay = document.createElement("div");
          overlay.className = "newmodal_background";
          overlay.style.opacity = "0.8";
          overlay.style.top = `${clip.y}px`;
          overlay.style.height = `calc(100% - ${clip.y}px)`;
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
            modal.style.left = `${clip.x + clip.width / 2}px`;
            modal.style.top = `${clip.y + clip.height / 2}px`;
            modal.style.transform = "translate(-50%, -50%)";
          }
        },
        { html: modalHtml, clip: STEAM_SCREENSHOT_CLIP_DEFAULT },
      );
    }

    await page.waitForTimeout(55);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: screenshotPath, clip: STEAM_SCREENSHOT_CLIP_DEFAULT });
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
  options?: { variant?: "normal" | "not_found"; friendCode?: string },
) {
  const task = async () => {
    await ensureSteamRendererReady();
    const profile = await extractFriendPageDataFromInviteLink(inviteUrl);
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
        if (data.variant === "not_found" && friendCodeInput) {
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
    const profile = await extractFriendPageDataFromInviteLink(inviteLink);
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

async function makeSteamBanCs2Screenshot(profileUrl: string) {
  const task = async () => {
    await ensureSteamRendererReady();
    const templatePath = path.join(process.cwd(), "src", "templates", "bancs2.png");
    const fontPath = path.join(process.cwd(), "src", "templates", "stratumno2_regular.otf");
    const templateUrl = `file:///${templatePath.replace(/\\/g, "/")}`;
    const fontUrl = `file:///${fontPath.replace(/\\/g, "/")}`;
    const profile = await fetchSteamProfileData(profileUrl);
    const avatarFull = profile?.avatarFull || STEAM_FRIEND_FALLBACK_AVATAR_URL;
    const tmpDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-steam-ban-cs2-"));
    const tempHtmlPath = path.join(tmpDir, `ban_${Date.now()}.html`);
    const screenshotPath = path.join(tmpDir, `ban_${Date.now()}.png`);
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    @font-face { font-family: "StratumNo2Regular"; src: url("${fontUrl}") format("opentype"); }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; overflow: hidden; background: #000; }
    body { position: relative; }
    .bg { position: absolute; left: 0; top: 0; width: 1280px; height: 720px; object-fit: fill; }
    .avatar { position: absolute; left: 991px; top: 724px; width: 51px; height: 51px; object-fit: cover; }
    .name { position: absolute; top: 676px; font-family: "StratumNo2Regular", sans-serif; color: #ebebeb; font-size: 16px; transform: scaleX(0.86); transform-origin: left center; white-space: nowrap; }
  </style>
</head>
<body>
  <img class="bg" src="${templateUrl}" alt="template" />
  <img class="avatar" src="${escapeHtml(avatarFull)}" alt="avatar" />
  ${profile?.name ? `<div id="profile-name" class="name">${escapeHtml(profile.name)}</div>` : ""}
</body>
</html>`;
    await fs.writeFile(tempHtmlPath, html, "utf8");
    await steamTemplatePage.goto(`file:///${tempHtmlPath.replace(/\\/g, "/")}`, { waitUntil: "domcontentloaded", timeout: 12000 });
    await steamTemplatePage.evaluate(() => {
      const name = document.getElementById("profile-name") as HTMLElement | null;
      if (!name) return;
      name.style.left = "0px";
      const measured = Math.ceil(name.getBoundingClientRect().width);
      const x = 978 + (73 - measured) / 2;
      name.style.left = `${x}px`;
    });
    const dims = await sizeSteamTemplatePageFromBackground(steamTemplatePage, { w: 1280, h: 720 });
    await waitForSteamTemplateAvatar(steamTemplatePage);
    await steamTemplatePage.screenshot({ path: screenshotPath, clip: { x: 0, y: 0, width: dims.w, height: dims.h } });
    return screenshotPath;
  };

  const run = steamRenderChain.then(task, task);
  steamRenderChain = run.then(() => undefined, () => undefined);
  return run;
}

async function makeSteamCodeCs2Screenshot(profileUrl: string) {
  const task = async () => {
    await ensureSteamRendererReady();
    const templatePath = path.join(process.cwd(), "src", "templates", "codecs2.png");
    const fontPath = path.join(process.cwd(), "src", "templates", "stratumno2_regular.otf");
    const templateUrl = `file:///${templatePath.replace(/\\/g, "/")}`;
    const fontUrl = `file:///${fontPath.replace(/\\/g, "/")}`;
    const profile = await fetchSteamProfileData(profileUrl);
    const avatarFull = profile?.avatarFull || STEAM_FRIEND_FALLBACK_AVATAR_URL;
    const tmpDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-steam-code-cs2-"));
    const tempHtmlPath = path.join(tmpDir, `code_${Date.now()}.html`);
    const screenshotPath = path.join(tmpDir, `code_${Date.now()}.png`);
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    @font-face { font-family: "StratumNo2Regular"; src: url("${fontUrl}") format("opentype"); }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; overflow: hidden; background: #000; }
    body { position: relative; }
    .bg { position: absolute; left: 0; top: 0; width: 1280px; height: 720px; object-fit: fill; }
    .avatar { position: absolute; left: 974.72px; top: 726.18px; width: 51px; height: 51px; object-fit: cover; filter: brightness(0.62); }
    .name { position: absolute; top: 676px; font-family: "StratumNo2Regular", sans-serif; color: rgb(176,176,176); font-size: 16px; transform: scaleX(0.86); transform-origin: left center; white-space: nowrap; filter: brightness(0.64); }
  </style>
</head>
<body>
  <img class="bg" src="${templateUrl}" alt="template" />
  <img class="avatar" src="${escapeHtml(avatarFull)}" alt="avatar" />
  ${profile?.name ? `<div id="profile-name" class="name">${escapeHtml(profile.name)}</div>` : ""}
</body>
</html>`;
    await fs.writeFile(tempHtmlPath, html, "utf8");
    await steamTemplatePage.goto(`file:///${tempHtmlPath.replace(/\\/g, "/")}`, { waitUntil: "domcontentloaded", timeout: 12000 });
    await steamTemplatePage.evaluate(() => {
      const name = document.getElementById("profile-name") as HTMLElement | null;
      if (!name) return;
      name.style.left = "0px";
      const measured = Math.ceil(name.getBoundingClientRect().width);
      const x = 963 + (72 - measured) / 2;
      name.style.left = `${x}px`;
    });
    const dims = await sizeSteamTemplatePageFromBackground(steamTemplatePage, { w: 1280, h: 720 });
    await waitForSteamTemplateAvatar(steamTemplatePage);
    await steamTemplatePage.screenshot({ path: screenshotPath, clip: { x: 0, y: 0, width: dims.w, height: dims.h } });
    return screenshotPath;
  };

  const run = steamRenderChain.then(task, task);
  steamRenderChain = run.then(() => undefined, () => undefined);
  return run;
}

async function makeSteamCodeCs2NotFoundScreenshot(profileUrl: string, mammothCode: string) {
  const task = async () => {
    await ensureSteamRendererReady();
    const templatePath = path.join(process.cwd(), "src", "templates", "codenotfoundcs2.png");
    const fontPath = path.join(process.cwd(), "src", "templates", "stratumno2_regular.otf");
    const templateUrl = `file:///${templatePath.replace(/\\/g, "/")}`;
    const fontUrl = `file:///${fontPath.replace(/\\/g, "/")}`;
    const profile = await fetchSteamProfileData(profileUrl);
    const avatarFull = profile?.avatarFull || STEAM_FRIEND_FALLBACK_AVATAR_URL;
    const tmpDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-steam-code-cs2-nf-"));
    const tempHtmlPath = path.join(tmpDir, `code_nf_${Date.now()}.html`);
    const screenshotPath = path.join(tmpDir, `code_nf_${Date.now()}.png`);
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    @font-face { font-family: "StratumNo2Regular"; src: url("${fontUrl}") format("opentype"); }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; overflow: hidden; background: #000; }
    body { position: relative; }
    .bg { position: absolute; left: 0; top: 0; width: 1280px; height: 720px; object-fit: fill; }
    .avatar { position: absolute; left: 972px; top: 726px; width: 51px; height: 51px; object-fit: cover; filter: brightness(0.62); }
    .name { position: absolute; top: 676px; font-family: "StratumNo2Regular", sans-serif; color: rgb(176,176,176); font-size: 16px; transform: scaleX(0.86); transform-origin: left center; white-space: nowrap; filter: brightness(0.64); }
    .code-main { position: absolute; left: 739px; top: 490px; height: 34px; display: flex; align-items: center; font-family: "StratumNo2Regular", sans-serif; color: rgb(204,204,204); font-size: 20px; white-space: nowrap; }
    .code-secondary { position: absolute; left: 734px; top: 553px; font-family: "StratumNo2Regular", sans-serif; color: rgb(199,199,199); font-size: 14px; white-space: nowrap; }
  </style>
</head>
<body>
  <img class="bg" src="${templateUrl}" alt="template" />
  <img class="avatar" src="${escapeHtml(avatarFull)}" alt="avatar" />
  ${profile?.name ? `<div id="profile-name" class="name">${escapeHtml(profile.name)}</div>` : ""}
  <div class="code-main">${escapeHtml(mammothCode)}</div>
  <div class="code-secondary">No friend found for code '${escapeHtml(mammothCode)}'</div>
</body>
</html>`;
    await fs.writeFile(tempHtmlPath, html, "utf8");
    await steamTemplatePage.goto(`file:///${tempHtmlPath.replace(/\\/g, "/")}`, { waitUntil: "domcontentloaded", timeout: 12000 });
    await steamTemplatePage.evaluate(() => {
      const name = document.getElementById("profile-name") as HTMLElement | null;
      if (!name) return;
      name.style.left = "0px";
      const measured = Math.ceil(name.getBoundingClientRect().width);
      const x = 960 + (72 - measured) / 2;
      name.style.left = `${x}px`;
    });
    const dims = await sizeSteamTemplatePageFromBackground(steamTemplatePage, { w: 1280, h: 720 });
    await waitForSteamTemplateAvatar(steamTemplatePage);
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

bot.on("text", async (ctx) => {
  const me = ensureUser(ctx);
  if (!me || Number(me.is_banned || 0) === 1) return;

  const text = String(ctx.message.text || "");
  const trimmed = text.trim();
  const normalized = trimmed.normalize("NFKC").replace(/\uFE0F/g, "");
  const plain = normalized.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const isDrawBtn = plain.startsWith("Отрисовка");
  const isOnlineBtn = plain.startsWith("Чекер онлайна");

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

  if (isDrawBtn || isOnlineBtn) {
    if (isDrawBtn) {
      await clearUserFlowOnly(ctx);
      await renderDrawMenu(ctx);
      logEvent(me, "draw", "open_menu");
      return;
    }
    await clearUserFlowOnly(ctx);
    state.set(ctx.from.id, { mode: "online_watch_profile_input" });
    await sendPersistentPrompt(
      ctx,
      `<tg-emoji emoji-id="5242657215751426928">🟢</tg-emoji> <b>Чекер онлайна.</b> Отправляет уведомление, когда нужный профиль появляется в сети\n\n<tg-emoji emoji-id="5240446651918753852">🔗</tg-emoji> Пришлите ссылку на профиль/SteamID`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
    return;
  }

  const flow = state.get(ctx.from.id);

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

  await showMainMenu(ctx, me);
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

  if (data === "draw:add_friend" || data === "draw:acc_blocked" || data === "draw:steam_guard_error") {
    const base = data.split(":")[1];
    await replaceOrReply(
      ctx,
      `<b>Что предоставил мамонт?</b>`,
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
    const variant = parts[2] === "id" ? "id" : "link";
    state.set(ctx.from.id, {
      mode: `draw_input:${mode}` as any,
      payload: { variant, promptMessageId: (ctx.callbackQuery as any)?.message?.message_id || null },
    });
    await replaceOrReply(ctx, `<b>Пришлите ссылку на профиль или SteamID.</b>`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", data.replace(`:${variant}`, ""))]]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "draw:ban_dota2") {
    await replaceOrReply(ctx, `<b>Раздел временно недоступен.</b>`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "draw:menu")]]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "draw:ban_cs2") {
    state.set(ctx.from.id, {
      mode: "draw_input:ban_cs2",
      payload: { promptMessageId: (ctx.callbackQuery as any)?.message?.message_id || null },
    });
    await replaceOrReply(ctx, `<b>Введите ссылку на профиль.</b>`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "draw:menu")]]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "draw:code_cs2") {
    await replaceOrReply(ctx, `<b>Выберите режим.</b>`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("🔎 Не найдено", "draw:code_cs2:not_found"), Markup.button.callback("🎭 Фейк-код", "draw:code_cs2:fake")],
        [Markup.button.callback("⬅️ Назад", "draw:menu")],
      ]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("draw:code_cs2:")) {
    const variant = data.endsWith(":not_found") ? "not_found" : "fake";
    state.set(ctx.from.id, {
      mode: "draw_input:code_cs2",
      payload: { variant, promptMessageId: (ctx.callbackQuery as any)?.message?.message_id || null },
    });
    await replaceOrReply(ctx, `<b>Введите ссылку на профиль.</b>`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "draw:code_cs2")]]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "draw:qr_page") {
    state.set(ctx.from.id, {
      mode: "draw_input:qr_page_link",
      payload: { promptMessageId: (ctx.callbackQuery as any)?.message?.message_id || null },
    });
    await replaceOrReply(ctx, `<b>Введите фишинг-ссылку.</b>`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "draw:menu")]]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "draw:friend_page") {
    await replaceOrReply(ctx, `<b>Выберите режим.</b>`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("✅ Обычный", "draw:friend_page:normal"), Markup.button.callback("🔎 Не найдено", "draw:friend_page:not_found")],
        [Markup.button.callback("⬅️ Назад", "draw:menu")],
      ]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("draw:friend_page:")) {
    const variant = data.endsWith(":not_found") ? "not_found" : "normal";
    state.set(ctx.from.id, {
      mode: "draw_input:friend_page",
      payload: { variant, promptMessageId: (ctx.callbackQuery as any)?.message?.message_id || null },
    });
    await replaceOrReply(ctx, `<b>Введите фишинг-ссылку.</b>`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "draw:friend_page")]]).reply_markup,
    });
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  await next();
});

async function startBot() {
  await cleanupSteamTempDirs();
  await syncBotCommands();
  startOnlineWatchLoop();
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
