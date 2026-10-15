// 场景定义唯一来源：Onboarding 引导、设置页 ScenePicker 共用。
// 场景为识别与整理提供术语与表达偏好（后端映射表见 src-tauri/src/scenes.rs，
// 两边 id 必须一致；scripts/test-scenes.mjs 有一致性契约）。
export type SceneId = "general" | "code" | "email" | "notes" | "markdown";

export const SCENES: Array<{ id: SceneId; label: string; description: string }> = [
  { id: "general", label: "日常沟通", description: "自然口语，随和顺畅" },
  { id: "code", label: "编程与技术", description: "保留代码、命令与技术名词" },
  { id: "email", label: "商务办公", description: "正式清晰，适合邮件与公文" },
  { id: "notes", label: "会议与学习", description: "结论、要点与待办优先" },
  { id: "markdown", label: "内容创作", description: "按需使用标题、列表与引用" },
];

export const DEFAULT_SCENES: string[] = ["general"];

// 过滤未知 id 并去重；存储值不是数组时回退默认场景
export function normalizeScenes(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_SCENES];
  const known = new Set<string>(SCENES.map((scene) => scene.id));
  return Array.from(new Set(value.filter((id): id is string => typeof id === "string" && known.has(id))));
}
