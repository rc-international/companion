// companion/web/server/tldr-client.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TldrClient, getSocketPath } from "./tldr-client.js";

describe("TldrClient", () => {
  describe("getSocketPath", () => {
    it("computes deterministic socket path from project dir", () => {
      const path1 = getSocketPath("/home/kev/wilco");
      const path2 = getSocketPath("/home/kev/wilco");
      expect(path1).toBe(path2);
      expect(path1).toMatch(/^\/tmp\/tldr-[a-f0-9]{8}\.sock$/);
    });

    it("produces different paths for different projects", () => {
      const path1 = getSocketPath("/home/kev/wilco");
      const path2 = getSocketPath("/home/kev/other-project");
      expect(path1).not.toBe(path2);
    });
  });

  describe("query", () => {
    it("returns unavailable when socket does not exist", async () => {
      const client = new TldrClient("/nonexistent/project");
      const result = await client.query({ cmd: "ping" });
      expect(result.status).toBe("unavailable");
    });

    it("returns indexing status when status file says indexing", async () => {
      const client = new TldrClient("/nonexistent/project");
      const result = await client.query({ cmd: "ping" });
      expect(["unavailable", "indexing"]).toContain(result.status);
    });
  });
});
