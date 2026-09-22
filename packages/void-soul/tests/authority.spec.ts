import { describe, expect, it } from "vitest";
import { assertMayDirect, assertMayDirectAll } from "../src/index.js";

const manager = { id: "xiaobei", superiors: [], subordinates: ["xiaoma"] };
const worker = { id: "xiaoma", superiors: ["xiaobei"], subordinates: [] };

describe("assertMayDirect", () => {
  it("允许上级指挥下级，拒绝反向和未声明关系", () => {
    expect(() => assertMayDirect({ actor: manager, target: worker })).not.toThrow();
    expect(() => assertMayDirect({ actor: worker, target: manager })).toThrow(/不能指挥/);
    expect(() => assertMayDirect({ actor: manager, target: { id: "stranger", superiors: [], subordinates: [] } })).toThrow(/不能指挥/);
    expect(() => assertMayDirectAll(worker, [manager])).toThrow(/不能指挥/);
  });
});
