import { describe, it, expect } from "bun:test";
import { parseInboundMessage } from "../protocol";

describe("parseInboundMessage", () => {
  describe("approval_response", () => {
    it("accepts a valid accept response", () => {
      const msg = parseInboundMessage({
        type: "approval_response",
        id: "approval_42",
        decision: "accept",
      });
      expect(msg).not.toBeNull();
      expect(msg?.type).toBe("approval_response");
    });

    it("accepts a valid decline response", () => {
      const msg = parseInboundMessage({
        type: "approval_response",
        id: "approval_42",
        decision: "decline",
      });
      expect(msg).not.toBeNull();
    });

    it("rejects an unknown decision value", () => {
      expect(
        parseInboundMessage({
          type: "approval_response",
          id: "approval_42",
          decision: "maybe",
        }),
      ).toBeNull();
    });

    it("rejects a non-string id", () => {
      expect(
        parseInboundMessage({
          type: "approval_response",
          id: 42,
          decision: "accept",
        }),
      ).toBeNull();
    });
  });

  describe("message", () => {
    it("accepts a minimal valid message", () => {
      const msg = parseInboundMessage({
        type: "message",
        id: "m1",
        content: "hello",
        sender: { name: "phone" },
      });
      expect(msg).not.toBeNull();
      expect(msg?.type).toBe("message");
    });

    it("rejects unknown types", () => {
      expect(parseInboundMessage({ type: "this-is-not-a-real-type" })).toBeNull();
    });
  });
});
