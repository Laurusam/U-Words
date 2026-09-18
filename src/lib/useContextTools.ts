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
                        if (pressed) return escape("radial");
                        return toolsApi.hide("radial");
                      })
                      .catch((error) => latest.current.error(String(error)));
                  }
                }, config.holdMs);
              }
              if (event.state === "Released") {
                pressed = false;
                clearTimeout(timer);
                if (open) {
                  open = false;
                  void escape("");
                  void emitTo("radial", "tools-radial-release");
                }
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
      void toolsApi.hide("radial");
      void toolsApi.hide("selectionbar");
      dismissed = shown;
      void latest.current.action(event.payload).catch((error) => latest.current.error(String(error)));
    }).then((stop) => {
      if (disposed) stop();
      else stops.push(stop);
    });
    void listen<{ id: string; action?: string }>("tools-voice-question", (event) =>
      latest.current.voice(event.payload.id, event.payload.action),
    ).then((stop) => {
      if (disposed) stop();
      else stops.push(stop);
    });
    void listen<boolean>("tools-active", (event) => {
      activeResult = event.payload;
      void escape(activeResult ? "result" : "");
      if (activeResult) void toolsApi.hide("selectionbar");
    }).then((stop) => {
      if (disposed) stop();
      else stops.push(stop);
    });
    void listen("tools-dismiss-selection", () => {
      dismissed = shown;
      void toolsApi.hide("selectionbar");
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
            void toolsApi.hide("selectionbar");
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
          await toolsApi.hide("selectionbar");
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
