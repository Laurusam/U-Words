import { useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ACTIONS, DEFAULT_TOOLS, radialIndex, toolsApi } from "../lib/contextTools";
import type { ActionId, ToolSession, ToolsConfig } from "../lib/contextTools";
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
  theme: "dark",
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
  const selectedRef = useRef<number | null>(null);
  const [more, setMore] = useState(false);

  const act = async (action: ActionId) => {
    if (preview) return;
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
      selectedRef.current = null;
      setSelected(null);
      setMore(false);
      void toolsApi.config().then(setConfig);
    });
    void bind("tools-radial-release", () => {
      const index = selectedRef.current;
      void toolsApi.hide("radial");
      if (index !== null) void toolsApi.config().then((config) => act(config.items[index]));
    });
    return () => {
      active = false;
      stops.forEach((stop) => stop());
    };
  }, [kind, preview]);

  useEffect(() => {
    document.documentElement.dataset.theme = session?.theme || "dark";
  }, [session?.theme]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (enlarged) {
        setEnlarged(false);
        return;
      }
      if (kind === "result") close();
      else void toolsApi.hide(kind);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [kind, enlarged]);

  if (kind === "radial") {
    return (
      <div
        className="radial-shell"
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const index = radialIndex(event.clientX - rect.left, event.clientY - rect.top, config.items.length);
          selectedRef.current = index;
          setSelected(index);
        }}
        onMouseLeave={() => {
          selectedRef.current = null;
          setSelected(null);
        }}
      >
        <svg viewBox="0 0 300 300" className="radial-svg">
          <circle cx="150" cy="150" r="145" />
          {config.items.map((item, index) => {
            const count = config.items.length;
            const angle = (index * 2 * Math.PI) / count - Math.PI / 2;
            const start = angle - Math.PI / count;
            const end = angle + Math.PI / count;
            const point = (radius: number, theta: number) => `${150 + radius * Math.cos(theta)},${150 + radius * Math.sin(theta)}`;
            return (
              <g key={`${item}-${index}`} onClick={() => void act(item)}>
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
        <div className="radial-center">
          {selected === null ? (
            <>
              松开取消<small>移动选择</small>
            </>
          ) : (
            <>
              松开执行<small>{ACTIONS[config.items[selected]]}</small>
            </>
          )}
        </div>
      </div>
    );
  }

  if (kind === "selectionbar") {
    return (
      <div className="selection-toolbar">
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
        <button aria-label="更多功能" onClick={() => setMore(!more)}>
          {more ? "返回" : "···"}
        </button>
        <button aria-label="关闭选区工具条" onClick={() => void emitTo("main", "tools-dismiss-selection")}>
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
