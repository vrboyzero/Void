/**
 * schema 驱动的配置表单控件。
 *
 * 面板是**通用渲染器**：字段的存在与类型来自插件的 settings schema，中文标签与控件
 * 选择来自插件贡献的清单（见 host 半边 `registerPanel`）。因此新插件只要注册了
 * settings 命名空间并贡献清单，零改动就出现在这里。
 *
 * 每个控件都是受控的：`value` 进、`onCommit` 出，**写入由上层统一发起**——这样
 * revision 冲突、失败回滚、危险操作的二次确认都只有一处逻辑。
 *
 * @module @void/void-entry/client/controls
 */
import { createElement as h, useState } from "react";
import {
  Button,
  DisclosureRow,
  IconPlusOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
  StateDot,
  Switch,
  Input,
} from "@deepseek-ai/dsh-client-ui-primitives";

const MUTED = "#888";

/** 一行控件外壳：标签 + 控件 + 帮助文字 + 来源标记。 */
export function Field(props: {
  label: string;
  help?: string;
  /** true 表示该字段被用户在设置文档里显式覆盖过。 */
  overridden?: boolean;
  /** true 表示该字段来自组合入口，不可改。 */
  readOnly?: boolean;
  children?: React.ReactNode;
}): React.ReactElement {
  return h("div", { style: { padding: "6px 0 6px 24px" } },
    h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 } },
      h("span", { style: { fontSize: 13 } }, props.label),
      props.readOnly
        ? h("span", { style: { fontSize: 11, color: MUTED, border: `1px solid ${MUTED}`, borderRadius: 4, padding: "0 4px" } }, "只读")
        : null,
      props.overridden === true
        ? h("span", { style: { fontSize: 11, color: MUTED } }, "已自定义")
        : null,
    ),
    props.children,
    props.help
      ? h("div", { style: { fontSize: 11, color: MUTED, marginTop: 4 } }, props.help)
      : null,
  );
}

/** 受控开关行。 */
export function SwitchField(props: {
  label: string;
  help?: string;
  value: boolean;
  overridden?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}): React.ReactElement {
  return h(Field, { label: props.label, help: props.help, overridden: props.overridden, readOnly: props.readOnly },
    h(Switch, {
      checked: props.value,
      disabled: props.readOnly === true || props.disabled === true,
      label: props.label,
      onChange: props.onChange,
    }),
  );
}

/**
 * 文本行。
 *
 * 本地保存草稿、失焦时才提交：每敲一个字就发一次写回会把 revision 打乱，也会让
 * 服务端校验在用户还没写完时就报错。
 */
export function TextField(props: {
  label: string;
  help?: string;
  value: string;
  overridden?: boolean;
  readOnly?: boolean;
  multiline?: boolean;
  onChange: (next: string) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? props.value;
  return h(Field, { label: props.label, help: props.help, overridden: props.overridden, readOnly: props.readOnly },
    props.multiline === true
      ? h("textarea", {
          value: shown,
          readOnly: props.readOnly === true,
          rows: 3,
          style: { width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 12, padding: 6, borderRadius: 6, border: "1px solid rgba(128,128,128,0.3)", background: "transparent", color: "inherit", resize: "vertical" },
          onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value),
          onBlur: () => {
            if (draft !== null && draft !== props.value) props.onChange(draft);
            setDraft(null);
          },
        })
      : h(Input, {
          value: shown,
          readOnly: props.readOnly === true,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value),
          onBlur: () => {
            if (draft !== null && draft !== props.value) props.onChange(draft);
            setDraft(null);
          },
        }),
  );
}

/** 数字行。空字符串提交为 0，非法输入不提交。 */
export function NumberField(props: {
  label: string;
  help?: string;
  value: number;
  overridden?: boolean;
  readOnly?: boolean;
  onChange: (next: number) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  return h(Field, { label: props.label, help: props.help, overridden: props.overridden, readOnly: props.readOnly },
    h(Input, {
      type: "number",
      value: draft ?? String(props.value),
      readOnly: props.readOnly === true,
      style: { width: 140 },
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value),
      onBlur: () => {
        if (draft === null) return;
        const parsed = Number(draft);
        if (draft.trim() !== "" && Number.isFinite(parsed) && parsed !== props.value) props.onChange(parsed);
        setDraft(null);
      },
    }),
  );
}

/**
 * 字符串列表编辑器。
 *
 * 空行不提交——留一个空串在数组里会让服务端的正则或字段名校验以一个看不懂的
 * 方式失败。
 */
export function ListField(props: {
  label: string;
  help?: string;
  value: string[];
  overridden?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  onChange: (next: string[]) => void;
}): React.ReactElement {
  const items = props.value;
  const replace = (index: number, next: string) => {
    const copy = [...items];
    copy[index] = next;
    props.onChange(copy);
  };
  return h(Field, { label: props.label, help: props.help, overridden: props.overridden, readOnly: props.readOnly },
    h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
      ...items.map((item, index) =>
        h("div", { key: index, style: { display: "flex", gap: 6, alignItems: "center" } },
          h(Input, {
            value: item,
            readOnly: props.readOnly === true,
            placeholder: props.placeholder,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => replace(index, e.target.value),
          }),
          props.readOnly === true
            ? null
            : h(Button, {
                variant: "ghost",
                size: "sm",
                "aria-label": `删除 ${item}`,
                onClick: () => props.onChange(items.filter((_, i) => i !== index)),
              }, h(IconTrashOutline16, { size: 16 })),
        ),
      ),
      items.length === 0
        ? h("div", { style: { fontSize: 12, color: MUTED } }, "（空）")
        : null,
      props.readOnly === true
        ? null
        : h("div", null,
            h(Button, {
              variant: "ghost",
              size: "sm",
              icon: h(IconPlusOutline16, { size: 16 }),
              onClick: () => props.onChange([...items, ""]),
            }, "添加"),
          ),
    ),
  );
}

/** 清单里的操作词汇表一项。`implies` 是宿主算好的传递闭包。 */
export interface OperationEntry {
  value: string;
  label: string;
  implies: string[];
  mostUsed?: boolean;
}

/**
 * 权限矩阵。
 *
 * 关键设计：**自动带上的前置项显示为灰色说明，而不是替用户勾上复选框**。用户需要
 * 知道「我没勾它，但它实际生效了」；替勾会让人以为自己授权过。前置关系来自宿主下发
 * 的闭包，面板只做集合差。
 */
export function OperationsField(props: {
  label: string;
  help?: string;
  value: string[];
  vocabulary: OperationEntry[];
  overridden?: boolean;
  readOnly?: boolean;
  onChange: (next: string[]) => void;
}): React.ReactElement {
  const selected = new Set(props.value);
  const implied = new Set<string>();
  for (const name of props.value) {
    const entry = props.vocabulary.find((op) => op.value === name);
    for (const downstream of entry?.implies ?? []) if (!selected.has(downstream)) implied.add(downstream);
  }
  const granted = new Set([...selected, ...implied]);

  const toggle = (name: string, next: boolean) => {
    props.onChange(next ? [...props.value, name] : props.value.filter((v) => v !== name));
  };

  return h(Field, { label: props.label, help: props.help, overridden: props.overridden, readOnly: props.readOnly },
    h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 12px" } },
      ...props.vocabulary.map((op) => {
        const checked = selected.has(op.value);
        const auto = !checked && implied.has(op.value);
        return h("label", {
          key: op.value,
          style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "2px 0", opacity: granted.has(op.value) ? 1 : 0.55 },
        },
          h("input", {
            type: "checkbox",
            checked,
            disabled: props.readOnly === true,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => toggle(op.value, e.target.checked),
          }),
          h("span", null, op.label),
          op.mostUsed === true ? h("span", { style: { fontSize: 10, color: MUTED } }, "最常用") : null,
          auto ? h("span", { style: { fontSize: 10, color: MUTED } }, "自动") : null,
          h("code", { style: { fontSize: 10, color: MUTED, marginLeft: "auto" } }, op.value),
        );
      }),
    ),
    implied.size > 0
      ? h("div", { style: { fontSize: 11, color: MUTED, marginTop: 6 } },
          `灰色标注的 ${implied.size} 项没有直接勾选，但会被上面的选择自动带上：` +
            props.vocabulary.filter((op) => implied.has(op.value)).map((op) => op.label).join("、"),
        )
      : null,
  );
}

/** 一个 token 条目，形状与插件的 `tokens[]` 一致。 */
export interface TokenRow {
  callerId: string;
  tokenEnv: string;
  operations: string[];
}

/**
 * 调用方编辑器。
 *
 * **token 的值不在这里**：它只从环境变量读，既不写进配置也不显示。这里编辑的是
 * 「用哪个变量名」，所以面板只能告诉用户变量有没有配好，不能（也不该）显示值。
 */
export function TokensField(props: {
  label: string;
  help?: string;
  value: TokenRow[];
  vocabulary: OperationEntry[];
  overridden?: boolean;
  readOnly?: boolean;
  onChange: (next: TokenRow[]) => void;
}): React.ReactElement {
  const replace = (index: number, patch: Partial<TokenRow>) => {
    const copy = props.value.map((row, i) => (i === index ? { ...row, ...patch } : row));
    props.onChange(copy);
  };
  return h(Field, { label: props.label, help: props.help, overridden: props.overridden, readOnly: props.readOnly },
    h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
      ...props.value.map((row, index) =>
        h("div", {
          key: index,
          style: { border: "1px solid rgba(128,128,128,0.22)", borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 6 },
        },
          h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
            h("span", { style: { fontSize: 12, color: MUTED, width: 46 } }, "身份"),
            h(Input, {
              value: row.callerId,
              readOnly: props.readOnly === true,
              placeholder: "codex",
              style: { width: 120 },
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => replace(index, { callerId: e.target.value }),
            }),
            h("span", { style: { fontSize: 12, color: MUTED, width: 46 } }, "变量"),
            h(Input, {
              value: row.tokenEnv,
              readOnly: props.readOnly === true,
              placeholder: "CODEX_TOKEN",
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => replace(index, { tokenEnv: e.target.value }),
            }),
            props.readOnly === true
              ? null
              : h(Button, {
                  variant: "ghost",
                  size: "sm",
                  "aria-label": `删除调用方 ${row.callerId}`,
                  onClick: () => props.onChange(props.value.filter((_, i) => i !== index)),
                }, h(IconTrashOutline16, { size: 16 })),
          ),
          h(OperationsField, {
            label: "该调用方的权限",
            help: row.operations.length === 0 ? "留空则用上面的默认授权集合。" : undefined,
            value: row.operations,
            vocabulary: props.vocabulary,
            readOnly: props.readOnly,
            onChange: (next) => replace(index, { operations: next }),
          }),
        ),
      ),
      props.value.length === 0
        ? h("div", { style: { fontSize: 12, color: MUTED } }, "（还没有调用方）")
        : null,
      props.readOnly === true
        ? null
        : h("div", null,
            h(Button, {
              variant: "ghost",
              size: "sm",
              icon: h(IconPlusOutline16, { size: 16 }),
              onClick: () => props.onChange([...props.value, { callerId: "", tokenEnv: "", operations: [] }]),
            }, "添加调用方"),
          ),
    ),
  );
}

/** 一个配置分组的折叠外壳。折叠态显示摘要，展开后是字段。 */
export function Group(props: {
  title: string;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}): React.ReactElement {
  return h(DisclosureRow, {
    icon: h(IconSettingsOutline16, { size: 16 }),
    title: props.title,
    open: props.open,
    expandable: true,
    expandOnRowClick: true,
    onToggle: props.onToggle,
    collapsedContent: props.summary
      ? h("span", { style: { fontSize: 12, color: MUTED, marginLeft: 8 } }, props.summary)
      : null,
  }, props.children);
}

/** 分组或卡片级的提示行。 */
export function Hint(props: { text: string; tone?: "muted" | "danger" }): React.ReactElement {
  return h("div", {
    style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: props.tone === "danger" ? "#d33" : MUTED },
  },
    props.tone === "danger" ? h(StateDot, { state: "error", size: 8 }) : null,
    h("span", null, props.text),
  );
}
