export type ObservationEventType = "search" | "open" | "filter";

export interface ObservationEvent {
  id: string;
  timestamp: string;
  type: ObservationEventType;
  entity: "company" | "contact";
  target?: string;
  value?: string;
  metadata?: Record<string, string>;
}

export class TrainingSession {
  private readonly events: ObservationEvent[] = [];

  record(event: Omit<ObservationEvent, "id" | "timestamp">): ObservationEvent {
    const captured: ObservationEvent = {
      ...event,
      id: `event-${this.events.length + 1}`,
      timestamp: new Date().toISOString()
    };
    this.events.push(captured);
    return captured;
  }

  list(): readonly ObservationEvent[] {
    return this.events;
  }

  clear(): void {
    this.events.splice(0, this.events.length);
  }
}
