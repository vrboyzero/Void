#!/usr/bin/env python3
"""
P0 机械化收敛：把 config/void-capabilities.json 的 425 项 + .env.example 默认值，
自动生成 void-core 的 ConfigField[] TS 代码（初稿，reloadMode/failureMode 为启发式）。

产出：packages/void-core/src/generated-capabilities.ts（勿手改，重新生成覆盖）。
启发式规则（可后续校准）：
- reloadMode：凭据/路径/端口/命令 → restart；*_ENABLED 开关 → live；其余 → restart。
- failureMode：敏感凭据 → fail_closed；其余 → degrade。
- key：BELLDANDY_ 前缀去掉后转 camelCase（结构化命名由各插件实现时再定）。
"""
import json
import re

JSON_PATH = "config/void-capabilities.json"
ENV_EXAMPLE = "/mnt/e/project/star-sanctuary/.env.example"
OUT_TS = "packages/void-core/src/generated-capabilities.ts"

RESTART_HINT = re.compile(r"(PATH|DIR|PORT|HOST|COMMAND|CWD|BASE_URL|API_KEY|SECRET|TOKEN|PASSWORD|_URL|_MODEL|_PROVIDER)")
ENABLED = re.compile(r"_ENABLED$")


def to_camel(name: str) -> str:
    """BELLDANDY_MEMORY_ENABLED -> memoryEnabled"""
    parts = name.replace("BELLDANDY_", "").split("_")
    if not parts:
        return name
    head = parts[0].lower()
    tail = "".join(p.capitalize() for p in parts[1:])
    return head + tail


def parse_default(raw: str):
    """把 .env.example 的非注释值解析成 TS 字面量"""
    v = raw.strip()
    if v == "":
        return None
    if v == "true":
        return "true"
    if v == "false":
        return "false"
    if re.match(r"^-?\d+$", v):
        return v
    if v.startswith('"') and v.endswith('"'):
        return v
    # 裸字符串（含注释内联）—— 取第一个 token
    token = v.split()[0]
    if token.startswith('"') and token.endswith('"'):
        return token
    return json.dumps(token)


def infer_reload_mode(name: str, sensitive: bool) -> str:
    if sensitive:
        return "restart"
    if RESTART_HINT.search(name):
        return "restart"
    if ENABLED.search(name):
        return "live"
    return "restart"


def infer_failure_mode(sensitive: bool) -> str:
    return "fail_closed" if sensitive else "degrade"


def main():
    caps = json.load(open(JSON_PATH, encoding="utf-8"))["capabilities"]

    # 读 .env.example 默认值（非注释行 VAR=value）
    defaults = {}
    for line in open(ENV_EXAMPLE, encoding="utf-8"):
        m = re.match(r"^[ \t]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if m:
            defaults[m.group(1)] = m.group(2)

    lines = [
        "// 自动生成，勿手改。来源：config/void-capabilities.json + .env.example",
        "// 生成：scripts/generate-capabilities-schema.py",
        'import type { ConfigField } from "./config-schema.js";',
        "",
        "export const CAPABILITY_FIELDS: ConfigField[] = [",
    ]
    for c in caps:
        name = c["starVariable"]
        key = to_camel(name)
        cls = c["classification"]
        owner = c["owner"] if c["owner"] else "void-core"
        sensitive = "true" if c["sensitive"] else "false"
        reload_mode = infer_reload_mode(name, c["sensitive"])
        failure_mode = infer_failure_mode(c["sensitive"])
        # 敏感凭据无默认值（.env.example 里是占位符 your_xxx_here，非真实默认）
        default = None if c["sensitive"] else parse_default(defaults.get(name, ""))
        default_part = f", default: {default}" if default is not None else ""
        lines.append(
            f'  {{ key: "{key}", classification: "{cls}", owner: "{owner}", '
            f"sensitive: {sensitive}, reloadMode: \"{reload_mode}\", "
            f'failureMode: "{failure_mode}"{default_part} }},'
        )
    lines.append("];")
    lines.append("")

    open(OUT_TS, "w", encoding="utf-8").write("\n".join(lines))
    print(f"✓ 生成 {len(caps)} 项 ConfigField → {OUT_TS}")


if __name__ == "__main__":
    main()
