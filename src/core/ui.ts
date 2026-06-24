import { Markup } from "telegraf";

export const mainKb = Markup.keyboard([
  ["🖌️ Отрисовка", "🟢 Чекер онлайна"],
  ["⚙️ Настройки"],
]).resize();

export function mainKbForRole(isAdmin: boolean) {
  if (isAdmin) {
    return Markup.keyboard([
      ["🖌️ Отрисовка", "🟢 Чекер онлайна"],
      ["⚙️ Настройки"],
    ]).resize();
  }

  return Markup.keyboard([
    ["🖌️ Отрисовка", "🟢 Чекер онлайна"],
    ["⚙️ Настройки"],
  ]).resize();
}

export const adminKb = Markup.keyboard([
  ["Пользователи", "Статистика"],
  ["Логи"],
]).resize();

export function langInlineKb(currentLangRaw: string) {
  const currentLang = currentLangRaw === "en" ? "en" : "ru";
  const ruLabel = currentLang === "ru" ? "✓ Русский (RU)" : "Русский (RU)";
  const enLabel = currentLang === "en" ? "✓ English (EN)" : "English (EN)";
  return Markup.inlineKeyboard([[Markup.button.callback(ruLabel, "lang:set:ru"), Markup.button.callback(enLabel, "lang:set:en")]]);
}
