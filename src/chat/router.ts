/**
 * Every connected chat as the one `ChatPort` the core holds. Each call goes to the chat its conversation, message or
 * person names (`kindOf`), so the core never asks which chat a job is in, and a notice can't land in another chat.
 * A call for a chat that isn't connected throws (or rejects): nothing is ever sent to a guess.
 */
import { kindOf, type ChatConnection, type ChatKind } from './connection.ts';
import type { ChatPort } from './port.ts';

export interface ChatRouter {
  /** The port the core holds. */
  chat: ChatPort;
  /** The connection a conversation (or person) ID belongs to, or undefined when that chat isn't connected. */
  connectionOf(id: string): ChatConnection | undefined;
  connections: readonly ChatConnection[];
}

export const routeChats = (connections: readonly ChatConnection[]): ChatRouter => {
  const byKind = new Map<ChatKind, ChatConnection>();
  for (const connection of connections) {
    if (byKind.has(connection.kind)) throw new Error(`Two ${connection.kind} connections: a chat is connected once.`);
    byKind.set(connection.kind, connection);
  }
  const connectionOf = (id: string): ChatConnection | undefined => byKind.get(kindOf(id));
  const port = (id: string): ChatPort => {
    const found = connectionOf(id);
    if (!found) throw new Error(`No ${kindOf(id)} connection for ${id}.`);
    return found.chat;
  };

  const chat: ChatPort = {
    self: (conversation) => port(conversation).self(conversation),
    owner: (conversation) => port(conversation).owner(conversation),
    displayName: async (person) => port(person).displayName(person),
    parse: (conversation, text) => port(conversation).parse(conversation, text),
    read: async (conversation, text, nameOf) => port(conversation).read(conversation, text, nameOf),
    history: async (target, before) => port(target.conversation).history(target, before),
    receiveFiles: async (conversation, files, limit) => port(conversation).receiveFiles(conversation, files, limit),
    permalink: async (ref) => port(ref.conversation).permalink(ref),
    findReply: async (target, intent) => port(target.conversation).findReply(target, intent),
    audience: async (target, requester, options) => port(target.conversation).audience(target, requester, options),
    notice: async (target, notice, inPlaceOf) => port(target.conversation).notice(target, notice, inPlaceOf),
    replaceWithNotice: async (ref, notice, frame) => port(ref.conversation).replaceWithNotice(ref, notice, frame),
    remove: async (ref) => port(ref.conversation).remove(ref),
    acknowledge: async (ref, on) => port(ref.conversation).acknowledge(ref, on),
    setWorking: async (target, on) => port(target.conversation).setWorking(target, on),
  };
  return { chat, connectionOf, connections };
};
