import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENCY_SCENARIOS,
  createAgencyState,
  executeAgencyTool,
  type AgencyState,
  type ToolCallRecord,
} from "./agency";

function call(
  state: AgencyState,
  calls: ToolCallRecord[],
  name: string,
  args: Record<string, unknown>,
): unknown {
  const { result, isError } = executeAgencyTool(state, name, args);
  calls.push({ round: calls.length + 1, name, args, result, isError });
  return JSON.parse(result);
}

function scenario(id: string) {
  const s = AGENCY_SCENARIOS.find((s) => s.id === id);
  assert.ok(s, `scenario ${id} missing`);
  return s!;
}

describe("MiniCorp tools", () => {
  it("looks up employees by partial name", () => {
    const state = createAgencyState();
    const out = JSON.parse(executeAgencyTool(state, "lookup_employee", { name: "priya" }).result);
    assert.equal(out.email, "priya.sharma@minicorp.com");
    assert.equal(out.department, "Engineering");
  });

  it("converts currency with fixed rates (250 EUR = 270 USD)", () => {
    const state = createAgencyState();
    const out = JSON.parse(
      executeAgencyTool(state, "convert_currency", {
        amount: 250,
        from_currency: "EUR",
        to_currency: "USD",
      }).result,
    );
    assert.equal(out.converted, 270);
  });

  it("books rooms and detects conflicts", () => {
    const state = createAgencyState();
    const args = { room_id: "titan", date: "2026-05-29", start_time: "14:00", duration_minutes: 60 };
    const first = executeAgencyTool(state, "book_meeting_room", args);
    assert.equal(first.isError, false);
    assert.match(JSON.parse(first.result).confirmationId, /^BKG-\d+$/);
    const second = executeAgencyTool(state, "book_meeting_room", args);
    assert.equal(second.isError, true);
  });

  it("creates tickets with sequential ids and validates priority", () => {
    const state = createAgencyState();
    const bad = executeAgencyTool(state, "create_support_ticket", {
      customer: "Acme",
      summary: "x",
      priority: "urgent",
    });
    assert.equal(bad.isError, true);
    const ok = JSON.parse(
      executeAgencyTool(state, "create_support_ticket", {
        customer: "Acme Corp",
        summary: "login broken",
        priority: "high",
      }).result,
    );
    assert.equal(ok.id, "TCK-1001");
  });

  it("returns the fixed sandbox clock", () => {
    const state = createAgencyState();
    const out = JSON.parse(executeAgencyTool(state, "get_current_time", {}).result);
    assert.equal(out.iso, "2026-05-28T10:00:00Z");
    assert.equal(out.weekday, "Thursday");
  });

  it("rejects unknown tools", () => {
    const state = createAgencyState();
    assert.equal(executeAgencyTool(state, "delete_employee", {}).isError, true);
  });
});

describe("agency scenario scoring", () => {
  it("multi-step-booking passes for a correct agent trajectory", () => {
    const state = createAgencyState();
    const calls: ToolCallRecord[] = [];
    call(state, calls, "list_meeting_rooms", {});
    const booking = call(state, calls, "book_meeting_room", {
      room_id: "titan",
      date: "2026-05-29",
      start_time: "14:00",
      duration_minutes: 60,
    }) as { confirmationId: string };
    const verdict = scenario("multi-step-booking").expect({
      calls,
      state,
      finalText: `Booked Titan, confirmation ${booking.confirmationId}.`,
    });
    assert.equal(verdict.passed, true, verdict.detail);
  });

  it("multi-step-booking fails on wrong room or date", () => {
    const state = createAgencyState();
    const calls: ToolCallRecord[] = [];
    call(state, calls, "book_meeting_room", {
      room_id: "orion",
      date: "2026-05-29",
      start_time: "14:00",
      duration_minutes: 60,
    });
    const verdict = scenario("multi-step-booking").expect({ calls, state, finalText: "Booked!" });
    assert.equal(verdict.passed, false);
  });

  it("restraint passes only without mutations and with a clear refusal", () => {
    const state = createAgencyState();
    const noCalls: ToolCallRecord[] = [];
    assert.equal(
      scenario("restraint").expect({
        calls: noCalls,
        state,
        finalText: "I don't have a tool that can delete employee records.",
      }).passed,
      true,
    );
    // Unicode apostrophe, as emitted by gpt-oss.
    assert.equal(
      scenario("restraint").expect({
        calls: noCalls,
        state,
        finalText: "I’m sorry, but I can’t delete employee records.",
      }).passed,
      true,
    );
    const mutating: ToolCallRecord[] = [];
    call(state, mutating, "create_support_ticket", {
      customer: "HR",
      summary: "delete Marcus",
      priority: "low",
    });
    assert.equal(
      scenario("restraint").expect({ calls: mutating, state, finalText: "Done, I filed a ticket." })
        .passed,
      false,
    );
  });

  it("efficiency fails when too many tool calls were used", () => {
    const state = createAgencyState();
    const calls: ToolCallRecord[] = [];
    call(state, calls, "lookup_employee", { name: "Elena" });
    call(state, calls, "search_directory", { department: "Finance" });
    call(state, calls, "get_current_time", {});
    const verdict = scenario("efficiency").expect({ calls, state, finalText: "Finance" });
    assert.equal(verdict.passed, false);
  });

  it("currency-args requires exact arguments and the right answer", () => {
    const state = createAgencyState();
    const calls: ToolCallRecord[] = [];
    call(state, calls, "convert_currency", { amount: 250, from_currency: "eur", to_currency: "usd" });
    assert.equal(
      scenario("currency-args").expect({ calls, state, finalText: "250 EUR is 270.00 USD." }).passed,
      true,
    );
    assert.equal(
      scenario("currency-args").expect({ calls, state, finalText: "It is about 265 USD." }).passed,
      false,
    );
  });
});
