export interface MessageBroker {
  publish(queue: string, message: unknown): Promise<void>;
}

export interface ManagedMessageBroker extends MessageBroker {
  close(): Promise<void>;
}
