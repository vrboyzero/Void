#!/usr/bin/env python3
"""
P0 机器清单生成器：从 Star .env.local（实际生效配置）抽取变量，按前缀映射做
七类分类，输出 config/void-capabilities.json。可复现，Star 文件只读。

分类依据：docs/star-capability-catalog.md 的七类定义 + 11.12 归属表 + 12.3 Module 表。
"""
import json
import re
import sys
from collections import OrderedDict

ENV_LOCAL = "参考项目/环境变量设置参考/.env.local"
ENV_EXAMPLE = "/mnt/e/project/star-sanctuary/.env.example"
OUT = "config/void-capabilities.json"

# 前缀 → (classification, owner)。按列表顺序匹配，先命中者胜（最长前缀放前面）。
PREFIX_MAP = [
    # ── void-memory：记忆/检索/经验/dream/embedding/reranker/task ──
    ("BELLDANDY_MEMORY_", "void_native", "void-memory"),
    ("BELLDANDY_EMBEDDING_", "void_native", "void-memory"),
    ("BELLDANDY_DREAM_", "void_native", "void-memory"),
    ("BELLDANDY_EXPERIENCE_", "void_native", "void-memory"),
    ("BELLDANDY_RERANKER_", "void_native", "void-memory"),
    ("BELLDANDY_TEAM_SHARED_MEMORY", "void_native", "void-memory"),
    ("BELLDANDY_AUTO_RECALL_", "void_native", "void-memory"),
    ("BELLDANDY_CARRYOVER_CONTEXT", "void_native", "void-memory"),
    ("BELLDANDY_CONTEXT_INJECTION_", "void_native", "void-memory"),
    ("BELLDANDY_MIND_PROFILE_", "void_native", "void-memory"),
    ("BELLDANDY_LOCAL_EMBEDDING", "void_native", "void-memory"),
    ("BELLDANDY_SHARED_REVIEW_", "void_native", "void-memory"),
    ("BELLDANDY_TASK_", "void_native", "void-memory"),
    ("BELLDANDY_SKILL_", "void_native", "void-memory"),
    ("BELLDANDY_METHOD_", "void_native", "void-memory"),
    ("BELLDANDY_FACET_", "void_native", "void-memory"),
    # ── void-media：图片/视频/TTS/STT/摄像头/截图/音频 ──
    ("BELLDANDY_IMAGE_", "void_native", "void-media"),
    ("BELLDANDY_VIDEO_", "void_native", "void-media"),
    ("BELLDANDY_TTS_", "void_native", "void-media"),
    ("BELLDANDY_STT_", "void_native", "void-media"),
    ("BELLDANDY_CAMERA_", "void_native", "void-media"),
    ("BELLDANDY_SCREEN_CAPTURE", "void_native", "void-media"),
    ("BELLDANDY_AUDIO_TRANSCRIPT", "void_native", "void-media"),
    ("BELLDANDY_UNDERSTANDING_CACHE", "void_native", "void-media"),
    ("DASHSCOPE_API_KEY", "adapter_credential", "void-media"),
    # ── void-channel：飞书/QQ/Discord/Email/路由/房间/主动通知 ──
    ("BELLDANDY_FEISHU_", "void_native", "void-channel-feishu"),
    ("BELLDANDY_QQ_", "void_native", "void-channel-qq"),
    ("BELLDANDY_DISCORD_", "void_native", "void-channel-discord"),
    ("BELLDANDY_EMAIL_", "void_native", "void-channel-email"),
    ("BELLDANDY_CHANNEL_", "void_native", "void-channel"),
    ("BELLDANDY_ROOM_", "void_native", "void-channel"),
    ("BELLDANDY_STARWEAVER_", "void_native", "void-channel"),
    ("BELLDANDY_ASSISTANT_EXTERNAL", "void_native", "void-channel"),
    ("BELLDANDY_AUTO_TASK_", "void_native", "void-channel"),
    ("BELLDANDY_WEBHOOK_", "void_native", "void-channel"),
    ("BELLDANDY_COMMUNITY_", "legacy_or_omit", None),
    # ── void-browser：浏览器 relay/出站/截图理解 ──
    ("BELLDANDY_BROWSER_", "void_native", "void-browser"),
    ("BELLDANDY_RELAY_", "void_native", "void-browser"),
    ("BELLDANDY_MV3_", "development_only", None),
    # ── void-tools：工具治理/沙箱/命令/extension host/远端交付 ──
    ("BELLDANDY_AGENT_TOOL_CONTROL", "void_native", "void-tools"),
    ("BELLDANDY_DANGEROUS_TOOLS", "void_native", "void-tools"),
    ("BELLDANDY_TOOLS_POLICY_FILE", "void_native", "void-tools"),
    ("BELLDANDY_COMMAND_SANDBOX_", "void_native", "void-tools"),
    ("BELLDANDY_EXTENSION_HOST_", "void_native", "void-tools"),
    ("BELLDANDY_REMOTE_DELIVERY", "void_native", "void-tools"),
    ("BELLDANDY_PRIVILEGED_WORKSPACE_WRITE", "void_native", "void-tools"),
    ("BELLDANDY_WEB_ALLOW_PRIVILEGED", "void_native", "void-tools"),
    ("BELLDANDY_CODE_INTEL_", "void_native", "void-tools"),
    ("BELLDANDY_TOOL_GROUPS", "void_native", "void-tools"),
    ("BELLDANDY_AGENT_BRIDGE", "legacy_or_omit", None),
    # ── void-legion：子 Agent/commander ──
    ("BELLDANDY_SUB_AGENT_", "void_native", "void-legion"),
    ("BELLDANDY_COMMANDER_", "void_native", "void-legion"),
    ("BELLDANDY_AGENT_CONFIG_FILE", "void_native", "void-legion"),
    # ── void-security：认证/allowlist/外发审批 ──
    ("BELLDANDY_AUTH_", "void_native", "void-security"),
    ("BELLDANDY_ALLOWED_ORIGINS", "void_native", "void-security"),
    ("BELLDANDY_EXTERNAL_OUTBOUND", "void_native", "void-security"),
    # ── void-automation：heartbeat/cron ──
    ("BELLDANDY_HEARTBEAT_", "defer", "void-automation"),
    ("BELLDANDY_CRON_", "dsh_mapped", None),
    ("BELLDANDY_ASSISTANT_MODE", "dsh_mapped", None),
    # ── void-core：host/port/state/log/资源/附件 ──
    ("BELLDANDY_HOST", "void_native", "void-core"),
    ("BELLDANDY_PORT", "void_native", "void-core"),
    ("BELLDANDY_GATEWAY_PORT", "legacy_or_omit", None),
    ("BELLDANDY_IMAGE", "legacy_or_omit", None),
    ("BELLDANDY_UPDATE_CHECK", "void_native", "void-core"),
    ("BELLDANDY_STATE_DIR", "void_native", "void-core"),
    ("BELLDANDY_WORKSPACE_DIR", "void_native", "void-core"),
    ("BELLDANDY_EXTRA_WORKSPACE_ROOTS", "void_native", "void-core"),
    ("BELLDANDY_LOG_", "void_native", "void-core"),
    ("BELLDANDY_RUNTIME_RESOURCE", "void_native", "void-core"),
    ("BELLDANDY_DEV_RUNTIME", "development_only", None),
    ("BELLDANDY_ATTACHMENT_", "void_native", "void-core"),
    ("BELLDANDY_WEB_ROOT", "void_native", "void-core"),
    # ── void-entry：WebChat UI/成本预算 ──
    ("BELLDANDY_WEBCHAT_", "void_native", "void-entry"),
    ("BELLDANDY_WEB_", "void_native", "void-entry"),
    # ── 补：未匹配项 ──
    ("BELLDANDY_COMMONS_OBSIDIAN", "void_native", "void-memory"),
    ("BELLDANDY_CONTEXT_INJECTION", "void_native", "void-memory"),
    ("BELLDANDY_TOOLS_ENABLED", "dsh_mapped", None),
    ("BELLDANDY_TOOL_RESULT_", "void_native", "void-memory"),
    # ── dsh_mapped：模型/会话/压缩/workflow/goal/prompt/mcp ──
    ("BELLDANDY_OPENAI_", "dsh_mapped", None),
    ("BELLDANDY_AGENT_PROVIDER", "dsh_mapped", None),
    ("BELLDANDY_AGENT_PROTOCOL", "dsh_mapped", None),
    ("BELLDANDY_AGENT_TIMEOUT", "dsh_mapped", None),
    ("BELLDANDY_MODEL_", "dsh_mapped", None),
    ("BELLDANDY_PROMPT_", "dsh_mapped", None),
    ("BELLDANDY_INJECT_", "dsh_mapped", None),
    ("BELLDANDY_PRIMARY_", "dsh_mapped", None),
    ("BELLDANDY_DEEPSEEK_ROUTE", "dsh_mapped", None),
    ("BELLDANDY_COMPACTION_", "dsh_mapped", None),
    ("BELLDANDY_COMPRESSION_", "dsh_mapped", None),
    ("BELLDANDY_PREFLIGHT_", "dsh_mapped", None),
    ("BELLDANDY_BUDGET_PROTECT", "dsh_mapped", None),
    ("BELLDANDY_STABLE_PREFIX", "dsh_mapped", None),
    ("BELLDANDY_MAX_HISTORY", "dsh_mapped", None),
    ("BELLDANDY_MAX_INPUT_TOKENS", "dsh_mapped", None),
    ("BELLDANDY_MAX_OUTPUT_TOKENS", "dsh_mapped", None),
    ("BELLDANDY_MAX_TOTAL_TOKENS", "dsh_mapped", None),
    ("BELLDANDY_MAX_SYSTEM_PROMPT_CHARS", "dsh_mapped", None),
    ("BELLDANDY_MAX_RUN_WALL_TIME", "dsh_mapped", None),
    ("BELLDANDY_MAX_TOOL_CALLS", "dsh_mapped", None),
    ("BELLDANDY_MAX_HIGH_RISK_TOOL_CALLS", "dsh_mapped", None),
    ("BELLDANDY_TOOL_LOOP_", "dsh_mapped", None),
    ("BELLDANDY_WORKFLOW_", "dsh_mapped", None),
    ("BELLDANDY_GOAL_", "dsh_mapped", None),
    ("BELLDANDY_MCP_", "dsh_mapped", None),
    ("BELLDANDY_CONVERSATION_ALLOWED_KINDS", "dsh_mapped", None),
    ("BELLDANDY_RESPONSES_SANITIZE", "dsh_mapped", None),
    ("BELLDANDY_TOKEN_USAGE_", "legacy_or_omit", None),
]

SENSITIVE_SUFFIX = re.compile(r"(API_KEY|TOKEN|SECRET|PASSWORD)$")


def classify(name: str):
    for prefix, cls, owner in PREFIX_MAP:
        if name.startswith(prefix):
            return cls, owner
    return None, None


def is_sensitive(name: str):
    return bool(SENSITIVE_SUFFIX.search(name)) or name.endswith("_PASS")


def main():
    vars_local = []
    for line in open(ENV_LOCAL, encoding="utf-8"):
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.+)$", line)
        if m:
            vars_local.append(m.group(1))
    vars_local = sorted(set(vars_local))

    caps = []
    unmatched = []
    for v in vars_local:
        cls, owner = classify(v)
        if cls is None:
            unmatched.append(v)
            cls, owner = "void_native", "void-core"  # 兜底，需人工核对
        # 凭据类强制 adapter_credential（无论前缀归属哪个 Module）
        if is_sensitive(v):
            cls = "adapter_credential"
        caps.append({
            "starVariable": v,
            "classification": cls,
            "owner": owner,
            "sensitive": is_sensitive(v),
            "dshEquivalent": None,
            "note": "",
        })

    out = {
        "schemaVersion": 2,
        "source": ENV_LOCAL,
        "sourceReadOnly": True,
        "generatedAt": "2026-08-16",
        "note": "以 .env.local 实际配置的现役变量为准（347 项）；.env.example 是能力模板（418 项，含 77 项 .env.local 未配置）。分类由 scripts/generate-void-capabilities.py 前缀映射批量生成，unmatched 项需人工核对。",
        "capabilities": caps,
    }
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"总变量: {len(caps)}")
    from collections import Counter
    print("分类分布:", dict(Counter(c["classification"] for c in caps)))
    print("敏感项:", [c["starVariable"] for c in caps if c["sensitive"]])
    if unmatched:
        print("!! 未匹配(需人工核对):", unmatched)
    else:
        print("未匹配: 无")


if __name__ == "__main__":
    main()
