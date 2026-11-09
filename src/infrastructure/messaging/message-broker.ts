export interface MessageBroker {
  publish(queue: string, message: unknown): Promise<void>;
}

export type MessageDisposition = 'ack' | 'retry' | 'reject';

export type MessageHandler = (
  message: unknown
) => Promise<MessageDisposition>;

export interface ManagedMessageBroker extends MessageBroker {
  consume(queue: string, handler: MessageHandler): Promise<void>;
  close(): Promise<void>;
}
