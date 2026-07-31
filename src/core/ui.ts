import { Markup } from "telegraf";

export function mainKbForRole(_isAdmin: boolean) {
  return Markup.keyboard([
    ["🖌️ Отрисовка", "🟢 Чекер онлайна"],
    ["🧾 Аренда аккаунтов"],
    ["⚙️ Настройки"],
  ]).resize();
}

export const adminKb = Markup.keyboard([
  ["Пользователи", "Статистика"],
  ["Логи", "Рассылка"],
]).resize();
