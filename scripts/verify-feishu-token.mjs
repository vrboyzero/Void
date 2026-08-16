#!/usr/bin/env node
/**
 * 级别① 受控验证：用真实飞书凭据换 tenant_access_token，验证凭据有效 + API 可达。
 * 不发任何消息。凭据从 Void/.env.local 读，绝不回显 secret / 完整 token。
 * 直连飞书 open API（与 SDK 的 auth.tenantAccessToken.internal 同一底层接口），无依赖。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = loadEnv(resolve(root, ".env.local"));
const appId = env.VOID_FEISHU_APP_ID;
const appSecret = env.VOID_FEISHU_APP_SECRET;

if (!appId || !appSecret) {
  console.error("✗ 缺凭据：请先在 Void/.env.local 填 VOID_FEISHU_APP_ID / VOID_FEISHU_APP_SECRET");
  process.exit(1);
}

function mask(s) {
  if (s.length <= 8) return "***";
  return s.slice(0, 4) + "***" + s.slice(-2);
}

console.log(`app_id: ${mask(appId)}`);

try {
  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const body = await res.json();
  if (body.code === 0) {
    const token = body.tenant_access_token;
    console.log("✓ 凭据有效，tenant_access_token 获取成功");
    console.log(`  code: ${body.code}`);
    console.log(`  token: ${token ? `已获取（长度 ${token.length}）` : "未返回"}`);
    console.log(`  expire: ${body.expire ?? "未知"} 秒`);
  } else {
    console.error(`✗ 凭据无效：code=${body.code}, msg=${body.msg}`);
    process.exit(1);
  }
} catch (error) {
  console.error("✗ 请求失败:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function loadEnv(path) {
  const out = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
