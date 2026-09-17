import { ASR_LANGUAGES } from "../types";
import type { AsrLanguage } from "../types";

export function AsrLanguageSelect({ value, local, onChange }: { value: AsrLanguage; local: boolean; onChange: (value: AsrLanguage) => void }) {
  return <label className="select-label">语言<select className="asr-language-select" value={value} onChange={(event) => onChange(event.target.value as AsrLanguage)} title={local ? "语言选项按千问 ASR 定义；本地 Whisper 的菲律宾语映射为 Tagalog，粤语按中文识别。多语混说请选择自动。" : "千问 ASR 支持的识别语言；多语混说请选择自动。"}>
    {ASR_LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
  </select></label>;
}
