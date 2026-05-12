export interface AppSettings {
  warn_before_close: boolean;
  vim_mode: boolean;
  show_file_panel: boolean;
  show_preview: boolean;
  split_direction: "horizontal" | "vertical";
  auto_compile: boolean;
  word_wrap: boolean;
  editor_font_size: "small" | "medium" | "large";
}

const SETTINGS_KEY = "eztex_settings";

const DEFAULT_SETTINGS: AppSettings = {
  warn_before_close: false,
  vim_mode: false,
  show_file_panel: true,
  show_preview: true,
  split_direction: "horizontal",
  auto_compile: true,
  word_wrap: false,
  editor_font_size: "medium",
};

function legacy_bool(key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(key);
  if (value === null) return fallback;
  return value === "true";
}

function parse_settings(value: unknown): Partial<AppSettings> {
  if (!value || typeof value !== "object") return {};
  const raw = value as Partial<AppSettings>;
  const settings: Partial<AppSettings> = {};

  if (typeof raw.warn_before_close === "boolean") settings.warn_before_close = raw.warn_before_close;
  if (typeof raw.vim_mode === "boolean") settings.vim_mode = raw.vim_mode;
  if (typeof raw.show_file_panel === "boolean") settings.show_file_panel = raw.show_file_panel;
  if (typeof raw.show_preview === "boolean") settings.show_preview = raw.show_preview;
  if (raw.split_direction === "horizontal" || raw.split_direction === "vertical") settings.split_direction = raw.split_direction;
  if (typeof raw.auto_compile === "boolean") settings.auto_compile = raw.auto_compile;
  if (typeof raw.word_wrap === "boolean") settings.word_wrap = raw.word_wrap;
  if (raw.editor_font_size === "small" || raw.editor_font_size === "medium" || raw.editor_font_size === "large") settings.editor_font_size = raw.editor_font_size;

  return settings;
}

function load_raw_settings(): Partial<AppSettings> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    return parse_settings(JSON.parse(raw));
  } catch {
    return {};
  }
}

function load_legacy_settings(existing: Partial<AppSettings>): Partial<AppSettings> {
  return {
    warn_before_close: existing.warn_before_close ?? legacy_bool("eztex_settings_warn_before_close", DEFAULT_SETTINGS.warn_before_close),
    vim_mode: existing.vim_mode ?? legacy_bool("eztex_vim_enabled", DEFAULT_SETTINGS.vim_mode),
    show_file_panel: existing.show_file_panel ?? legacy_bool("eztex_files_visible", DEFAULT_SETTINGS.show_file_panel),
    show_preview: existing.show_preview ?? legacy_bool("eztex_preview_visible", DEFAULT_SETTINGS.show_preview),
    split_direction: existing.split_direction ?? (localStorage.getItem("eztex_split_dir") === "vertical" ? "vertical" : DEFAULT_SETTINGS.split_direction),
    auto_compile: existing.auto_compile ?? legacy_bool("watch_enabled", DEFAULT_SETTINGS.auto_compile),
  };
}

export function load_settings(): AppSettings {
  const raw = load_raw_settings();
  return {
    ...DEFAULT_SETTINGS,
    ...load_legacy_settings(raw),
    ...raw,
  };
}

export function save_settings(settings: Partial<AppSettings>): void {
  const next = { ...load_settings(), ...settings };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
}

export function get_setting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return load_settings()[key];
}

export function set_setting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
  save_settings({ [key]: value } as Partial<AppSettings>);
}
