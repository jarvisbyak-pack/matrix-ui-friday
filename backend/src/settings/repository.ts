import { pool } from "../db/pool.js";

export type AccentColor = "blue" | "purple" | "red" | "green" | "custom";
export type ThemeMode = "dark" | "light" | "system";

export type UserSettings = {
  userId: string;
  accentColor: AccentColor;
  accentCustomValue: string | null;
  theme: ThemeMode;
  updatedAt?: string;
};

type UserSettingsRow = {
  user_id: string;
  accent_color: AccentColor;
  accent_custom_value: string | null;
  theme: ThemeMode;
  updated_at: Date;
};

export class UserSettingsRepository {
  async get(userId: string): Promise<UserSettings> {
    const { rows } = await pool.query<UserSettingsRow>(
      `SELECT user_id, accent_color, accent_custom_value, theme, updated_at
       FROM user_settings WHERE user_id = $1`,
      [userId]
    );
    const row = rows[0];
    if (!row) {
      return {
        userId,
        accentColor: "blue",
        accentCustomValue: null,
        theme: "dark"
      };
    }
    return {
      userId: row.user_id,
      accentColor: row.accent_color,
      accentCustomValue: row.accent_custom_value,
      theme: row.theme,
      updatedAt: row.updated_at.toISOString()
    };
  }

  async upsert(
    userId: string,
    patch: { accentColor?: AccentColor; accentCustomValue?: string | null; theme?: ThemeMode }
  ): Promise<UserSettings> {
    const current = await this.get(userId);
    const accentColor = patch.accentColor ?? current.accentColor;
    const accentCustomValue = accentColor === "custom"
      ? (patch.accentCustomValue ?? current.accentCustomValue)
      : null;

    if (accentColor === "custom" && (!accentCustomValue || !/^#[0-9A-Fa-f]{6}$/.test(accentCustomValue))) {
      throw new Error("Custom accent color must be a #RRGGBB hex code.");
    }

    const theme = patch.theme ?? current.theme;
    const { rows } = await pool.query<UserSettingsRow>(
      `INSERT INTO user_settings (user_id, accent_color, accent_custom_value, theme)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET accent_color = EXCLUDED.accent_color,
             accent_custom_value = EXCLUDED.accent_custom_value,
             theme = EXCLUDED.theme,
             updated_at = NOW()
       RETURNING user_id, accent_color, accent_custom_value, theme, updated_at`,
      [userId, accentColor, accentCustomValue, theme]
    );
    const row = rows[0]!;
    return {
      userId: row.user_id,
      accentColor: row.accent_color,
      accentCustomValue: row.accent_custom_value,
      theme: row.theme,
      updatedAt: row.updated_at.toISOString()
    };
  }
}
