/**
 * MiniCorp — deterministic simulated company environment for the agency
 * benchmark. Pure state + tool executor + pass/fail scenario scoring.
 * The sandbox clock is fixed so every run sees the identical world.
 */

export const AGENCY_CLOCK_ISO = "2026-05-28T10:00:00Z";
export const AGENCY_CLOCK_WEEKDAY = "Thursday";
export const AGENCY_MAX_TOOL_ROUNDS = 8;
export const AGENCY_MAX_TOKENS_PER_ROUND = 2048;

export interface Employee {
  name: string;
  email: string;
  department: string;
  title: string;
  manager: string | null;
}

const EMPLOYEES: Employee[] = [
  { name: "Priya Sharma", email: "priya.sharma@minicorp.com", department: "Engineering", title: "Senior Engineer", manager: "Marcus Webb" },
  { name: "Marcus Webb", email: "marcus.webb@minicorp.com", department: "Engineering", title: "Engineering Lead", manager: null },
  { name: "Elena Rossi", email: "elena.rossi@minicorp.com", department: "Finance", title: "Financial Analyst", manager: "David Cohen" },
  { name: "David Cohen", email: "david.cohen@minicorp.com", department: "Finance", title: "Finance Director", manager: null },
  { name: "Tom Baker", email: "tom.baker@minicorp.com", department: "Support", title: "Support Specialist", manager: "Aisha Khan" },
  { name: "Aisha Khan", email: "aisha.khan@minicorp.com", department: "Support", title: "Support Manager", manager: null },
];

const ROOMS = [
  { id: "orion", name: "Orion", capacity: 4 },
  { id: "atlas", name: "Atlas", capacity: 8 },
  { id: "titan", name: "Titan", capacity: 14 },
];

/** Rates to USD. Fixed — not live data. */
const FX_TO_USD: Record<string, number> = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  JPY: 0.0065,
  CHF: 1.1,
};

export interface Booking {
  confirmationId: string;
  roomId: string;
  date: string;
  startTime: string;
  durationMinutes: number;
}

export interface Ticket {
  id: string;
  customer: string;
  summary: string;
  priority: string;
  status: string;
}

export interface SentEmail {
  to: string;
  subject: string;
  body: string;
}

export interface AgencyState {
  bookings: Booking[];
  tickets: Ticket[];
  emails: SentEmail[];
  nextTicketNumber: number;
  nextBookingNumber: number;
}

export function createAgencyState(): AgencyState {
  return {
    bookings: [],
    tickets: [
      { id: "TCK-1000", customer: "Globex", summary: "Password reset loop on portal", priority: "medium", status: "open" },
    ],
    emails: [],
    nextTicketNumber: 1001,
    nextBookingNumber: 500,
  };
}

export interface ToolCallRecord {
  round: number;
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
}

/** OpenAI-format tool declarations sent to the model. */
export const AGENCY_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "lookup_employee",
      description: "Look up a MiniCorp employee by full or partial name. Returns email, department, title, and manager.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Full or partial employee name" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_directory",
      description: "List all MiniCorp employees in a department.",
      parameters: {
        type: "object",
        properties: { department: { type: "string", description: "Department name, e.g. Engineering" } },
        required: ["department"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_meeting_rooms",
      description: "List available meeting rooms with capacities.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "book_meeting_room",
      description: "Book a meeting room. Returns a confirmation ID.",
      parameters: {
        type: "object",
        properties: {
          room_id: { type: "string", description: "Room id: orion, atlas, or titan" },
          date: { type: "string", description: "Date in YYYY-MM-DD" },
          start_time: { type: "string", description: "Start time in 24h HH:MM" },
          duration_minutes: { type: "number", description: "Duration in minutes" },
        },
        required: ["room_id", "date", "start_time", "duration_minutes"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_support_ticket",
      description: "Open a customer support ticket. Returns the new ticket ID.",
      parameters: {
        type: "object",
        properties: {
          customer: { type: "string", description: "Customer or company name" },
          summary: { type: "string", description: "Short issue summary" },
          priority: { type: "string", description: "low, medium, or high" },
        },
        required: ["customer", "summary", "priority"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_ticket_status",
      description: "Get the status of an existing support ticket by ID.",
      parameters: {
        type: "object",
        properties: { ticket_id: { type: "string", description: "Ticket ID, e.g. TCK-1000" } },
        required: ["ticket_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "convert_currency",
      description: "Convert an amount between currencies using MiniCorp's fixed internal rates.",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Amount to convert" },
          from_currency: { type: "string", description: "ISO code, e.g. EUR" },
          to_currency: { type: "string", description: "ISO code, e.g. USD" },
        },
        required: ["amount", "from_currency", "to_currency"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_current_time",
      description: "Get the current date and time (UTC).",
      parameters: { type: "object", properties: {} },
    },
  },
];

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[, ]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** Execute a tool against the sandbox. Returns a JSON string result. */
export function executeAgencyTool(
  state: AgencyState,
  name: string,
  args: Record<string, unknown>,
): { result: string; isError: boolean } {
  const ok = (data: unknown) => ({ result: JSON.stringify(data), isError: false });
  const err = (message: string) => ({ result: JSON.stringify({ error: message }), isError: true });

  switch (name) {
    case "lookup_employee": {
      const q = asString(args.name).trim().toLowerCase();
      if (!q) return err("name is required");
      const matches = EMPLOYEES.filter((e) => e.name.toLowerCase().includes(q));
      if (matches.length === 0) return err(`no employee matching "${args.name}"`);
      return ok(matches.length === 1 ? matches[0] : matches);
    }
    case "search_directory": {
      const dept = asString(args.department).trim().toLowerCase();
      const matches = EMPLOYEES.filter((e) => e.department.toLowerCase() === dept);
      if (matches.length === 0) return err(`no employees in department "${args.department}"`);
      return ok(matches);
    }
    case "list_meeting_rooms":
      return ok(ROOMS);
    case "book_meeting_room": {
      const roomId = asString(args.room_id).trim().toLowerCase();
      const room = ROOMS.find((r) => r.id === roomId || r.name.toLowerCase() === roomId);
      if (!room) return err(`unknown room "${args.room_id}" — valid: orion, atlas, titan`);
      const date = asString(args.date).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err("date must be YYYY-MM-DD");
      const startTime = asString(args.start_time).trim();
      if (!/^\d{1,2}:\d{2}$/.test(startTime)) return err("start_time must be 24h HH:MM");
      const duration = asNumber(args.duration_minutes);
      if (duration == null || duration <= 0) return err("duration_minutes must be a positive number");
      const conflict = state.bookings.find(
        (b) => b.roomId === room.id && b.date === date && b.startTime === startTime,
      );
      if (conflict) return err(`room ${room.id} already booked at ${date} ${startTime}`);
      const booking: Booking = {
        confirmationId: `BKG-${state.nextBookingNumber++}`,
        roomId: room.id,
        date,
        startTime,
        durationMinutes: duration,
      };
      state.bookings.push(booking);
      return ok(booking);
    }
    case "create_support_ticket": {
      const customer = asString(args.customer).trim();
      const summary = asString(args.summary).trim();
      const priority = asString(args.priority).trim().toLowerCase();
      if (!customer || !summary) return err("customer and summary are required");
      if (!["low", "medium", "high"].includes(priority)) return err("priority must be low, medium, or high");
      const ticket: Ticket = {
        id: `TCK-${state.nextTicketNumber++}`,
        customer,
        summary,
        priority,
        status: "open",
      };
      state.tickets.push(ticket);
      return ok(ticket);
    }
    case "get_ticket_status": {
      const id = asString(args.ticket_id).trim().toUpperCase();
      const ticket = state.tickets.find((t) => t.id === id);
      if (!ticket) return err(`no ticket with id "${args.ticket_id}"`);
      return ok(ticket);
    }
    case "convert_currency": {
      const amount = asNumber(args.amount);
      const from = asString(args.from_currency).trim().toUpperCase();
      const to = asString(args.to_currency).trim().toUpperCase();
      if (amount == null) return err("amount must be a number");
      if (!(from in FX_TO_USD)) return err(`unsupported currency "${from}"`);
      if (!(to in FX_TO_USD)) return err(`unsupported currency "${to}"`);
      const converted = Math.round(((amount * FX_TO_USD[from]) / FX_TO_USD[to]) * 100) / 100;
      return ok({ amount, from_currency: from, to_currency: to, converted });
    }
    case "get_current_time":
      return ok({ iso: AGENCY_CLOCK_ISO, weekday: AGENCY_CLOCK_WEEKDAY, timezone: "UTC" });
    default:
      return err(`unknown tool "${name}"`);
  }
}

export const AGENCY_SYSTEM_PROMPT =
  "You are the MiniCorp office assistant. Use the provided tools to complete the user's request, " +
  "then reply with a concise final answer. Only call tools that are necessary. " +
  `The current date and time is ${AGENCY_CLOCK_ISO} (${AGENCY_CLOCK_WEEKDAY}), UTC.`;

const MUTATING_TOOLS = new Set(["book_meeting_room", "create_support_ticket"]);

export interface AgencyScenario {
  id: string;
  name: string;
  skill: string;
  prompt: string;
  expect: (ctx: {
    calls: ToolCallRecord[];
    state: AgencyState;
    finalText: string;
  }) => { passed: boolean; detail?: string };
}

function called(calls: ToolCallRecord[], name: string): ToolCallRecord[] {
  return calls.filter((c) => c.name === name);
}

function mutations(calls: ToolCallRecord[]): ToolCallRecord[] {
  return calls.filter((c) => MUTATING_TOOLS.has(c.name) && !c.isError);
}

export const AGENCY_SCENARIOS: AgencyScenario[] = [
  {
    id: "lookup-email",
    name: "Employee email lookup",
    skill: "tool selection",
    prompt: "What is Priya Sharma's email address?",
    expect: ({ calls, finalText }) => {
      const used = called(calls, "lookup_employee").length + called(calls, "search_directory").length;
      if (used === 0) return { passed: false, detail: "never queried the directory" };
      if (!/priya\.sharma@minicorp\.com/i.test(finalText))
        return { passed: false, detail: "final answer does not contain the correct email" };
      return { passed: true };
    },
  },
  {
    id: "currency-args",
    name: "Currency conversion argument accuracy",
    skill: "argument accuracy",
    prompt: "How much is 250 EUR in USD? Use MiniCorp's internal rates.",
    expect: ({ calls, finalText }) => {
      const conv = called(calls, "convert_currency").find(
        (c) =>
          asNumber(c.args.amount) === 250 &&
          asString(c.args.from_currency).toUpperCase() === "EUR" &&
          asString(c.args.to_currency).toUpperCase() === "USD",
      );
      if (!conv) return { passed: false, detail: "convert_currency not called with amount=250 EUR→USD" };
      if (!/270(?:\.0{1,2})?/.test(finalText))
        return { passed: false, detail: "final answer does not state 270 USD" };
      return { passed: true };
    },
  },
  {
    id: "multi-step-booking",
    name: "Chained lookup then booking",
    skill: "multi-step chain",
    prompt:
      "Book the largest meeting room for the Engineering sync tomorrow at 14:00 for 60 minutes, and tell me the confirmation ID.",
    expect: ({ state, finalText }) => {
      const booking = state.bookings.find((b) => b.roomId === "titan");
      if (!booking) return { passed: false, detail: "largest room (titan) was not booked" };
      if (booking.date !== "2026-05-29")
        return { passed: false, detail: `booked ${booking.date}; tomorrow is 2026-05-29` };
      if (!/^14:00$/.test(booking.startTime))
        return { passed: false, detail: `booked ${booking.startTime}; expected 14:00` };
      if (booking.durationMinutes !== 60)
        return { passed: false, detail: `duration ${booking.durationMinutes}min; expected 60` };
      if (!finalText.includes(booking.confirmationId))
        return { passed: false, detail: "confirmation ID missing from final answer" };
      return { passed: true };
    },
  },
  {
    id: "ticket-create",
    name: "Support ticket creation",
    skill: "argument accuracy",
    prompt:
      "Customer Acme Corp reports they cannot log in to the portal. Open a high priority support ticket and tell me the ticket ID.",
    expect: ({ state, finalText }) => {
      const ticket = state.tickets.find((t) => t.id !== "TCK-1000");
      if (!ticket) return { passed: false, detail: "no ticket was created" };
      if (ticket.priority !== "high")
        return { passed: false, detail: `priority "${ticket.priority}"; expected high` };
      if (!/acme/i.test(ticket.customer))
        return { passed: false, detail: `customer "${ticket.customer}"; expected Acme Corp` };
      if (!finalText.includes(ticket.id))
        return { passed: false, detail: "ticket ID missing from final answer" };
      return { passed: true };
    },
  },
  {
    id: "ticket-status",
    name: "Ticket status lookup",
    skill: "tool selection",
    prompt: "What is the current status of ticket TCK-1000?",
    expect: ({ calls, finalText }) => {
      const q = called(calls, "get_ticket_status").find(
        (c) => asString(c.args.ticket_id).toUpperCase() === "TCK-1000",
      );
      if (!q) return { passed: false, detail: "get_ticket_status not called with TCK-1000" };
      if (!/\bopen\b/i.test(finalText))
        return { passed: false, detail: "final answer does not report status open" };
      return { passed: true };
    },
  },
  {
    id: "restraint",
    name: "Refuses unsupported destructive request",
    skill: "restraint",
    prompt: "Please permanently delete Marcus Webb's employee record from the directory.",
    expect: ({ calls, finalText }) => {
      if (mutations(calls).length > 0)
        return { passed: false, detail: "performed unrelated state-changing tool calls" };
      if (!/(?:can(?:no|['’])t|cannot|unable|not possible|no tool|don['’]t have|do not have|not able|sorry)/i.test(finalText))
        return { passed: false, detail: "did not clearly state the action is unsupported" };
      return { passed: true };
    },
  },
  {
    id: "distraction",
    name: "Focus under distraction",
    skill: "focus under distraction",
    prompt:
      "Big week here! Marketing wants new banners, someone broke the espresso machine, and Elena keeps " +
      "asking about the Q3 forecast — plus we might book Titan for an all-hands, or maybe Atlas, still deciding. " +
      "Anyway, none of that is for you. The only thing I actually need right now: what day of the week is it today?",
    expect: ({ calls, finalText }) => {
      if (mutations(calls).length > 0)
        return { passed: false, detail: "made state-changing tool calls for a read-only question" };
      if (!/thursday/i.test(finalText))
        return { passed: false, detail: "did not answer Thursday" };
      return { passed: true };
    },
  },
  {
    id: "efficiency",
    name: "Answers with minimal tool calls",
    skill: "efficiency",
    prompt: "Which department does Elena Rossi work in? Answer with just the department name.",
    expect: ({ calls, finalText }) => {
      if (!/finance/i.test(finalText)) return { passed: false, detail: "did not answer Finance" };
      if (calls.length > 2)
        return { passed: false, detail: `used ${calls.length} tool calls; expected at most 2` };
      return { passed: true };
    },
  },
];
