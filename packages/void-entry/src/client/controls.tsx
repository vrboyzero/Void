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
import { checkPatterns, pathPatternError } from "./patterns.js";
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

/**
 * 数组编辑器的草稿状态。
 *
 * 两条规则都是被真机验证逼出来的：
 *
 * 1. **失焦才提交**。原来每敲一个字就 `onChange`，一次输入会打出多次写回：每次都顶
 *    revision，服务端校验还会在用户没写完时就报错。
 * 2. **空行是本地草稿，提交时过滤掉**。「添加」先插一个空行；若立即提交，服务端会按
 *    「必须是存在的绝对目录」这类规则拒掉，于是行加不出来、用户只看到一句错误。
 *
 * @param value - 服务端当前值。
 * @param commit - 提交整份数组。
 * @param isBlank - 判断一行是否还是未填写的草稿。
 * @returns 展示用数组与三个操作入口。
 */
function useDraftArray<T>(
  value: T[],
  commit: (next: T[]) => void,
  isBlank: (row: T) => boolean,
): {
  shown: T[];
  edit: (next: T[]) => void;
  flush: () => void;
  commitNow: (next: T[]) => void;
  add: (blank: T) => void;
  remove: (index: number) => void;
} {
  const [draft, setDraft] = useState<T[] | null>(null);
  const shown = draft ?? value;
  // 空行永远不落盘；提交前统一清掉，用户就不必自己删掉刚点出来的空行。
  const settled = (rows: T[]) => rows.filter((row) => !isBlank(row));
  return {
    shown,
    edit: setDraft,
    flush: () => {
      if (draft !== null) {
        commit(settled(draft));
        setDraft(null);
      }
    },
    // 增删是离散动作，立即提交；提交的是去掉空行后的完整数组，这样「改了字又点删除」
    // 不会丢掉刚改的字。
    commitNow: (next: T[]) => {
      setDraft(null);
      commit(settled(next));
    },
    add: (blank: T) => setDraft([...shown, blank]),
    remove: (index: number) => {
      setDraft(null);
      commit(settled(shown.filter((_, i) => i !== index)));
    },
  };
}

/** 字符串列表的空行判定。 */
const blankString = (row: string): boolean => row.trim() === "";
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
  const { shown: items, edit, flush, remove, add } = useDraftArray(props.value, props.onChange, blankString);
  const replace = (index: number, next: string) => {
    const copy = [...items];
    copy[index] = next;
    edit(copy);
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
            onBlur: flush,
          }),
          props.readOnly === true
            ? null
            : h(Button, {
                variant: "ghost",
                size: "sm",
                "aria-label": `删除 ${item}`,
                onClick: () => remove(index),
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
              onClick: () => add(""),
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
  const { shown: rows, edit, flush, remove, add } = useDraftArray(props.value, props.onChange, (row) => row.callerId.trim() === "" || row.tokenEnv.trim() === "");
  const replace = (index: number, patch: Partial<TokenRow>) => {
    edit(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  return h(Field, { label: props.label, help: props.help, overridden: props.overridden, readOnly: props.readOnly },
    h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
      ...rows.map((row, index) =>
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
              onBlur: flush,
            }),
            h("span", { style: { fontSize: 12, color: MUTED, width: 46 } }, "变量"),
            h(Input, {
              value: row.tokenEnv,
              readOnly: props.readOnly === true,
              placeholder: "CODEX_TOKEN",
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => replace(index, { tokenEnv: e.target.value }),
              onBlur: flush,
            }),
            props.readOnly === true
              ? null
              : h(Button, {
                  variant: "ghost",
                  size: "sm",
                  "aria-label": `删除调用方 ${row.callerId}`,
                  onClick: () => remove(index),
                }, h(IconTrashOutline16, { size: 16 })),
          ),
          h(OperationsField, {
            label: "该调用方的权限",
            help: row.operations.length === 0 ? "留空则用上面的默认授权集合。" : undefined,
            value: row.operations,
            vocabulary: props.vocabulary,
            readOnly: props.readOnly,
            // 权限矩阵是离散点击，直接提交；此时草稿里的身份/变量改动也一并落盘。
            onChange: (next) => {
              const copy = rows.map((r, i) => (i === index ? { ...r, operations: next } : r));
              edit(copy);
              props.onChange(copy);
            },
          }),
        ),
      ),
      rows.length === 0
        ? h("div", { style: { fontSize: 12, color: MUTED } }, "（还没有调用方）")
        : null,
      props.readOnly === true
        ? null
        : h("div", null,
            h(Button, {
              variant: "ghost",
              size: "sm",
              icon: h(IconPlusOutline16, { size: 16 }),
              onClick: () => add({ callerId: "", tokenEnv: "", operations: [] }),
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


/** 枚举多选：一排勾选框。用于 `callback.events` 这类固定取值集合。 */
export function ChoicesField(props: {
  label: string;
  help?: string;
  value: string[];
  options: Array<{ value: string; label: string }>;
  overridden?: boolean;
  readOnly?: boolean;
  onChange: (next: string[]) => void;
}): React.ReactElement {
  const selected = new Set(props.value);
  return h(Field, { label: props.label, help: props.help, overridden: props.overridden, readOnly: props.readOnly },
    h("div", { style: { display: "flex", gap: 12, flexWrap: "wrap" } },
      ...props.options.map((option) =>
        h("label", { key: option.value, style: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12 } },
          h("input", {
            type: "checkbox",
            checked: selected.has(option.value),
            disabled: props.readOnly === true,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
              props.onChange(e.target.checked
                ? [...props.value, option.value]
                : props.value.filter((v) => v !== option.value)),
          }),
          h("span", null, option.label),
        ),
      ),
    ),
  );
}

/** 一条任务文档要求，形状与插件的 `requiredDocumentRules[]` 一致。 */
export interface DocumentRuleRow {
  id: string;
  description: string;
  required: boolean;
  pathPattern: string;
}


/**
 * 任务文档要求编辑器。
 *
 * 每条规则四个字段紧凑排布。此前 `requiredDocumentRules` 退化成只读 JSON，等于这一块
 * 配置在面板里是缺失的。路径正则**当场编译**，写错立刻标红，而不是等运行时
 * `compilePolicy` 抛错。
 */
export function RulesField(props: {
  label: string;
  help?: string;
  value: DocumentRuleRow[];
  overridden?: boolean;
  readOnly?: boolean;
  onChange: (next: DocumentRuleRow[]) => void;
}): React.ReactElement {
  const { shown: rules, edit, flush, remove, add } = useDraftArray(props.value, props.onChange, (rule) => rule.id.trim() === "");
  // 空 id 的规则在服务端会被拒，而且报错是 `invalid pathPattern of rule ""` 这种看不
  // 懂的话。这里先拦住，把原因留在界面上。
  const blankId = rules.some((rule) => rule.id.trim() === "");
  const guardedFlush = () => {
    if (!blankId) flush();
  };
  const replace = (index: number, patch: Partial<DocumentRuleRow>) => {
    edit(rules.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  return h(Field, { label: props.label, help: props.help, overridden: props.overridden, readOnly: props.readOnly },
    h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
      ...rules.map((rule, index) => {
        const patternError = pathPatternError(rule.pathPattern);
        return h("div", {
          key: index,
          style: { border: "1px solid rgba(128,128,128,0.22)", borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 4 },
        },
          h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
            h(Input, {
              value: rule.id,
              readOnly: props.readOnly === true,
              placeholder: "规则 id",
              style: { width: 130 },
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => replace(index, { id: e.target.value }),
              onBlur: guardedFlush,
            }),
            h(Input, {
              value: rule.description,
              readOnly: props.readOnly === true,
              placeholder: "说明",
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => replace(index, { description: e.target.value }),
              onBlur: guardedFlush,
            }),
            h("label", { style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, whiteSpace: "nowrap" } },
              h("input", {
                type: "checkbox",
                checked: rule.required,
                disabled: props.readOnly === true,
                onChange: (e: React.ChangeEvent<HTMLInputElement>) => { replace(index, { required: e.target.checked }); },
              }),
              "必填",
            ),
            props.readOnly === true
              ? null
              : h(Button, {
                  variant: "ghost",
                  size: "sm",
                  "aria-label": `删除规则 ${rule.id}`,
                  onClick: () => remove(index),
                }, h(IconTrashOutline16, { size: 16 })),
          ),
          h(Input, {
            value: rule.pathPattern,
            readOnly: props.readOnly === true,
            placeholder: "匹配工作区相对路径的正则；留空表示任意路径都满足",
            style: patternError === undefined ? undefined : { borderColor: "#d33" },
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => replace(index, { pathPattern: e.target.value }),
            onBlur: guardedFlush,
          }),
          patternError === undefined
            ? null
            : h("div", { style: { fontSize: 11, color: "#d33" } }, `正则无法编译：${patternError}`),
        );
      }),
      rules.length === 0 ? h("div", { style: { fontSize: 12, color: MUTED } }, "（没有文档要求）") : null,
      blankId ? h("div", { style: { fontSize: 11, color: "#d33" } }, "每条要求都要有 id，补齐后才会保存。") : null,
      props.readOnly === true
        ? null
        : h("div", null,
            h(Button, {
              variant: "ghost",
              size: "sm",
              icon: h(IconPlusOutline16, { size: 16 }),
              onClick: () => add({ id: "", description: "", required: true, pathPattern: "" }),
            }, "添加要求"),
          ),
    ),
  );
}

/**
 * 禁用正则编辑器，带试匹配。
 *
 * 两条即时反馈：写错的正则标红；给一段样例文本就能看到哪几条会命中——「命中即拒绝」
 * 的实际效果光看正则看不出来，尤其是想挡住密钥格式的时候。
 */
export function PatternListField(props: {
  label: string;
  help?: string;
  value: string[];
  overridden?: boolean;
  readOnly?: boolean;
  onChange: (next: string[]) => void;
}): React.ReactElement {
  const [sample, setSample] = useState("");
  const { shown: sources, edit, flush, remove, add } = useDraftArray(props.value, props.onChange, blankString);
  const checks = checkPatterns(sources, sample);
  return h(Field, { label: props.label, help: props.help, overridden: props.overridden, readOnly: props.readOnly },
    h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
      ...checks.map((check, index) =>
        h("div", { key: index, style: { display: "flex", gap: 6, alignItems: "center" } },
          h(Input, {
            value: check.source,
            readOnly: props.readOnly === true,
            placeholder: "正则",
            style: check.error === undefined ? undefined : { borderColor: "#d33" },
            onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
              edit(sources.map((v, i) => (i === index ? e.target.value : v))),
            onBlur: flush,
          }),
          check.error !== undefined
            ? h("span", { style: { fontSize: 11, color: "#d33", whiteSpace: "nowrap" } }, "无法编译")
            : check.matched === undefined
              ? null
              : h("span", { style: { fontSize: 11, whiteSpace: "nowrap", color: check.matched ? "#d33" : MUTED } },
                  check.matched ? "命中 → 会拒绝" : "未命中"),
          props.readOnly === true
            ? null
            : h(Button, {
                variant: "ghost",
                size: "sm",
                "aria-label": `删除正则 ${check.source}`,
                onClick: () => remove(index),
              }, h(IconTrashOutline16, { size: 16 })),
        ),
      ),
      sources.length === 0 ? h("div", { style: { fontSize: 12, color: MUTED } }, "（没有禁用正则）") : null,
      props.readOnly === true
        ? null
        : h("div", null,
            h(Button, {
              variant: "ghost",
              size: "sm",
              icon: h(IconPlusOutline16, { size: 16 }),
              onClick: () => add(""),
            }, "添加正则"),
          ),
      sources.length === 0
        ? null
        : h("div", { style: { marginTop: 4 } },
            h("div", { style: { fontSize: 11, color: MUTED, marginBottom: 3 } }, "试匹配（不会保存，只用来观察命中效果）"),
            h(Input, {
              value: sample,
              placeholder: "粘贴一段文本，看哪几条正则会命中…",
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => setSample(e.target.value),
            }),
          ),
    ),
  );
}
