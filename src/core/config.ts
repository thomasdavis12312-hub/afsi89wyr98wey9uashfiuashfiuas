export const BOT_TOKEN = process.env.BOT_TOKEN || "";

export const ADMIN_IDS = (process.env.ADMIN_TG_IDS || "")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter(Boolean);

export const STEAM_WEB_API_KEY = (process.env.STEAM_WEB_API_KEY || "").trim();
export const STEAMWEBAPI_KEY = (process.env.STEAMWEBAPI_KEY || "").trim();
export const STEAMWEBAPI_BASE_URL = (process.env.STEAMWEBAPI_BASE_URL || "https://www.steamwebapi.com").replace(/\/+$/, "");
