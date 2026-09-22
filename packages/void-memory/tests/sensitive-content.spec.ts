import { describe, expect, it } from "vitest";
import { assertNoSensitiveContent, scanSensitiveContent, SensitiveContentError } from "../src/sensitive-content.js";

const OPENAI_KEY = "sk-1234567890abcdefghijklmnopqrst";
const GITHUB_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----";

describe("敏感内容闸门", () => {
  it("认出已知密钥形态", () => {
    expect(scanSensitiveContent(`remember ${OPENAI_KEY}`)[0]?.kind).toBe("openai-key");
    expect(scanSensitiveContent(GITHUB_TOKEN)[0]?.kind).toBe("github-token");
    expect(scanSensitiveContent(`aws=${AWS_KEY}`)[0]?.kind).toBe("aws-access-key");
    expect(scanSensitiveContent(PRIVATE_KEY)[0]?.kind).toBe("private-key");
    expect(scanSensitiveContent("password: hunter2hunter2")[0]?.kind).toBe("assigned-credential");
    expect(scanSensitiveContent("Authorization: Bearer abcdefghijklmnopqrstuvwx")[0]?.kind).toBe("bearer-token");
  });

  it("放过普通叙述，不把中文提示当成密钥", () => {
    expect(scanSensitiveContent("密码提示：用邮箱找回")).toEqual([]);
    expect(scanSensitiveContent("今天和小马一起把记忆层拆开了")).toEqual([]);
    expect(scanSensitiveContent("api key 的命名规范写在守则第二条")).toEqual([]);
  });

  it("拒绝信息只带类型，不回显原文", () => {
    let captured: unknown;
    try {
      assertNoSensitiveContent(`token ${OPENAI_KEY}`);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(SensitiveContentError);
    const message = (captured as Error).message;
    expect(message).toContain("openai-key");
    expect(message).not.toContain(OPENAI_KEY);
    expect(message).not.toContain("1234567890abcdefghijklmnopqrst");
  });

  it("干净正文正常通过", () => {
    expect(() => assertNoSensitiveContent("小贝的第一条守则：先看清再动手。")).not.toThrow();
  });
});
