import { invoke } from "@tauri-apps/api/core";

export type SelectionSnapshot = {
  text: string;
  pid: number;
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  editable: boolean;
};

export type ActionId =
  | "dictate"
  | "edit"
  | "polish"
  | "translate"
  | "ask"
  | "image"
  | "ocr"
  | "dictionary"
  | "copy";

export const ACTIONS: Record<ActionId, string> = {
  dictate: "开始口述",
  edit: "编辑选区",
  polish: "整理选区",
  translate: "翻译选区",
  ask: "选区提问",
  image: "截图提问",
  ocr: "截图识字",
  dictionary: "加入词典",
  copy: "复制上次结果",
};

export type ToolsConfig = {
  radialEnabled: boolean;
  radialHotkey: string;
  screenshotHotkey: string;
  askHotkey: string;
  holdMs: number;
  selectionEnabled: boolean;
  selectionDelayMs: number;
  visionModel: string;
  items: ActionId[];
  scenes: string[];
  onboardingDone: boolean;
};

export const DEFAULT_TOOLS: ToolsConfig = {
  radialEnabled: true,
  radialHotkey: "CommandOrControl+Shift+R",
  screenshotHotkey: "CommandOrControl+Shift+S",
  askHotkey: "CommandOrControl+Shift+Q",
  holdMs: 350,
  selectionEnabled: true,
  selectionDelayMs: 450,
  visionModel: "",
  items: ["dictate", "edit", "ask", "image", "translate", "copy"],
  scenes: ["general"],
  onboardingDone: false,
};

export type ToolSession = {
  id: string;
  action: string;
  source: string;
  result: string;
  question: string;
  image: string | null;
  selection: SelectionSnapshot | null;
  busy: boolean;
  error: string | null;
  theme: "dark" | "light";
  messages: unknown[];
};

export const toolsApi = {
  config: async (): Promise<ToolsConfig> => ({
    ...DEFAULT_TOOLS,
    ...(await invoke<Partial<ToolsConfig> | null>("storage_read", { key: "tools" })),
  }),
  save: (value: ToolsConfig) => invoke("storage_write", { key: "tools", value }),
  selection: () => invoke<SelectionSnapshot | null>("read_selection"),
  show: (kind: "radial" | "selectionbar", selection: SelectionSnapshot | null = null) =>
    invoke("tools_show_menu", { kind, selection }),
  hide: (kind: string) => invoke("tools_hide_menu", { kind }),
  open: (action: string) => invoke<ToolSession>("tools_open", { action }),
  session: () => invoke<ToolSession | null>("tools_session"),
  close: () => invoke("tools_close"),
  run: (id: string, question: string) => invoke<ToolSession>("tools_run", { id, question }),
  replace: (id: string) => invoke("tools_replace", { id }),
  source: (id: string, source: string) => invoke("tools_set_source", { id, source }),
  screenshot: (action = "image") => invoke<ToolSession>("capture_region", { action }),
  imageExport: (id: string, copy: boolean) => invoke<string>("export_image", { id, copy }),
  attach: (id: string, data: string | null = null) =>
    invoke<ToolSession>("attach_image", { id, data }),
};

export function radialIndex(x: number, y: number, count: number, radius = 150): number | null {
  const dx = x - radius;
  const dy = y - radius;
  const distance = Math.hypot(dx, dy);
  if (count < 3 || count > 8 || distance < 42 || distance > radius) return null;
  const angle = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
  return Math.floor(
    ((angle + Math.PI / count) % (Math.PI * 2)) / ((Math.PI * 2) / count),
  );
}

export function normalizeTools(value: ToolsConfig): ToolsConfig {
  return {
    ...value,
    holdMs: Math.max(200, Math.min(1000, value.holdMs || 350)),
    selectionDelayMs: Math.max(250, Math.min(1500, value.selectionDelayMs || 450)),
    items: value.items.filter((item) => item in ACTIONS).slice(0, 8),
  };
}
