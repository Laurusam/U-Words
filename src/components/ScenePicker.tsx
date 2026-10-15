import { useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { normalizeTools, toolsApi } from "../lib/contextTools";
import { SCENES, normalizeScenes } from "../lib/scenes";

// 场景多选（设置页）：识别与整理共用的术语/表达偏好，存 tools 配置的 scenes 字段。
// 保存必须先读回最新全量 tools 配置再 patch——不能像 Onboarding 那样展开 DEFAULT_TOOLS，
// 否则会把工具页已保存的字段与 onboardingDone 重置回默认。
export function ScenePicker() {
  const [scenes, setScenes] = useState<string[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void toolsApi
      .config()
      .then((config) => setScenes(normalizeScenes(config.scenes)))
      .catch((error) => setMessage(String(error)));
  }, []);

  const toggle = async (id: string) => {
    const next = scenes.includes(id) ? scenes.filter((scene) => scene !== id) : [...scenes, id];
    setScenes(next);
    try {
      const config = await toolsApi.config();
      await toolsApi.save(normalizeTools({ ...config, scenes: next }));
      await emit("tools-config");
      setMessage("");
    } catch (error) {
      setMessage(String(error));
    }
  };

  return (
    <div className="setting-row stacked scene-picker">
      <label>使用场景</label>
      <div className="scene-options">
        {SCENES.map((scene) => (
          <button key={scene.id} className={scenes.includes(scene.id) ? "selected" : ""} onClick={() => void toggle(scene.id)} title={scene.description}>
            {scene.label}
          </button>
        ))}
      </div>
      {message && (
        <small role="status">
          {message}
        </small>
      )}
    </div>
  );
}
