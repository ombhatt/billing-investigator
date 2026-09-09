import { z } from "zod";
import { listAccountEvents } from "../repositories/eventRepository.js";
import { createTool, NotFound } from "./createTool.js";
import { accountIdSchema, isoTimestampSchema } from "./validators.js";

export const TOOL_NAME = "get_account_events";

const EVENT_TYPES = [
  "deployment",
  "configuration_change",
  "subscription_change",
  "entitlement_change",
  "credit"
] as const;

export const inputSchema = z.object({
  accountId: accountIdSchema,
  startTimestamp: isoTimestampSchema.describe("Inclusive ISO-8601 start"),
  endTimestamp: isoTimestampSchema.describe("Inclusive ISO-8601 end"),
  eventTypes: z
    .array(z.enum(EVENT_TYPES))
    .optional()
    .describe("Restrict to these event types")
});

export const getAccountEvents = createTool(
  TOOL_NAME,
  inputSchema,
  async ({ accountId, startTimestamp, endTimestamp, eventTypes }, deps) => {
    if (Date.parse(startTimestamp) > Date.parse(endTimestamp)) {
      throw new NotFound(
        "INVALID_DATE_RANGE",
        `startTimestamp ${startTimestamp} is after endTimestamp ${endTimestamp}.`
      );
    }

    const all = await listAccountEvents(
      deps.db,
      accountId,
      startTimestamp,
      endTimestamp
    );
    // Filtered here rather than as a dynamic SQL IN list. PRD §17.
    const events =
      eventTypes && eventTypes.length > 0
        ? all.filter((e) => eventTypes.includes(e.eventType as typeof EVENT_TYPES[number]))
        : all;

    return {
      data: {
        startTimestamp,
        endTimestamp,
        eventTypes: eventTypes ?? null,
        events,
        countsByType: Object.fromEntries(
          EVENT_TYPES.map((type) => [
            type,
            events.filter((e) => e.eventType === type).length
          ])
        )
      },
      sourceRecordIds: events.map((e) => `account_events:${e.eventId}`),
      evidence:
        events.length === 0
          ? [
              {
                label: "Account events in window",
                value: "None found",
                source: TOOL_NAME,
                recordIds: [],
                period: `${startTimestamp} to ${endTimestamp}`,
                status: "not_found" as const
              }
            ]
          : events.map((event) => ({
              label: `${event.eventType.replace(/_/g, " ")}: ${event.name}`,
              value: `${event.eventId} at ${event.occurredAt}${event.zoneId ? ` on ${event.zoneId}` : ""}`,
              source: TOOL_NAME,
              recordIds: [`account_events:${event.eventId}`],
              period: event.occurredAt,
              // Proximity in time only. PRD §12.8 forbids implying cause here.
              status: "correlated" as const
            })),
      dataLimitations: [
        "Events are reported by time only; this does not establish that an event caused a usage change."
      ]
    };
  }
);
