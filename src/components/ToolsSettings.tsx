import { useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { ACTIONS, DEFAULT_TOOLS, normalizeTools, toolsApi } from "../lib/contextTools";
import type { ActionId, ToolsConfig } from "../lib/contextTools";
import "./context-tools.css";

export function ToolsSettings() {
  const [config, setConfig] = useState<ToolsConfig>(DEFAULT_TOOLS);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void toolsApi.config().then(setConfig).catch((error) => setMessage(String(error)));
  }, []);

  const patch = (partial: Partial<ToolsConfig>) => setConfig((config) => ({ ...config, ...partial }));

  const save = async () => {
    try {
      if (config.items.length < 3) throw new Error("转盘至少需要三项");
      await toolsApi.save(normalizeTools(config));
      await emit("tools-config");
      setMessage("已保存；快捷键冲突会在主界面提示");
    } catch (error) {
      setMessage(String(error));
    }
  };

  return (
    <section className="tools-settings">
      <h3>快捷工具与图片提问</h3>
      <label>
        <input
          type="checkbox"
          checked={config.selectionEnabled}
          onChange={(event) => patch({ selectionEnabled: event.target.checked })}
        />
        选中文字后延迟显示工具条
      </label>
      <label>
        选区稳定等待（毫秒）
        <input
          type="number"
          min="250"
          max="1500"
          value={config.selectionDelayMs}
          onChange={(event) => patch({ selectionDelayMs: +event.target.value })}
        />
      </label>
      <label>
        <input type="checkbox" checked={config.radialEnabled} onChange={(event) => patch({ radialEnabled: event.target.checked })} />
        启用长按转盘
      </label>
      <label>
        转盘快捷键
        <input value={config.radialHotkey} onChange={(event) => patch({ radialHotkey: event.target.value })} />
      </label>
      <label>
        长按阈值（毫秒）
        <input
          type="number"
          min="200"
          max="1000"
          value={config.holdMs}
          onChange={(event) => patch({ holdMs: +event.target.value })}
        />
      </label>
      <label>
        截图提问快捷键
        <input value={config.screenshotHotkey} onChange={(event) => patch({ screenshotHotkey: event.target.value })} />
      </label>
      <label>
        选区提问快捷键
        <input value={config.askHotkey} onChange={(event) => patch({ askHotkey: event.target.value })} />
      </label>
      <p className="tools-note">
        图片理解与文字整理均使用应用内置的千问旗舰 qwen3.8-max（官方最新最强），无需配置模型；
        复用百炼 Token 或当前服务地址与 Key。图片只在点击发送时上传
      </p>
      <label>
        转盘格数
        <select
          value={config.items.length}
          onChange={(event) => {
            const count = +event.target.value;
            patch({
              items: Array.from({ length: count }, (_, index) => config.items[index] || (Object.keys(ACTIONS)[index % 8] as ActionId)),
            });
          }}
        >
          {[3, 4, 5, 6, 7, 8].map((count) => (
            <option key={count}>{count}</option>
          ))}
        </select>
      </label>
      <div className="tools-items">
        {config.items.map((item, index) => (
          <label key={index}>
            {index + 1}
            <select
              value={item}
              onChange={(event) =>
                patch({ items: config.items.map((current, position) => (position === index ? (event.target.value as ActionId) : current)) })
              }
            >
              {Object.entries(ACTIONS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <p className="tools-note">长按唤出转盘，松开后保持显示；点击功能执行，点击中心或转盘外部取消。口述快捷键保持原有行为</p>
      <button onClick={() => void save()}>保存快捷工具设置</button>
      {message && (
        <p className="tools-note" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
