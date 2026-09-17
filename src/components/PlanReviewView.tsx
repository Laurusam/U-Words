import type { AppTheme, PlanReview } from "../types";

export type PlanReviewSession = { source: string; provider: string; busy: boolean; error?: string; result?: PlanReview };

export function PlanReviewView({ session, theme, onClose, onCheck, onCopy, onInsert }: {
  session: PlanReviewSession; theme: AppTheme; onClose: () => void; onCheck: () => void;
  onCopy: (text: string) => void; onInsert: (text: string) => void;
}) {
  return <div className="plan-review-backdrop" data-theme={theme}>
    <section className="plan-review-dialog" role="dialog" aria-modal="true" aria-labelledby="plan-review-title">
      <header><div><h2 id="plan-review-title">检查技术方案</h2><p>只提供分析与建议，不执行方案，不覆盖原文。</p></div><button autoFocus onClick={onClose} aria-label="关闭方案检查">×</button></header>
      {!session.result && <><p className="plan-review-notice">确认后将以下正文发送至 {session.provider}，额外调用一次文字模型。不会发送录音或其他历史，不搜索；没有代码和最新文档，结论仍需验证。关闭窗口不会撤回已发送的请求。</p><pre className="plan-review-source">{session.source}</pre><button className="plan-review-primary" onClick={onCheck} disabled={session.busy}>{session.busy ? "正在检查…" : "发送并检查方案"}</button></>}
      {session.error && <p role="alert" className="plan-review-notice">{session.error}</p>}
      {session.result && <>
        <section><h3>原方案整理 · 不包含新增建议</h3><pre>{session.result.organizedPlan}</pre><div className="plan-review-actions"><button onClick={() => onCopy(session.result!.organizedPlan)}>复制整理正文</button><button onClick={() => onInsert(session.result!.organizedPlan)}>确认并准备插入</button></div></section>
        <section><h3>问题与待验证项</h3>{session.result.issues.length ? session.result.issues.map((item, index) => <article key={index}><strong>{item.title}</strong><blockquote>{item.evidence}</blockquote><p>{item.detail}</p></article>) : <p>模型未指出问题；不代表方案已验证。</p>}</section>
        <section><h3>可选新增建议 · 未应用</h3>{session.result.suggestions.length ? session.result.suggestions.map((item, index) => <article key={index}><strong>{item.title}</strong><p>{item.detail}</p><p className="plan-review-condition">采用条件：{item.condition}</p><button onClick={() => onCopy(`${item.title}\n${item.detail}\n采用条件：${item.condition}`)}>复制此建议</button></article>) : <p>没有新增建议。</p>}</section>
        <p className="plan-review-notice">模型分析不是运行或测试证据。新增建议没有自动插入，也没有写回原始记录。</p>
      </>}
    </section>
  </div>;
}
