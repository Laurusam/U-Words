//! 场景 → 提示段/候选术语映射表。
//! id 必须与前端 src/lib/scenes.ts 保持一致（契约测试 scripts/test-scenes.mjs）。
//! 术语表刻意短：whisper initial_prompt 预算约 224 token，需与个人词典合并后留余量。

pub struct Scene {
    pub id: &'static str,
    pub prompt: &'static str,
    pub terms: &'static [&'static str],
}

const SCENES: &[Scene] = &[
    Scene {
        id: "general",
        prompt: "使用场景：日常沟通。表达自然口语化，语气随和，称谓从简，不添加公文腔。",
        terms: &[],
    },
    Scene {
        id: "code",
        prompt: "使用场景：编程与技术。保留代码、命令、接口名、路径、报错信息与英文技术名词的原样写法和大小写，不把技术标识符改写成普通词。",
        terms: &["commit", "merge", "rebase", "deploy", "接口", "回调", "异步", "编译", "分支", "终端"],
    },
    Scene {
        id: "email",
        prompt: "使用场景：商务办公。表达正式得体、清晰克制，可保留称呼、事由与收尾敬语，不闲聊、不夸张。",
        terms: &["您好", "附件", "抄送", "收件", "会议", "答复", "此致"],
    },
    Scene {
        id: "notes",
        prompt: "使用场景：会议与学习。按笔记习惯组织信息，突出结论、要点与待办；人名、时间、数字必须准确。",
        terms: &["待办", "行动项", "结论", "议题", "纪要", "截止"],
    },
    Scene {
        id: "markdown",
        prompt: "使用场景：内容创作。可按内容需要使用标题、列表、引用等结构，句子完整通顺，适合发布或存档。",
        terms: &["标题", "列表", "引用", "摘要", "章节"],
    },
];

/// 已知场景的提示段以空格连接；未知 id 忽略；无有效场景返回空串
pub fn prompt(ids: &[String]) -> String {
    ids.iter()
        .filter_map(|id| SCENES.iter().find(|scene| scene.id == id.as_str()))
        .map(|scene| scene.prompt)
        .collect::<Vec<_>>()
        .join(" ")
}

/// 已知场景的候选术语顺序拼接去重
pub fn terms(ids: &[String]) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for id in ids {
        if let Some(scene) = SCENES.iter().find(|scene| scene.id == id.as_str()) {
            for term in scene.terms {
                if !terms.iter().any(|existing| existing == term) {
                    terms.push((*term).to_string());
                }
            }
        }
    }
    terms
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_scene_ids_are_ignored() {
        let scenes = vec!["code".to_string(), "nope".to_string()];
        let hint = prompt(&scenes);
        assert!(hint.contains("编程与技术"));
        assert!(!hint.contains("nope"));
        assert!(!terms(&scenes).iter().any(|term| term == "nope"));
        assert!(prompt(&[]).is_empty());
        assert!(terms(&[]).is_empty());
    }

    #[test]
    fn scene_terms_dedupe_and_preserve_order() {
        let scenes = vec!["code".to_string(), "notes".to_string(), "code".to_string()];
        let terms = terms(&scenes);
        assert_eq!(terms.iter().filter(|term| term.as_str() == "接口").count(), 1);
        let code_first = terms.iter().position(|term| term.as_str() == "接口").unwrap();
        let notes_first = terms.iter().position(|term| term.as_str() == "待办").unwrap();
        assert!(code_first < notes_first);
    }
}
