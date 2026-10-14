import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { toolsApi } from "./contextTools";
import type { ActionId, SelectionSnapshot } from "./contextTools";

type ContextToolsOptions = {
  enabled: boolean;
  hotkeys: string[];
  busy: () => boolean;
  action: (id: ActionId) => Promise<void>;
  voice: (id: string, action?: string) => void;
  error: (message: string) => void;
};

export function useContextTools(options: ContextToolsOptions) {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (!options.enabled) return;
    let disposed = false;
    let pressed = false;
    let open = false;
    let activeResult = false;
    let polling = false;
    let escapeOwner = "";
    let ownerApp = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous: SelectionSnapshot | null = null;
    let stableAt = 0;
    let shown = "";
    let dismissed = "";
    let stopConfig: (() => void) | undefined;
    const stops: Array<() => void> = [];
    let keys: string[] = [];
    let configureQueue = Promise.resolve();

    const escape = async (kind: string) => {
      escapeOwner = kind;
      ownerApp = kind ? await invoke<string>("get_active_app").catch(() => "") : "";
      await emitTo("main", "tools-escape", kind);
    };

    // C4：菜单退场交给窗口自己播完动画后再 tools_hide_menu，这里只发事件；
    // 卸载清理仍走底部强制 hide，不等动画。
    const dismissMenu = (kind: "radial" | "selectionbar") => {
      void emitTo(kind, "tools-menu-dismiss").catch(() => undefined);
    };

    const configure = async () => {
      const config = await toolsApi.config();
      const candidates = [
        ...(config.radialEnabled ? [config.radialHotkey] : []),
        config.screenshotHotkey,
        config.askHotkey,
      ].filter(Boolean);
      const normalized = candidates.map((key) => key.toLowerCase());
      if (
        new Set(normalized).size !== normalized.length ||
        normalized.some((key) => latest.current.hotkeys.map((hotkey) => hotkey.toLowerCase()).includes(key))
      ) {
        throw new Error("快捷工具按键与口述/编辑按键冲突，请在设置中更换");
      }
      const added: string[] = [];
      try {
        for (const key of candidates) {
          if (keys.includes(key)) continue;
          await register(key, (event) => {
            if (disposed || latest.current.busy()) return;
            if (key === config.radialHotkey) {
              if (event.state === "Pressed" && !pressed) {
                pressed = true;
                timer = setTimeout(() => {
                  if (pressed && !disposed) {
                    open = true;
                    void toolsApi
                      .show("radial")
                      .then(() => {
                        if (!disposed) return escape("radial");
                      })
                      .catch((error) => latest.current.error(String(error)));
                  }
                }, config.holdMs);
              }
              if (event.state === "Released") {
                pressed = false;
                clearTimeout(timer);
                // Release only ends the hold gesture. The palette stays open.
              }
            } else if (event.state === "Pressed") {
              void latest.current
                .action(key === config.screenshotHotkey ? "image" : "ask")
                .catch((error) => latest.current.error(String(error)));
            }
          });
          added.push(key);
        }
      } catch (error) {
        await Promise.all(added.map((key) => unregister(key)));
        throw error;
      }
      for (const key of keys.filter((key) => !candidates.includes(key))) await unregister(key);
      keys = candidates;
    };

    const queue = () => {
      configureQueue = configureQueue.then(configure).catch((error) => latest.current.error(String(error)));
    };
    queue();

    void listen("tools-config", () => {
      void Promise.all(keys.map((key) => unregister(key))).then(() => {
        keys = [];
        queue();
      });
    }).then((stop) => {
      if (disposed) stop();
      else stopConfig = stop;
    });
    void listen<ActionId>("tools-action", (event) => {
      // 与快捷键/语音入口同款 busy 守卫：录音/处理进行中忽略转盘/选区条动作，防劫持进行中的会话
      if (latest.current.busy()) return;
      // open/escape 的复位由 tools_hide_menu 触发的 tools-radial-closed 回环统一处理，避免重复 escape
      dismissMenu("radial");
      dismissMenu("selectionbar");
      dismissed = shown;
      void latest.current.action(event.payload).catch((error) => latest.current.error(String(error)));
    }).then((stop) => {
      if (disposed) stop();
      else stops.push(stop);
    });
    void listen("tools-radial-closed", () => {
      open = false;
      void escape("");
    }).then((stop) => {
      if (disposed) stop();
      else stops.push(stop);
    });
    void listen<{ id: string; action?: string }>("tools-voice-question", (event) => {
      // 与快捷键路径同款 busy 守卫：录音/处理进行中忽略重复触发，防双击竞态劫持/覆盖工具会话
      if (latest.current.busy()) return;
      latest.current.voice(event.payload.id, event.payload.action);
    }).then((stop) => {
      if (disposed) stop();
      else stops.push(stop);
    });
    void listen<boolean>("tools-active", (event) => {
      activeResult = event.payload;
      void escape(activeResult ? "result" : "");
      if (activeResult) dismissMenu("selectionbar");
    }).then((stop) => {
      if (disposed) stop();
      else stops.push(stop);
    });
    void listen("tools-dismiss-selection", () => {
      dismissed = shown;
      dismissMenu("selectionbar");
    }).then((stop) => {
      if (disposed) stop();
      else stops.push(stop);
    });

    const poll = setInterval(() => {
      if (polling || disposed) return;
      polling = true;
      void (async () => {
        if (escapeOwner && ownerApp) {
          const app = await invoke<string>("get_active_app").catch(() => "");
          if (app !== ownerApp) await escape("");
        }
        const config = await toolsApi.config();
        if (!config.selectionEnabled || activeResult || open || latest.current.busy()) {
          if (shown) {
            dismissMenu("selectionbar");
            shown = "";
          }
          return;
        }
        const selection = await toolsApi.selection();
        if (disposed) return;
        const fingerprint = selection ? `${selection.key}:${selection.text}:${selection.x}:${selection.y}` : "";
        const prior = previous ? `${previous.key}:${previous.text}:${previous.x}:${previous.y}` : "";
        if (fingerprint !== prior) {
          previous = selection;
          stableAt = Date.now();
          shown = "";
          dismissMenu("selectionbar");
          return;
        }
        if (selection && fingerprint !== shown && fingerprint !== dismissed && Date.now() - stableAt >= config.selectionDelayMs) {
          shown = fingerprint;
          await toolsApi.show("selectionbar", selection);
        }
        if (!selection) dismissed = "";
      })()
        .catch(() => undefined)
        .finally(() => {
          polling = false;
        });
    }, 500);

    return () => {
      disposed = true;
      pressed = false;
      clearTimeout(timer);
      clearInterval(poll);
      stopConfig?.();
      stops.forEach((stop) => stop());
      void configureQueue.finally(() => Promise.all(keys.map((key) => unregister(key).catch(() => undefined))));
      void toolsApi.hide("radial");
      void toolsApi.hide("selectionbar");
    };
  }, [options.enabled, options.hotkeys.join("|")]);
}
