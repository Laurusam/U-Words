import { useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { DEFAULT_TOOLS, toolsApi } from "../lib/contextTools";
import { native } from "../lib/native";
import type { AppConfig } from "../types";

const SCENES: Array<[string, string]> = [
  ["general", "日常沟通"],
  ["code", "编程与技术"],
  ["email", "商务办公"],
  ["notes", "会议与学习"],
  ["markdown", "内容创作"],
];

export function Onboarding({
  config,
  onConfig,
  onTry,
  onSettings,
}: {
  config: AppConfig;
  onConfig: (partial: Partial<AppConfig>) => void;
  onTry: () => void;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [scenes, setScenes] = useState(["general"]);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void toolsApi
      .config()
      .then((config) => {
        setScenes(config.scenes);
        setOpen(!config.onboardingDone);
      })
      .catch(() => undefined);
  }, []);

  const finish = async () => {
    const config = await toolsApi.config();
    await toolsApi.save({ ...DEFAULT_TOOLS, ...config, scenes, onboardingDone: true });
    await emit("tools-config");
    setOpen(false);
  };

  if (!open) return null;

  return (
    <div className="onboarding-backdrop">
      <section className="onboarding-card">
        <small>U-Words · {step + 1} / 3</small>
        <h2>{["选择你的使用场景", "配置文字能力", "设置快捷键，试用一次"][step]}</h2>
        {step === 0 && (
          <>
            <p>场景用于术语与表达习惯，不根据当前应用改变风格</p>
            <div className="scene-options">
              {SCENES.map(([id, label]) => (
                <button
                  className={scenes.includes(id) ? "selected" : ""}
                  key={id}
                  onClick={() => setScenes((current) => (current.includes(id) ? current.filter((scene) => scene !== id) : [...current, id]))}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        )}
        {step === 1 && (
          <>
            <p>填写百炼 Token 可启用云端识别与文字整理，也可以稍后配置；跳过后仍可离线转文字</p>
            <input type="password" autoComplete="off" placeholder="百炼 API Key" value={token} onChange={(event) => setToken(event.target.value)} />
            <button
              disabled={busy || !token.trim()}
              onClick={() => {
                setBusy(true);
                void native
                  .saveAsrToken(config.asrRegion, token)
                  .then(() => {
                    onConfig({ asrProvider: "qwen", llmUseAsrToken: true });
                    setToken("");
                    setError("Token 已保存，实际可用性将在试用时验证");
                  })
                  .catch((error) => setError(String(error)))
                  .finally(() => setBusy(false));
              }}
            >
              保存 Token
            </button>
            <button onClick={() => void finish().then(onSettings)}>配置其他服务商</button>
          </>
        )}
        {step === 2 && (
          <>
            <p>
              口述：{config.hotkey}
              <br />
              编辑选区：{config.editHotkey}
            </p>
            <label>
              录音方式{" "}
              <select
                value={config.recordingMode}
                onChange={(event) => onConfig({ recordingMode: event.target.value as "toggle" | "hold" })}
              >
                <option value="toggle">按一下开始，再按一下结束</option>
                <option value="hold">按住录音，松开结束</option>
              </select>
            </label>
            <p>编辑、翻译和提问需要文字模型；未配置时可先试用转文字</p>
            <button onClick={() => void finish().then(onSettings)}>修改快捷键与模型</button>
            <button onClick={() => void finish().then(onTry)}>试用口述</button>
          </>
        )}
        {error && (
          <p role="status">{error}</p>
        )}
        <footer>
          {step > 0 && (
            <button disabled={busy} onClick={() => setStep(step - 1)}>
              上一步
            </button>
          )}
          <button
            disabled={busy}
            onClick={() => {
              if (step < 2) setStep(step + 1);
              else void finish();
            }}
          >
            {step === 2 ? "完成" : step === 1 ? "继续 / 稍后配置" : "下一步"}
          </button>
        </footer>
      </section>
    </div>
  );
}
