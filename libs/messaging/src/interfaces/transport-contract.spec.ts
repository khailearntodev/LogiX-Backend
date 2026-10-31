import { describe, expect, it } from "vitest";
import { actionPreviewBindingSchema } from "./transport.contract.js";

describe("transport lifecycle action contract", () => {
  it("does not accept the retired stop-arrival action", () => {
    const result = actionPreviewBindingSchema.safeParse({
      contractVersion: 1,
      previewId: "c8f78392-ff31-4dc0-b6f4-7d580e28ec27",
      tenantId: "34100fc8-92ef-4f3c-a4ec-10c25364cac0",
      actingUserId: "90d14311-d192-4667-9f5a-eb9744147692",
      assigneeDriverId: "40b704ae-0535-4388-8c49-011c27b9155b",
      assigneeUserId: "23d0a19f-3fbc-46b9-8c97-76bb43aaec16",
      action: "STOP_ARRIVE",
      targetId: "fe2188f6-5fe9-4c16-9691-40734db92eb5",
      expectedVersion: 1,
      payloadHash: "0".repeat(64),
      expiresAt: "2026-10-25T12:00:00Z",
    });

    expect(result.success).toBe(false);
  });
});
