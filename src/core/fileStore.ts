import fs from "node:fs";
import path from "node:path";

type AnyRow = Record<string, any>;

type UserRow = {
  id: number;
  tg_id: number;
  tg_username: string | null;
  registered_at: string | null;
  is_approved: number;
  is_banned: number;
  discord_tag: string | null;
  discord_id: string | null;
  discord_avatar_url: string | null;
  profile_views: number;
  profile_currency: string;
  sessions_given: number;
  sessions_taken: number;
  sessions_failed: number;
  total_given_usd: number;
  total_taken_usd: number;
  worker_taken: number;
  worker_taken_usd: number;
  worker_failed: number;
  worker_failed_usd: number;
  total_failed_usd: number;
  total_dodep_usd: number;
  total_dodep_yuan: number;
};

type NotificationPrefsRow = {
  id: number;
  user_id: number;
  notif_work: number;
  notif_join: number;
  notif_panel: number;
  notif_rent: number;
  phishing_link?: string | null;
};

type AppStoreState = {
  users: UserRow[];
  user_roles: Array<{ id: number; user_id: number; role: string }>;
  rentals: AnyRow[];
  guard_attempts: AnyRow[];
  online_watch: AnyRow[];
  work_requests: AnyRow[];
  work_request_messages: AnyRow[];
  panel_requests: AnyRow[];
  panel_request_messages: AnyRow[];
  rent_request_messages: AnyRow[];
  notification_prefs: NotificationPrefsRow[];
  logs: AnyRow[];
};

function cloneRow<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function normalizeState(raw: any): AppStoreState {
  const base: AppStoreState = {
    users: [],
    user_roles: [],
    rentals: [],
    guard_attempts: [],
    online_watch: [],
    work_requests: [],
    work_request_messages: [],
    panel_requests: [],
    panel_request_messages: [],
    rent_request_messages: [],
    notification_prefs: [],
    logs: [],
  };
  const state = { ...base, ...(raw || {}) } as AppStoreState;
  state.users = Array.isArray(state.users) ? state.users : [];
  state.user_roles = Array.isArray(state.user_roles) ? state.user_roles : [];
  state.rentals = Array.isArray(state.rentals) ? state.rentals : [];
  state.guard_attempts = Array.isArray(state.guard_attempts) ? state.guard_attempts : [];
  state.online_watch = Array.isArray(state.online_watch) ? state.online_watch : [];
  state.work_requests = Array.isArray(state.work_requests) ? state.work_requests : [];
  state.work_request_messages = Array.isArray(state.work_request_messages) ? state.work_request_messages : [];
  state.panel_requests = Array.isArray(state.panel_requests) ? state.panel_requests : [];
  state.panel_request_messages = Array.isArray(state.panel_request_messages) ? state.panel_request_messages : [];
  state.rent_request_messages = Array.isArray(state.rent_request_messages) ? state.rent_request_messages : [];
  state.notification_prefs = Array.isArray(state.notification_prefs) ? state.notification_prefs : [];
  state.logs = Array.isArray(state.logs) ? state.logs : [];
  return state;
}

function normalizeUser(row: Partial<UserRow> & Pick<UserRow, "tg_id">): UserRow {
  return {
    id: Number(row.id || 0),
    tg_id: Number(row.tg_id || 0),
    tg_username: row.tg_username ?? null,
    registered_at: row.registered_at ?? null,
    is_approved: Number(row.is_approved ?? 1),
    is_banned: Number(row.is_banned ?? 0),
    discord_tag: row.discord_tag ?? null,
    discord_id: row.discord_id ?? null,
    discord_avatar_url: row.discord_avatar_url ?? null,
    profile_views: Number(row.profile_views ?? 0),
    profile_currency: String(row.profile_currency || "USD"),
    sessions_given: Number(row.sessions_given ?? 0),
    sessions_taken: Number(row.sessions_taken ?? 0),
    sessions_failed: Number(row.sessions_failed ?? 0),
    total_given_usd: Number(row.total_given_usd ?? 0),
    total_taken_usd: Number(row.total_taken_usd ?? 0),
    worker_taken: Number(row.worker_taken ?? 0),
    worker_taken_usd: Number(row.worker_taken_usd ?? 0),
    worker_failed: Number(row.worker_failed ?? 0),
    worker_failed_usd: Number(row.worker_failed_usd ?? 0),
    total_failed_usd: Number(row.total_failed_usd ?? 0),
    total_dodep_usd: Number(row.total_dodep_usd ?? 0),
    total_dodep_yuan: Number(row.total_dodep_yuan ?? 0),
  };
}

function nextId(rows: Array<{ id?: number }>) {
  let max = 0;
  for (const row of rows) {
    max = Math.max(max, Number(row.id || 0));
  }
  return max + 1;
}

function asNumber(value: any) {
  return Number(value || 0);
}

function lowercase(value: any) {
  return String(value || "").trim().toLowerCase();
}

export function createFileStoreDatabase(filePathRaw: string) {
  const filePath = path.resolve(filePathRaw);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let state = normalizeState(
    fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : null,
  );
  state.users = state.users.map((row) => normalizeUser(row));

  let flushTimer: NodeJS.Timeout | null = null;
  const persist = () => {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  };
  const schedulePersist = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      persist();
    }, 25);
  };

  const ensureUserPrefs = (userId: number) => {
    let row = state.notification_prefs.find((item) => Number(item.user_id) === Number(userId));
    if (!row) {
      row = {
        id: nextId(state.notification_prefs),
        user_id: Number(userId),
        notif_work: 1,
        notif_join: 1,
        notif_panel: 1,
        notif_rent: 1,
        phishing_link: null,
      };
      state.notification_prefs.push(row);
      schedulePersist();
    } else if (!("phishing_link" in row)) {
      row.phishing_link = null;
      schedulePersist();
    }
    return row;
  };

  const getUserById = (userId: number) => state.users.find((row) => Number(row.id) === Number(userId)) || null;
  const getUserByTgId = (tgId: number) => state.users.find((row) => Number(row.tg_id) === Number(tgId)) || null;
  const getUserByQuery = (query: string | number) => {
    const raw = String(query || "").trim();
    const numericId = Number(raw || -1);
    return (
      state.users.find((row) => Number(row.id) === numericId) ||
      state.users.find((row) => lowercase(row.discord_tag) === lowercase(raw)) ||
      state.users.find((row) => lowercase(row.tg_username) === lowercase(raw.replace(/^@/, ""))) ||
      null
    );
  };

  const api = {
    store: {
      getState: () => state,
      saveNow: () => persist(),
      ensureUserPrefs,
      getPendingWorkRequests: () =>
        state.work_requests
          .filter((row) => String(row.status || "") === "PENDING")
          .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))
          .map((row) => cloneRow(row)),
      getPendingPanelRequests: () =>
        state.panel_requests
          .filter((row) => String(row.status || "") === "PENDING")
          .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))
          .map((row) => cloneRow(row)),
      getUserById: (userId: number) => {
        const row = getUserById(userId);
        return row ? cloneRow(row) : null;
      },
    },
    exec: (_sql: string) => {},
    prepare(sqlRaw: string) {
      const sql = String(sqlRaw || "").replace(/\s+/g, " ").trim();
      const upper = sql.toUpperCase();
      const noop = {
        run: (..._args: any[]) => ({ changes: 0, lastInsertRowid: 0 }),
        get: (..._args: any[]) => undefined,
        all: (..._args: any[]) => [],
      };

      if (upper === "SELECT * FROM USERS WHERE TG_ID = ?") {
        return {
          ...noop,
          get: (tgId: number) => {
            const row = getUserByTgId(tgId);
            return row ? cloneRow(row) : undefined;
          },
        };
      }

      if (upper === "SELECT * FROM USERS WHERE ID = ?" || upper === "SELECT * FROM USERS WHERE ID = ? LIMIT 1") {
        return {
          ...noop,
          get: (userId: number) => {
            const row = getUserById(userId);
            return row ? cloneRow(row) : undefined;
          },
        };
      }

      if (upper === "SELECT TG_ID FROM USERS WHERE ID = ?") {
        return {
          ...noop,
          get: (userId: number) => {
            const row = getUserById(userId);
            return row ? { tg_id: row.tg_id } : undefined;
          },
        };
      }

      if (upper === "SELECT ID FROM USERS WHERE TG_ID = ?") {
        return {
          ...noop,
          get: (tgId: number) => {
            const row = getUserByTgId(tgId);
            return row ? { id: row.id } : undefined;
          },
        };
      }

      if (upper.includes("SELECT * FROM USERS WHERE ID = ? OR LOWER(IFNULL(DISCORD_TAG,'')) = LOWER(?) OR LOWER(IFNULL(TG_USERNAME,'')) = LOWER(?) LIMIT 1")) {
        return {
          ...noop,
          get: (idValue: number, queryRaw: string, usernameRaw: string) => {
            const row =
              state.users.find((item) => Number(item.id) === Number(idValue)) ||
              state.users.find((item) => lowercase(item.discord_tag) === lowercase(queryRaw)) ||
              state.users.find((item) => lowercase(item.tg_username) === lowercase(usernameRaw)) ||
              null;
            return row ? cloneRow(row) : undefined;
          },
        };
      }

      if (upper === "INSERT OR IGNORE INTO USERS (TG_ID, TG_USERNAME, REGISTERED_AT) VALUES (?, ?, ?)") {
        return {
          ...noop,
          run: (tgId: number, tgUsername: string | null, registeredAt: string | null) => {
            const exists = getUserByTgId(tgId);
            if (exists) return { changes: 0, lastInsertRowid: exists.id };
            const row = normalizeUser({
              id: nextId(state.users),
              tg_id: Number(tgId),
              tg_username: tgUsername ?? null,
              registered_at: registeredAt ?? null,
              is_approved: 1,
            });
            state.users.push(row);
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "SELECT ROLE FROM USER_ROLES WHERE USER_ID = ?") {
        return {
          ...noop,
          all: (userId: number) =>
            state.user_roles
              .filter((row) => Number(row.user_id) === Number(userId))
              .map((row) => ({ role: row.role })),
        };
      }

      if (upper.startsWith("INSERT OR IGNORE INTO USER_ROLES (USER_ID, ROLE) VALUES (?, ")) {
        const roleMatch = sql.match(/VALUES\s*\(\?,\s*'([^']+)'\s*\)/i);
        const role = String(roleMatch?.[1] || "");
        return {
          ...noop,
          run: (userId: number) => {
            const exists = state.user_roles.find(
              (row) => Number(row.user_id) === Number(userId) && String(row.role) === role,
            );
            if (exists) return { changes: 0, lastInsertRowid: exists.id };
            const row = { id: nextId(state.user_roles), user_id: Number(userId), role };
            state.user_roles.push(row);
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "UPDATE USERS SET IS_APPROVED = 1 WHERE ID = ?") {
        return {
          ...noop,
          run: (userId: number) => {
            const row = getUserById(userId);
            if (!row) return { changes: 0, lastInsertRowid: 0 };
            row.is_approved = 1;
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "UPDATE USERS SET PROFILE_VIEWS = PROFILE_VIEWS + 1 WHERE ID = ?") {
        return {
          ...noop,
          run: (userId: number) => {
            const row = getUserById(userId);
            if (!row) return { changes: 0, lastInsertRowid: 0 };
            row.profile_views += 1;
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "UPDATE USERS SET PROFILE_CURRENCY = ? WHERE ID = ?") {
        return {
          ...noop,
          run: (currency: string, userId: number) => {
            const row = getUserById(userId);
            if (!row) return { changes: 0, lastInsertRowid: 0 };
            row.profile_currency = String(currency || "USD").toUpperCase();
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      const userAccumulationPatterns: Array<{
        key: string;
        fields: string[];
      }> = [
        {
          key: "UPDATE USERS SET SESSIONS_GIVEN = SESSIONS_GIVEN + ?, TOTAL_GIVEN_USD = TOTAL_GIVEN_USD + ? WHERE ID = ?",
          fields: ["sessions_given", "total_given_usd"],
        },
        {
          key: "UPDATE USERS SET SESSIONS_TAKEN = SESSIONS_TAKEN + ?, TOTAL_TAKEN_USD = TOTAL_TAKEN_USD + ? WHERE ID = ?",
          fields: ["sessions_taken", "total_taken_usd"],
        },
        {
          key: "UPDATE USERS SET WORKER_TAKEN = WORKER_TAKEN + ?, WORKER_TAKEN_USD = WORKER_TAKEN_USD + ? WHERE ID = ?",
          fields: ["worker_taken", "worker_taken_usd"],
        },
        {
          key: "UPDATE USERS SET SESSIONS_FAILED = SESSIONS_FAILED + 1, TOTAL_FAILED_USD = TOTAL_FAILED_USD + ? WHERE ID = ?",
          fields: ["sessions_failed", "total_failed_usd"],
        },
        {
          key: "UPDATE USERS SET WORKER_FAILED = WORKER_FAILED + 1, WORKER_FAILED_USD = WORKER_FAILED_USD + ? WHERE ID = ?",
          fields: ["worker_failed", "worker_failed_usd"],
        },
        {
          key: "UPDATE USERS SET TOTAL_DODEP_USD = TOTAL_DODEP_USD + ? WHERE ID = ?",
          fields: ["total_dodep_usd"],
        },
        {
          key: "UPDATE USERS SET TOTAL_DODEP_YUAN = TOTAL_DODEP_YUAN + ? WHERE ID = ?",
          fields: ["total_dodep_yuan"],
        },
      ];
      for (const pattern of userAccumulationPatterns) {
        if (upper === pattern.key) {
          return {
            ...noop,
            run: (...args: any[]) => {
              const userId = Number(args[pattern.fields.length] || 0);
              const row = getUserById(userId);
              if (!row) return { changes: 0, lastInsertRowid: 0 };
              const mutableRow = row as Record<string, any>;
              pattern.fields.forEach((field, index) => {
                if (field.endsWith("_failed") && pattern.key.includes("+ 1")) {
                  mutableRow[field] = asNumber(mutableRow[field]) + 1;
                  return;
                }
                mutableRow[field] = asNumber(mutableRow[field]) + Number(args[index] || 0);
              });
              schedulePersist();
              return { changes: 1, lastInsertRowid: row.id };
            },
          };
        }
      }

      if (upper === "SELECT COUNT(*) C FROM USERS WHERE IS_APPROVED = 1") {
        return {
          ...noop,
          get: () => ({ c: state.users.filter((row) => Number(row.is_approved) === 1).length }),
        };
      }

      if (upper === "SELECT COUNT(*) C FROM USERS") {
        return {
          ...noop,
          get: () => ({ c: state.users.length }),
        };
      }

      if (upper === "INSERT INTO LOGS (ACTOR_USER_ID, ACTOR_TG_ID, ACTOR_ROLE, EVENT_TYPE, DETAILS, CREATED_AT) VALUES (?, ?, ?, ?, ?, ?)") {
        return {
          ...noop,
          run: (actorUserId: number | null, actorTgId: number | null, actorRole: string, eventType: string, details: string, createdAt: string) => {
            const row = {
              id: nextId(state.logs),
              actor_user_id: actorUserId,
              actor_tg_id: actorTgId,
              actor_role: actorRole,
              event_type: eventType,
              details,
              created_at: createdAt,
            };
            state.logs.push(row);
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "INSERT OR IGNORE INTO NOTIFICATION_PREFS (USER_ID, NOTIF_WORK, NOTIF_JOIN, NOTIF_PANEL, NOTIF_RENT) VALUES (?, 1, 1, 1, 1)") {
        return {
          ...noop,
          run: (userId: number) => {
            const row = ensureUserPrefs(Number(userId));
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "SELECT NOTIF_RENT FROM NOTIFICATION_PREFS WHERE USER_ID = ?") {
        return {
          ...noop,
          get: (userId: number) => {
            const row = ensureUserPrefs(Number(userId));
            return { notif_rent: row.notif_rent };
          },
        };
      }

      if (upper === "SELECT * FROM NOTIFICATION_PREFS WHERE USER_ID = ?") {
        return {
          ...noop,
          get: (userId: number) => cloneRow(ensureUserPrefs(Number(userId))),
        };
      }

      if (upper.includes("SELECT DISTINCT U.TG_ID FROM USERS U JOIN USER_ROLES R ON R.USER_ID = U.ID LEFT JOIN NOTIFICATION_PREFS NP ON NP.USER_ID = U.ID")) {
        return {
          ...noop,
          all: () => {
            const needWork = upper.includes("NP.NOTIF_WORK");
            const needPanel = upper.includes("NP.NOTIF_PANEL");
            const roles = upper.includes("R.ROLE IN ('ADMIN','DOBIVER')") ? new Set(["ADMIN", "DOBIVER"]) : new Set(["ADMIN"]);
            const seen = new Set<number>();
            const rows: Array<{ tg_id: number }> = [];
            for (const roleRow of state.user_roles) {
              if (!roles.has(String(roleRow.role))) continue;
              const user = getUserById(Number(roleRow.user_id));
              if (!user || Number(user.is_banned || 0) === 1) continue;
              const prefs = ensureUserPrefs(user.id);
              if (needWork && Number(prefs.notif_work || 0) !== 1) continue;
              if (needPanel && Number(prefs.notif_panel || 0) !== 1) continue;
              if (seen.has(Number(user.tg_id))) continue;
              seen.add(Number(user.tg_id));
              rows.push({ tg_id: Number(user.tg_id) });
            }
            return rows;
          },
        };
      }

      if (upper.includes("SELECT DISTINCT U.ID, U.TG_ID FROM USERS U JOIN USER_ROLES R ON R.USER_ID = U.ID LEFT JOIN NOTIFICATION_PREFS NP ON NP.USER_ID = U.ID")) {
        return {
          ...noop,
          all: () => {
            const rows: Array<{ id: number; tg_id: number }> = [];
            const seen = new Set<number>();
            for (const roleRow of state.user_roles) {
              if (String(roleRow.role) !== "ADMIN") continue;
              const user = getUserById(Number(roleRow.user_id));
              if (!user || Number(user.is_banned || 0) === 1) continue;
              const prefs = ensureUserPrefs(user.id);
              if (Number(prefs.notif_join || 0) !== 1) continue;
              if (seen.has(Number(user.id))) continue;
              seen.add(Number(user.id));
              rows.push({ id: Number(user.id), tg_id: Number(user.tg_id) });
            }
            return rows;
          },
        };
      }

      if (upper === "SELECT * FROM RENTALS WHERE NUMBER = ?") {
        return {
          ...noop,
          get: (number: number) => {
            const row = state.rentals.find((item) => Number(item.number) === Number(number));
            return row ? cloneRow(row) : undefined;
          },
        };
      }

      if (upper === "SELECT * FROM RENTALS WHERE ID = ?") {
        return {
          ...noop,
          get: (id: number) => {
            const row = state.rentals.find((item) => Number(item.id) === Number(id));
            return row ? cloneRow(row) : undefined;
          },
        };
      }

      if (upper === "SELECT * FROM RENTALS ORDER BY ID DESC LIMIT 50") {
        return {
          ...noop,
          all: () => cloneRow(state.rentals.slice().sort((a, b) => Number(b.id || 0) - Number(a.id || 0)).slice(0, 50)),
        };
      }

      if (upper === "SELECT NUMBER, TITLE FROM RENTALS ORDER BY ID DESC LIMIT 50") {
        return {
          ...noop,
          all: () =>
            state.rentals
              .slice()
              .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))
              .slice(0, 50)
              .map((row) => ({ number: row.number, title: row.title })),
        };
      }

      if (upper === "SELECT NUMBER FROM RENTALS ORDER BY NUMBER DESC LIMIT 1") {
        return {
          ...noop,
          get: () => {
            const row = state.rentals.slice().sort((a, b) => Number(b.number || 0) - Number(a.number || 0))[0];
            return row ? { number: row.number } : undefined;
          },
        };
      }

      if (upper.startsWith("INSERT INTO RENTALS")) {
        return {
          ...noop,
          run: (...args: any[]) => {
            const row = {
              id: nextId(state.rentals),
              number: Number(args[0]),
              owner_user_id: Number(args[1]),
              title: args[2],
              login: args[3],
              pass: args[4],
              guard_code: args[5],
              steam_id: args[6] ?? null,
              steam_refresh_token: args[7] ?? null,
              steam_login_secure: args[8] ?? null,
              steam_login_secure_exp: args[9] ?? null,
              steam_session_id: args[10] ?? null,
              steam_browser_id: args[11] ?? null,
              description: args[12] ?? "",
              is_busy: 0,
              rented_by_user_id: null,
            };
            state.rentals.push(row);
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "UPDATE RENTALS SET TITLE = ? WHERE NUMBER = ?") {
        return {
          ...noop,
          run: (title: string, number: number) => {
            const row = state.rentals.find((item) => Number(item.number) === Number(number));
            if (!row) return { changes: 0, lastInsertRowid: 0 };
            row.title = title;
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "UPDATE RENTALS SET DESCRIPTION = ? WHERE NUMBER = ?") {
        return {
          ...noop,
          run: (description: string, number: number) => {
            const row = state.rentals.find((item) => Number(item.number) === Number(number));
            if (!row) return { changes: 0, lastInsertRowid: 0 };
            row.description = description;
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "DELETE FROM RENTALS WHERE NUMBER = ?") {
        return {
          ...noop,
          run: (number: number) => {
            const before = state.rentals.length;
            state.rentals = state.rentals.filter((item) => Number(item.number) !== Number(number));
            const changes = before - state.rentals.length;
            if (changes) schedulePersist();
            return { changes, lastInsertRowid: 0 };
          },
        };
      }

      if (upper === "DELETE FROM GUARD_ATTEMPTS WHERE RENTAL_ID NOT IN (SELECT ID FROM RENTALS)") {
        return {
          ...noop,
          run: () => {
            const existingRentalIds = new Set(state.rentals.map((row) => Number(row.id)));
            const before = state.guard_attempts.length;
            state.guard_attempts = state.guard_attempts.filter((row) => existingRentalIds.has(Number(row.rental_id)));
            const changes = before - state.guard_attempts.length;
            if (changes) schedulePersist();
            return { changes, lastInsertRowid: 0 };
          },
        };
      }

      if (upper === "UPDATE RENTALS SET IS_BUSY = 1, RENTED_BY_USER_ID = ? WHERE ID = ?") {
        return {
          ...noop,
          run: (userId: number, rentalId: number) => {
            const row = state.rentals.find((item) => Number(item.id) === Number(rentalId));
            if (!row) return { changes: 0, lastInsertRowid: 0 };
            row.is_busy = 1;
            row.rented_by_user_id = Number(userId);
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper.startsWith("UPDATE RENTALS SET STEAM_REFRESH_TOKEN = COALESCE(?, STEAM_REFRESH_TOKEN),")) {
        return {
          ...noop,
          run: (refreshToken: string | null, steamLoginSecure: string | null, steamLoginSecureExp: string | null, sessionId: string | null, browserId: string | null, steamId: string | null, rentalId: number) => {
            const row = state.rentals.find((item) => Number(item.id) === Number(rentalId));
            if (!row) return { changes: 0, lastInsertRowid: 0 };
            row.steam_refresh_token = refreshToken || row.steam_refresh_token || null;
            row.steam_login_secure = steamLoginSecure;
            row.steam_login_secure_exp = steamLoginSecureExp;
            row.steam_session_id = sessionId;
            row.steam_browser_id = browserId;
            row.steam_id = steamId || row.steam_id || null;
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "SELECT * FROM GUARD_ATTEMPTS WHERE RENTAL_ID = ? AND USER_ID = ?") {
        return {
          ...noop,
          get: (rentalId: number, userId: number) => {
            const row = state.guard_attempts.find(
              (item) => Number(item.rental_id) === Number(rentalId) && Number(item.user_id) === Number(userId),
            );
            return row ? cloneRow(row) : undefined;
          },
        };
      }

      if (upper.startsWith("INSERT INTO GUARD_ATTEMPTS (RENTAL_ID, USER_ID, ATTEMPTS_LEFT) VALUES (?, ?, 1) ON CONFLICT")) {
        return {
          ...noop,
          run: (rentalId: number, userId: number) => {
            const row = state.guard_attempts.find(
              (item) => Number(item.rental_id) === Number(rentalId) && Number(item.user_id) === Number(userId),
            );
            if (row) {
              row.attempts_left = 1;
              schedulePersist();
              return { changes: 1, lastInsertRowid: row.id };
            }
            const created = {
              id: nextId(state.guard_attempts),
              rental_id: Number(rentalId),
              user_id: Number(userId),
              attempts_left: 1,
            };
            state.guard_attempts.push(created);
            schedulePersist();
            return { changes: 1, lastInsertRowid: created.id };
          },
        };
      }

      if (upper === "UPDATE GUARD_ATTEMPTS SET ATTEMPTS_LEFT = ATTEMPTS_LEFT - 1 WHERE ID = ?") {
        return {
          ...noop,
          run: (id: number) => {
            const row = state.guard_attempts.find((item) => Number(item.id) === Number(id));
            if (!row) return { changes: 0, lastInsertRowid: 0 };
            row.attempts_left = Math.max(0, Number(row.attempts_left || 0) - 1);
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "SELECT ID FROM ONLINE_WATCH WHERE USER_ID = ? AND PROFILE_URL = ?") {
        return {
          ...noop,
          get: (userId: number, profileUrl: string) => {
            const row = state.online_watch.find(
              (item) => Number(item.user_id) === Number(userId) && String(item.profile_url) === String(profileUrl),
            );
            return row ? { id: row.id } : undefined;
          },
        };
      }

      if (upper === "INSERT INTO ONLINE_WATCH (USER_ID, PROFILE_URL, COMMENT) VALUES (?, ?, ?)") {
        return {
          ...noop,
          run: (userId: number, profileUrl: string, comment: string | null) => {
            const row = {
              id: nextId(state.online_watch),
              user_id: Number(userId),
              profile_url: profileUrl,
              comment: comment ?? null,
            };
            state.online_watch.push(row);
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "DELETE FROM ONLINE_WATCH WHERE ID = ?") {
        return {
          ...noop,
          run: (id: number) => {
            const before = state.online_watch.length;
            state.online_watch = state.online_watch.filter((item) => Number(item.id) !== Number(id));
            const changes = before - state.online_watch.length;
            if (changes) schedulePersist();
            return { changes, lastInsertRowid: 0 };
          },
        };
      }

      if (upper === "SELECT OW.ID, OW.PROFILE_URL, OW.COMMENT, U.TG_ID FROM ONLINE_WATCH OW JOIN USERS U ON U.ID = OW.USER_ID ORDER BY OW.ID ASC") {
        return {
          ...noop,
          all: () =>
            state.online_watch
              .slice()
              .sort((a, b) => Number(a.id || 0) - Number(b.id || 0))
              .map((watch) => {
                const user = getUserById(Number(watch.user_id));
                return user
                  ? {
                      id: watch.id,
                      profile_url: watch.profile_url,
                      comment: watch.comment ?? null,
                      tg_id: user.tg_id,
                    }
                  : null;
              })
              .filter(Boolean),
        };
      }

      if (upper === "SELECT NUMBER FROM WORK_REQUESTS ORDER BY NUMBER DESC LIMIT 1") {
        return {
          ...noop,
          get: () => {
            const row = state.work_requests.slice().sort((a, b) => Number(b.number || 0) - Number(a.number || 0))[0];
            return row ? { number: row.number } : undefined;
          },
        };
      }

      if (upper.startsWith("INSERT INTO WORK_REQUESTS (NUMBER, OWNER_ID, STEAM_ID, AMOUNT_USD, REGION, STATUS, CREATED_AT) VALUES (?, ?, ?, ?, ?, 'PENDING', ?)")) {
        return {
          ...noop,
          run: (number: number, ownerId: number, steamId: string, amountUsd: number, region: string, createdAt: string) => {
            const row = {
              id: nextId(state.work_requests),
              number: Number(number),
              owner_id: Number(ownerId),
              steam_id: steamId,
              amount_usd: Number(amountUsd || 0),
              region,
              status: "PENDING",
              created_at: createdAt,
              closed_at: null,
              worker_id: null,
              rejection_reason: null,
              bot_link: null,
              fail_reason: null,
              dodep_usd: 0,
              dodep_yuan: 0,
            };
            state.work_requests.push(row);
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "SELECT COUNT(*) C FROM WORK_REQUESTS WHERE STATUS = 'PENDING' AND ID < ?") {
        return {
          ...noop,
          get: (id: number) => ({
            c: state.work_requests.filter((row) => String(row.status) === "PENDING" && Number(row.id) < Number(id)).length,
          }),
        };
      }

      if (upper === "SELECT ID, STATUS FROM WORK_REQUESTS WHERE ID = ?") {
        return {
          ...noop,
          get: (id: number) => {
            const row = state.work_requests.find((item) => Number(item.id) === Number(id));
            return row ? { id: row.id, status: row.status } : undefined;
          },
        };
      }

      if (upper === "SELECT * FROM WORK_REQUESTS WHERE ID = ?") {
        return {
          ...noop,
          get: (id: number) => {
            const row = state.work_requests.find((item) => Number(item.id) === Number(id));
            return row ? cloneRow(row) : undefined;
          },
        };
      }

      if (upper === "SELECT * FROM WORK_REQUESTS WHERE NUMBER = ?") {
        return {
          ...noop,
          get: (number: number) => {
            const row = state.work_requests.find((item) => Number(item.number) === Number(number));
            return row ? cloneRow(row) : undefined;
          },
        };
      }

      if (upper === "DELETE FROM WORK_REQUEST_MESSAGES WHERE WORK_REQUEST_ID = ?") {
        return {
          ...noop,
          run: (workRequestId: number) => {
            const before = state.work_request_messages.length;
            state.work_request_messages = state.work_request_messages.filter(
              (item) => Number(item.work_request_id) !== Number(workRequestId),
            );
            const changes = before - state.work_request_messages.length;
            if (changes) schedulePersist();
            return { changes, lastInsertRowid: 0 };
          },
        };
      }

      if (upper === "INSERT INTO WORK_REQUEST_MESSAGES (WORK_REQUEST_ID, ADMIN_TG_ID, MESSAGE_ID) VALUES (?, ?, ?)") {
        return {
          ...noop,
          run: (workRequestId: number, adminTgId: number, messageId: number) => {
            const row = {
              id: nextId(state.work_request_messages),
              work_request_id: Number(workRequestId),
              admin_tg_id: Number(adminTgId),
              message_id: Number(messageId),
            };
            state.work_request_messages.push(row);
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "SELECT ADMIN_TG_ID, MESSAGE_ID FROM WORK_REQUEST_MESSAGES WHERE WORK_REQUEST_ID = ?") {
        return {
          ...noop,
          all: (workRequestId: number) =>
            state.work_request_messages
              .filter((item) => Number(item.work_request_id) === Number(workRequestId))
              .map((item) => ({ admin_tg_id: item.admin_tg_id, message_id: item.message_id })),
        };
      }

      if (upper === "UPDATE WORK_REQUESTS SET STATUS = 'TAKEN', WORKER_ID = ? WHERE ID = ?") {
        return {
          ...noop,
          run: (workerId: number, workRequestId: number) => {
            const row = state.work_requests.find((item) => Number(item.id) === Number(workRequestId));
            if (!row || String(row.status) !== "PENDING") return { changes: 0, lastInsertRowid: 0 };
            row.status = "TAKEN";
            row.worker_id = Number(workerId);
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "UPDATE WORK_REQUESTS SET STATUS = 'REJECTED', REJECTION_REASON = ?, CLOSED_AT = ? WHERE ID = ? AND STATUS = 'PENDING'") {
        return {
          ...noop,
          run: (reason: string | null, closedAt: string, workRequestId: number) => {
            const row = state.work_requests.find((item) => Number(item.id) === Number(workRequestId));
            if (!row || String(row.status) !== "PENDING") return { changes: 0, lastInsertRowid: 0 };
            row.status = "REJECTED";
            row.rejection_reason = reason;
            row.closed_at = closedAt;
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "UPDATE WORK_REQUESTS SET STATUS = 'COMPLETED', BOT_LINK = ?, AMOUNT_USD = ?, CLOSED_AT = ? WHERE ID = ?") {
        return {
          ...noop,
          run: (botLink: string, amountUsd: number, closedAt: string, workRequestId: number) => {
            const row = state.work_requests.find((item) => Number(item.id) === Number(workRequestId));
            if (!row) return { changes: 0, lastInsertRowid: 0 };
            row.status = "COMPLETED";
            row.bot_link = botLink;
            row.amount_usd = Number(amountUsd || 0);
            row.closed_at = closedAt;
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "UPDATE WORK_REQUESTS SET STATUS = 'FAILED', FAIL_REASON = ?, CLOSED_AT = ? WHERE ID = ?") {
        return {
          ...noop,
          run: (reason: string, closedAt: string, workRequestId: number) => {
            const row = state.work_requests.find((item) => Number(item.id) === Number(workRequestId));
            if (!row) return { changes: 0, lastInsertRowid: 0 };
            row.status = "FAILED";
            row.fail_reason = reason;
            row.closed_at = closedAt;
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "UPDATE WORK_REQUESTS SET DODEP_USD = DODEP_USD + ? WHERE ID = ?") {
        return {
          ...noop,
          run: (amount: number, workRequestId: number) => {
            const row = state.work_requests.find((item) => Number(item.id) === Number(workRequestId));
            if (!row) return { changes: 0, lastInsertRowid: 0 };
            row.dodep_usd = Number(row.dodep_usd || 0) + Number(amount || 0);
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "UPDATE WORK_REQUESTS SET DODEP_YUAN = DODEP_YUAN + ? WHERE ID = ?") {
        return {
          ...noop,
          run: (amount: number, workRequestId: number) => {
            const row = state.work_requests.find((item) => Number(item.id) === Number(workRequestId));
            if (!row) return { changes: 0, lastInsertRowid: 0 };
            row.dodep_yuan = Number(row.dodep_yuan || 0) + Number(amount || 0);
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "SELECT NUMBER FROM PANEL_REQUESTS ORDER BY NUMBER DESC LIMIT 1") {
        return {
          ...noop,
          get: () => {
            const row = state.panel_requests.slice().sort((a, b) => Number(b.number || 0) - Number(a.number || 0))[0];
            return row ? { number: row.number } : undefined;
          },
        };
      }

      if (upper.startsWith("INSERT INTO PANEL_REQUESTS (NUMBER, USER_ID, STEAM_ID, STATUS, CREATED_AT) VALUES (?, ?, ?, 'PENDING', ?)")) {
        return {
          ...noop,
          run: (number: number, userId: number, steamId: string, createdAt: string) => {
            const row = {
              id: nextId(state.panel_requests),
              number: Number(number),
              user_id: Number(userId),
              steam_id: steamId,
              status: "PENDING",
              created_at: createdAt,
              reviewed_by_user_id: null,
            };
            state.panel_requests.push(row);
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "INSERT INTO PANEL_REQUEST_MESSAGES (PANEL_REQUEST_ID, ADMIN_TG_ID, MESSAGE_ID) VALUES (?, ?, ?)") {
        return {
          ...noop,
          run: (panelRequestId: number, adminTgId: number, messageId: number) => {
            const row = {
              id: nextId(state.panel_request_messages),
              panel_request_id: Number(panelRequestId),
              admin_tg_id: Number(adminTgId),
              message_id: Number(messageId),
            };
            state.panel_request_messages.push(row);
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "SELECT ADMIN_TG_ID, MESSAGE_ID FROM PANEL_REQUEST_MESSAGES WHERE PANEL_REQUEST_ID = ?") {
        return {
          ...noop,
          all: (panelRequestId: number) =>
            state.panel_request_messages
              .filter((item) => Number(item.panel_request_id) === Number(panelRequestId))
              .map((item) => ({ admin_tg_id: item.admin_tg_id, message_id: item.message_id })),
        };
      }

      if (upper === "DELETE FROM RENT_REQUEST_MESSAGES WHERE RENTAL_ID = ? AND USER_ID = ?") {
        return {
          ...noop,
          run: (rentalId: number, userId: number) => {
            const before = state.rent_request_messages.length;
            state.rent_request_messages = state.rent_request_messages.filter(
              (item) => Number(item.rental_id) !== Number(rentalId) || Number(item.user_id) !== Number(userId),
            );
            const changes = before - state.rent_request_messages.length;
            if (changes) schedulePersist();
            return { changes, lastInsertRowid: 0 };
          },
        };
      }

      if (upper === "INSERT INTO RENT_REQUEST_MESSAGES (RENTAL_ID, USER_ID, ADMIN_TG_ID, MESSAGE_ID) VALUES (?, ?, ?, ?)") {
        return {
          ...noop,
          run: (rentalId: number, userId: number, adminTgId: number, messageId: number) => {
            const row = {
              id: nextId(state.rent_request_messages),
              rental_id: Number(rentalId),
              user_id: Number(userId),
              admin_tg_id: Number(adminTgId),
              message_id: Number(messageId),
            };
            state.rent_request_messages.push(row);
            schedulePersist();
            return { changes: 1, lastInsertRowid: row.id };
          },
        };
      }

      if (upper === "SELECT ADMIN_TG_ID, MESSAGE_ID FROM RENT_REQUEST_MESSAGES WHERE RENTAL_ID = ? AND USER_ID = ?") {
        return {
          ...noop,
          all: (rentalId: number, userId: number) =>
            state.rent_request_messages
              .filter((item) => Number(item.rental_id) === Number(rentalId) && Number(item.user_id) === Number(userId))
              .map((item) => ({ admin_tg_id: item.admin_tg_id, message_id: item.message_id })),
        };
      }

      return noop;
    },
  };

  return api;
}
