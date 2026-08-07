import { describe, expect, test } from "bun:test";
import { parseCliOptions } from "../cli-options";

describe("parseCliOptions", () => {
  test("uses safe defaults", () => {
    expect(parseCliOptions([])).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  });

  test("maps --yolo to unrestricted app-server settings", () => {
    expect(parseCliOptions(["--yolo"])).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  test("supports the long Codex bypass flag", () => {
    expect(parseCliOptions(["--dangerously-bypass-approvals-and-sandbox"])).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  test("supports explicit sandbox and approval options", () => {
    expect(parseCliOptions(["--sandbox=read-only", "-a", "never"])).toEqual({
      approvalPolicy: "never",
      sandbox: "read-only",
    });
  });

  test("rejects options the wrapper cannot honor", () => {
    expect(() => parseCliOptions(["--search"])).toThrow("unsupported option: --search");
  });
});
