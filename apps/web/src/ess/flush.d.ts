import type { OutboxClockEvent } from "./db.js";

export function sendOutboxEvent(event: OutboxClockEvent): Promise<void>;
