import { describe, expect, it } from "vitest";
import { createVoidWidgetsService } from "../src/client/widgets.js";

describe("void-entry widgets service (壳 A 服务化扩展点)", () => {
  it("registers widgets and returns a sorted snapshot", () => {
    const service = createVoidWidgetsService();
    service.registerWidget({ id: "void-legion:org-chart", title: "组织图", order: 20, component: null });
    service.registerWidget({ id: "void-memory:viewer", title: "记忆", order: 10, component: null });
    expect(service.getWidgets().map((w) => w.id)).toEqual([
      "void-memory:viewer",
      "void-legion:org-chart",
    ]);
  });

  it("rejects a duplicate id", () => {
    const service = createVoidWidgetsService();
    service.registerWidget({ id: "void-legion:org-chart", title: "组织图", component: null });
    expect(() =>
      service.registerWidget({ id: "void-legion:org-chart", title: "重复", component: null }),
    ).toThrow(/already registered/);
  });

  it("disposes a widget (HMR-safe) and notifies subscribers", () => {
    const service = createVoidWidgetsService();
    let notified = 0;
    const off = service.subscribe(() => { notified += 1; });
    const dispose = service.registerWidget({ id: "void-legion:org-chart", title: "组织图", component: null });
    expect(service.getWidgets()).toHaveLength(1);
    dispose();
    expect(service.getWidgets()).toHaveLength(0);
    expect(notified).toBe(2); // register + dispose
    off();
  });
});
