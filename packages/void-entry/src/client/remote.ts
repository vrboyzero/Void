/**
 * 设置面板的宿主 Remote 客户端。
 *
 * 面板不自己存配置：它通过宿主既有的 settings Remote 命名空间读写，也就是
 * **模型面板用的同一条通道**。好处是热生效、revision 防并发、密钥脱敏全都白拿
 * （方案 §29.2）。
 *
 * 协议是实测出来的，不是猜的：
 *
 * ```text
 * POST /api/settings/describe   {"type":"client-request","rpcId":..,"payload":{"args":{}}}
 * POST /api/settings/mutate     ...{"args":{"ns","ops":[{"op":"set","path":[...],"value"}],"expectedRevision"}}
 * -> {"result":{"ok":true,"value":{ns,schema,value,user,applies,secrets,revision}}}
 * -> {"result":{"ok":false,"error":{code,message}}}
 * ```
 *
 * @module @void/void-entry/client/remote
 */

/** schema 的序列化信封（宿主的 `schema.toJSON()`）。节点按 uid 索引，根是顶层 uid。 */
export interface SchemaEnvelope {
  uid: number;
  refs: Record<string, SchemaNode>;
}

/** schema 的一个节点。`type` 决定面板用哪个控件。 */
export interface SchemaNode {
  type: string;
  meta?: {
    default?: unknown;
    required?: boolean;
    min?: number;
    max?: number;
    step?: number;
    role?: string;
  };
  /** `object` 节点的字段表：字段名 → 节点 uid。 */
  dict?: Record<string, number>;
  /** `array` 节点的元素节点 uid。 */
  inner?: number;
  /** `union` 的候选节点 uid。 */
  list?: number[];
  /** `const` 的值。 */
  value?: unknown;
}

export interface NamespaceView {
  ns: string;
  schema: SchemaEnvelope;
  value: Record<string, unknown>;
  base?: Record<string, unknown>;
  user?: Record<string, unknown>;
  applies: "live" | "restart";
  secrets: Array<{ path: string[]; set: boolean }>;
  revision: number;
}

/** 一次写入要用到的路径寻址操作。 */
export interface PathOp {
  op: "set" | "delete";
  path: string[];
  value?: unknown;
}

export type RemoteOutcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

let rpcCounter = 0;

/**
 * 调一次宿主 Remote 方法。
 *
 * @param method - Remote 方法名，如 `settings/describe`。
 * @param args - 方法参数。
 * @returns 成功值或失败信息；网络异常也折叠成失败而不是抛出，好让面板统一显示。
 */
async function rpc<T>(method: string, args: unknown): Promise<RemoteOutcome<T>> {
  let response: Response;
  try {
    response = await fetch(`/api/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: `void-entry-${++rpcCounter}`,
        method,
        payload: { args },
      }),
    });
  } catch (error) {
    return { ok: false, code: "void/transport", message: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    return { ok: false, code: "void/http", message: `HTTP ${response.status}` };
  }
  const body = (await response.json()) as { result?: { ok?: boolean; value?: T; error?: { code?: string; message?: string } } };
  const result = body.result;
  if (result === undefined) return { ok: false, code: "void/protocol", message: "malformed response" };
  if (result.ok === true) return { ok: true, value: result.value as T };
  return {
    ok: false,
    code: result.error?.code ?? "void/unknown",
    message: result.error?.message ?? "settings request failed",
  };
}

/** 读出全部已注册的命名空间。 */
export async function describeNamespaces(): Promise<RemoteOutcome<NamespaceView[]>> {
  const outcome = await rpc<{ namespaces?: NamespaceView[] }>("settings/describe", {});
  if (!outcome.ok) return outcome;
  return { ok: true, value: outcome.value.namespaces ?? [] };
}

/**
 * 用路径寻址写回一组字段。
 *
 * @param ns - 命名空间。
 * @param ops - 要做的改动。
 * @param expectedRevision - 读到的 revision；服务端据此拒绝陈旧编辑器而不是静默覆盖。
 * @returns 写入后的命名空间视图。
 */
export async function mutateNamespace(
  ns: string,
  ops: PathOp[],
  expectedRevision: number,
): Promise<RemoteOutcome<NamespaceView>> {
  return rpc<NamespaceView>("settings/mutate", { ns, ops, expectedRevision });
}

/** 把路径寻址的改动表达成一句人话，用于乐观更新与错误提示。 */
export function describeOp(op: PathOp): string {
  return `${op.path.join(".")} = ${JSON.stringify(op.value)}`;
}
