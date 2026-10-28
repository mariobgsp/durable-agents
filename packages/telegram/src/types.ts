/** The parts of the Bot API this app actually reads. Everything else is ignored. */
export type TgUser = { id: number; is_bot?: boolean; first_name?: string; username?: string };

export type TgChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  is_forum?: boolean;
};

export type TgPhotoSize = { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number };

export type TgDocument = { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number };

export type TgMessage = {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
  media_group_id?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
  reply_to_message?: { message_id: number };
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
  new_chat_members?: TgUser[];
  left_chat_member?: TgUser;
};

export type TgCallbackQuery = {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
};

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
  my_chat_member?: {
    chat: TgChat;
    from: TgUser;
    new_chat_member: { status: string; user: TgUser };
  };
};

export type TgResponse<T> = { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number; migrate_to_chat_id?: number } };

export type TgChatMember = { status: string; user: TgUser };

export type TgMe = { id: number; is_bot: boolean; first_name: string; username?: string };

export type CommandScope =
  | { type: "default" }
  | { type: "all_private_chats" }
  | { type: "all_group_chats" }
  | { type: "all_chat_administrators" };

export type BotCommand = { command: string; description: string };
