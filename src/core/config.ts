export const BOT_TOKEN = process.env.BOT_TOKEN || "";

export const ADMIN_IDS = (process.env.ADMIN_TG_IDS || "")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter(Boolean);
