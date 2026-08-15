/**
 * Minimal snapshot of Star belldandy-channels Channel contract, decoupled from
 * BelldandyAgent. Source: packages/belldandy-channels/src/types.ts. The Star
 * `Channel` interface is coupled to `BelldandyAgent` (Star's agent runtime);
 * void-channel adapters instead route to the dsh agent loop via a message
 * ingress callback, so the reusable part is the transport/receive/send shape.
 */

export type ChannelLifecycleState = "stopped" | "starting" | "running" | "stopping" | "failed";

export interface VoidChannelInboundMessage {
  chatId: string;
  senderId: string;
  messageId: string;
  text: string;
}

export type VoidChannelMessageHandler = (message: VoidChannelInboundMessage) => void | Promise<void>;

export interface VoidChannelConfig {
  /** Called for each inbound message — the dsh-side ingress hook. */
  onMessage: VoidChannelMessageHandler;
}

export interface VoidChannel {
  readonly name: string;
  readonly isRunning: boolean;
  readonly lifecycleState: ChannelLifecycleState;
  start(options?: { signal?: AbortSignal }): Promise<void>;
  stop(options?: { signal?: AbortSignal }): Promise<void>;
  send(chatId: string, content: string): Promise<boolean>;
}
