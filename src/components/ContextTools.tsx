import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ACTIONS, DEFAULT_TOOLS, radialIndex, toolsApi } from "../lib/contextTools";
import type { ActionId, ToolSession, ToolsConfig } from "../lib/contextTools";
import { animateSpring, SPRING_POP } from "../lib/spring";
import { insertTextAtFocusedEditable } from "../lib/selfInsert";
import { native } from "../lib/native";
import "./context-tools.css";

const PREVIEW_SESSION: ToolSession = {
  id: "preview",
  action: "edit",
  source: "这是一段待整理的原文",
  result: "编辑、提问与翻译结果都会显示在这里，确认后再替换原文",
  question: "",
  image: null,
  selection: null,
  busy: false,
  error: null,
  messages: [],
};

export function ContextTools({ kind, preview = false }: { kind: string; preview?: boolean }) {
  const [config, setConfig] = useState<ToolsConfig>(DEFAULT_TOOLS);
  const [session, setSession] = useState<ToolSession | null>(preview ? PREVIEW_SESSION : null);
  const [question, setQuestion] = useState("");
  const [sourceDraft, setSourceDraft] = useState(preview ? "这是一段待整理的原文" : "");
  const questionVersion = useRef("");
  const [enlarged, setEnlarged] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  // 真实窗口由 Rust initialization_script 注入 __UWORDS_THEME__；浏览器预览可用 ?theme=light 覆盖
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const injected = (window as { __UWORDS_THEME__?: string }).__UWORDS_THEME__;
    if (injected === "light" || injected === "dark") return injected;
    return new URLSearchParams(window.location.search).get("theme") === "light" ? "light" : "dark";
  });
  const [previewMessage, setPreviewMessage] = useState("");
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);
  const leaveTimer = useRef(0);
  const shellRef = useRef<HTMLDivElement>(null);

  // C4 退场：先播 leaving 动画，播完再 tools_hide_menu 真正隐藏窗口；幂等，动画期间不重复触发。
  // leaving 状态保留到下次唤出时复位（tools-menu handler），避免 hide 前闪回可见一帧。
  // 预览模式照播动画但不隐藏窗口，动画结束即复位，供反复演示。
  const dismiss = () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    const duration = kind === "selectionbar" ? 140 : 160;
    if (preview) {
      setPreviewMessage("已取消");
      setSelected(null);
      leaveTimer.current = window.setTimeout(() => {
        leavingRef.current = false;
        setLeaving(false);
      }, duration);
      return;
    }
    leaveTimer.current = window.setTimeout(() => {
      leavingRef.current = false;
      void invoke("tools_hide_menu", { kind }).catch(() => undefined);
    }, duration);
  };

  const cancelRadial = () => {
    dismiss();
  };

  const act = async (action: ActionId) => {
    if (preview) {
      setPreviewMessage(`已选择：${ACTIONS[action]}`);
      return;
    }
    await emitTo("main", "tools-action", action);
  };

  const run = async () => {
    if (!session || preview) return;
    setError("");
    try {
      if (!session.selection && sourceDraft !== session.source) {
        await toolsApi.source(session.id, sourceDraft);
      }
      await toolsApi.run(session.id, question);
    } catch (error) {
      setError(String(error));
    }
  };

  const close = () => {
    if (preview) return;
    void toolsApi.close();
  };

  useEffect(() => {
    if (preview) return;
    let active = true;
    const stops: Array<() => void> = [];
    void toolsApi.config().then((loaded) => {
      if (active) setConfig(loaded);
    });
    if (kind === "result") {
      void toolsApi.session().then((loaded) => {
        if (active) {
          setSession(loaded);
          setSourceDraft(loaded?.source || "");
          setQuestion(loaded?.question || "");
        }
      });
    }
    const bind = async <T,>(event: string, callback: (payload: T) => void) => {
      const stop = await listen<T>(event, (e) => callback(e.payload));
      if (active) stops.push(stop);
      else stop();
    };
    if (kind === "result") {
      // 主窗口判定焦点在自身但自己文档无可编辑元素时，可能落在结果窗输入框：
      // 由本 webview 自己做 DOM 插入并回执，主窗口据此决定是否降级复制卡片
      void bind<string>("tools-self-insert", (text) => {
        void emitTo("main", "tools-self-inserted", insertTextAtFocusedEditable(text));
      });
    }
    void bind("tools-cleared", () => {
      setSession(null);
      setQuestion("");
      setError("");
      setEnlarged(false);
      questionVersion.current = "";
    });
    void bind<ToolSession>("tools-session", (session) => {
      const version = session.id + ":" + session.question;
      if (questionVersion.current !== version) {
        setQuestion(session.question);
        questionVersion.current = version;
      }
      setSession((old) => {
        if (old?.id !== session.id) {
          setQuestion(session.question);
          setSourceDraft(session.source);
          setError("");
          setCopied(false);
        }
        return session;
      });
    });
    void bind("tools-menu", () => {
      const shell = shellRef.current;
      // 中断可能在途的退场（窗口复用前一次退场未结束又被唤出）
      if (leavingRef.current) {
        leavingRef.current = false;
        window.clearTimeout(leaveTimer.current);
        setLeaving(false);
      }
      if (shell && kind === "radial") {
        // 重播扇形 stagger 与中心 pop（窗口复用时不会自动重播）；class 直改避免 remount 丢焦点
        shell.classList.remove("radial-shell--play");
        void shell.offsetWidth;
        shell.classList.add("radial-shell--play");
        // 入场 spring：scale .7→1 直写 transform（动画优先级高于 inline，退场 forwards 可正常覆盖）
        animateSpring({
          from: .7,
          to: 1,
          config: SPRING_POP,
          onUpdate: (value) => {
            if (shell.isConnected) shell.style.transform = `scale(${value.toFixed(4)})`;
          },
        });
        // 转盘唤出后接管键盘焦点：Esc 立即生效，点击外部导致的失焦负责关闭转盘
        void getCurrentWindow().setFocus();
        shell.focus({ preventScroll: true });
      } else if (shell && kind === "selectionbar") {
        shell.classList.remove("selection-toolbar--play");
        void shell.offsetWidth;
        shell.classList.add("selection-toolbar--play");
      }
      setSelected(null);
      setMore(false);
      void toolsApi.config().then(setConfig);
    });
    // 主窗口发起的退场（选择动作/失焦/poll 收起）：播完动画后由 dismiss 计时器真正 hide
    void bind("tools-menu-dismiss", () => dismiss());
    void bind<"dark" | "light">("tools-theme", setTheme);
    return () => {
      active = false;
      window.clearTimeout(leaveTimer.current);
      stops.forEach((stop) => stop());
    };
  }, [kind, preview]);

  useEffect(() => {
    if (preview || kind !== "radial") return;
    let active = true;
    let stopFocus: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        // 点击转盘外部或切换应用都会失焦，此时关闭转盘
        if (!focused && active) dismiss();
      })
      .then((off) => {
        if (active) stopFocus = off;
        else off();
      });
    return () => {
      active = false;
      stopFocus?.();
    };
  }, [kind, preview]);

  useEffect(() => {
    if (!preview || kind !== "radial") return;
    // 预览模式下模拟“点击外部取消”的行为反馈
    const handler = (event: MouseEvent) => {
      const shell = shellRef.current;
      if (shell && event.target instanceof Node && !shell.contains(event.target)) {
        setPreviewMessage("已取消");
        setSelected(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [kind, preview]);

  // 用 layout effect 在首帧绘制前落地主题属性，避免浅色用户看到一帧深色
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (enlarged) {
        setEnlarged(false);
        return;
      }
      if (kind === "result") close();
      else dismiss();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [kind, enlarged]);

  if (kind === "radial") {
    return (
      <div
        ref={shellRef}
        className={`radial-shell radial-shell--play${leaving ? " radial-shell--leaving" : ""}`}
        tabIndex={-1}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const index = radialIndex(event.clientX - rect.left, event.clientY - rect.top, config.items.length);
          if (index !== selected) setSelected(index);
        }}
        onMouseLeave={() => setSelected(null)}
      >
        <div className="radial-glass" aria-hidden="true" />
        <svg viewBox="0 0 300 300" className="radial-svg" aria-label="快捷功能转盘">
          {config.items.map((item, index) => {
            const count = config.items.length;
            const angle = (index * 2 * Math.PI) / count - Math.PI / 2;
            const start = angle - Math.PI / count;
            const end = angle + Math.PI / count;
            const point = (radius: number, theta: number) => `${150 + radius * Math.cos(theta)},${150 + radius * Math.sin(theta)}`;
            return (
              <g key={`${item}-${index}`} role="button" tabIndex={0} aria-label={ACTIONS[item]} onFocus={()=>setSelected(index)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();void act(item);}}} onClick={() => void act(item)} style={{ "--piece-i": index } as CSSProperties}>
                <path
                  className={selected === index ? "active" : ""}
                  d={`M ${point(44, start)} L ${point(144, start)} A 144 144 0 0 1 ${point(144, end)} L ${point(44, end)} A 44 44 0 0 0 ${point(44, start)} Z`}
                />
                <text
                  x={150 + 96 * Math.cos(angle)}
                  y={150 + 96 * Math.sin(angle)}
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {ACTIONS[item]}
                </text>
              </g>
            );
          })}
        </svg>
        <button className="radial-center" aria-label="取消转盘" onClick={cancelRadial}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m7 7 10 10M17 7 7 17"/></svg>
          <span>取消</span>
        </button>
        {preview && (
          <div className="radial-preview-controls">
            <button onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}>切换主题</button>
            <span role="status">{previewMessage || "松开快捷键后保持显示，点击选择，点击外部取消"}</span>
          </div>
        )}
      </div>
    );
  }

  if (kind === "selectionbar") {
    return (
      <div ref={shellRef} className={`selection-toolbar selection-toolbar--play${leaving ? " selection-toolbar--leaving" : ""}`}>
        {more ? (
          <>
            <button onClick={() => void act("image")}>截图提问</button>
            <button onClick={() => void act("ocr")}>截图识字</button>
          </>
        ) : (
          <>
            <button onClick={() => void act("edit")}>编辑</button>
            <button onClick={() => void act("ask")}>提问</button>
            <button onClick={() => void act("polish")}>整理</button>
            <button onClick={() => void act("translate")}>翻译</button>
          </>
        )}
        <button aria-label={more ? "返回基础工具" : "更多功能"} aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? "返回" : "···"}
        </button>
        <button
          aria-label="关闭选区工具条"
          onClick={() => {
            if (preview) {
              dismiss();
              return;
            }
            void emitTo("main", "tools-dismiss-selection");
          }}
        >
          ×
        </button>
      </div>
    );
  }

  if (!session) return <div className="tools-empty">等待操作…</div>;

  const editing = ["edit", "polish", "translate"].includes(session.action);

  return (
    <main
      className="result-window"
      onPaste={(event) => {
        const file = Array.from(event.clipboardData.files).find((file) => file.type.startsWith("image/"));
        if (!file || session.busy) return;
        event.preventDefault();
        if (file.size > 16e6) {
          setError("图片超过 16MB");
          return;
        }
        const reader = new FileReader();
        reader.onload = () =>
          void toolsApi
            .attach(session.id, String(reader.result))
            .then(setSession)
            .catch((error) => setError(String(error)));
        reader.readAsDataURL(file);
      }}
    >
      <header
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !preview) void getCurrentWindow().startDragging();
        }}
      >
        <strong>{ACTIONS[session.action as ActionId] || "处理结果"}</strong>
        <span>U-Words</span>
        <button className="tool-close" aria-label="关闭结果窗口" onClick={close}>
          ×
        </button>
      </header>
      <div className="result-body">
        {session.image && (
          <>
            <button className="image-preview-button" aria-label="放大图片" onClick={() => setEnlarged(true)}>
              <img className="question-image" src={session.image} alt="本次提问图片" />
            </button>
            {enlarged && (
              <div className="image-lightbox" onClick={() => setEnlarged(false)}>
                <button aria-label="收起图片" onClick={() => setEnlarged(false)}>
                  返回
                </button>
                <img src={session.image} alt="放大的本次图片" />
              </div>
            )}
            <div className="tool-buttons">
              <button disabled={session.busy} onClick={() => void toolsApi.screenshot(session.action).catch((error) => setError(String(error)))}>
                重新截图
              </button>
              <button
                onClick={() =>
                  void toolsApi
                    .imageExport(session.id, true)
                    .then(() => setError("图片已复制"))
                    .catch((error) => setError(String(error)))
                }
              >
                复制图片
              </button>
              <button
                onClick={() =>
                  void toolsApi
                    .imageExport(session.id, false)
                    .then((path) => setError(`已保存：${path}`))
                    .catch((error) => setError(String(error)))
                }
              >
                保存图片
              </button>
            </div>
          </>
        )}
        <details open={!session.source && !session.image}>
          <summary>{session.source ? "查看原文" : "粘贴文字或添加图片"}</summary>
          <textarea
            aria-label="原文"
            value={sourceDraft}
            onChange={(event) => setSourceDraft(event.target.value)}
            key={session.id}
            readOnly={Boolean(session.selection) || session.busy}
            placeholder="未读取到选区时，可在这里粘贴文字"
          />
        </details>
        <div className="result-answer" aria-live="polite">
          {session.busy ? (
            <>
              <span className="tools-pulse" />
              正在处理，关闭可取消
            </>
          ) : (
            session.result || "输入要求后发送，结果会保留在这个窗口"
          )}
        </div>
        {(error || session.error) && (
          <p className="tools-error" role="alert">
            {error || session.error}
          </p>
        )}
      </div>
      <footer>
        <textarea
          aria-label={editing ? "修改要求" : "问题"}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={editing ? "例如：更简洁，保留全部要求" : "针对选区或图片提问…"}
          disabled={session.busy}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void run();
            }
          }}
        />
        <div className="tool-buttons">
          <button
            disabled={session.busy}
            onClick={() =>
              void toolsApi
                .attach(session.id)
                .then(setSession)
                .catch((error) => setError(String(error)))
            }
          >
            粘贴图片
          </button>
          <label className="tool-file">
            选择图片
            <input
              type="file"
              accept="image/png,image/jpeg"
              disabled={session.busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (file.size > 16e6) {
                  setError("图片超过 16MB");
                  return;
                }
                const reader = new FileReader();
                reader.onload = () =>
                  void toolsApi
                    .attach(session.id, String(reader.result))
                    .then(setSession)
                    .catch((error) => setError(String(error)));
                reader.readAsDataURL(file);
                event.target.value = "";
              }}
            />
          </label>
          <button disabled={session.busy} onClick={() => void emitTo("main", "tools-voice-question", { id: session.id, action: session.action })}>
            语音
          </button>
          <button className="tool-primary" disabled={session.busy} onClick={() => void run()}>
            {session.result ? "继续处理" : "发送"}
          </button>
        </div>
        {session.result && (
          <div className="tool-result-actions">
            <button
              onClick={() =>
                void native
                  .copyText(session.result)
                  .then(() => setCopied(true))
                  .catch((error) => setError(String(error)))
              }
            >
              {copied ? "已复制" : "复制结果"}
            </button>
            {editing && (
              <button
                disabled={!session.selection || session.busy}
                title={!session.selection ? "无法验证原选区，请复制结果" : "替换前会重新检查原选区"}
                onClick={() => void toolsApi.replace(session.id).catch((error) => setError(String(error)))}
              >
                替换选区
              </button>
            )}
            <small>不会自动替换原文</small>
          </div>
        )}
      </footer>
    </main>
  );
}
