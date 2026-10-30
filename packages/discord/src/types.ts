/** Discord snowflakes are 64-bit ids; they must stay strings in JavaScript. */
export type Snowflake = string;

export type DiscordUser = {
  id: Snowflake;
  username: string;
  global_name?: string | null;
  bot?: boolean;
  avatar?: string | null;
};

export type DiscordAttachment = {
  id: Snowflake;
  filename: string;
  description?: string | null;
  content_type?: string | null;
  size: number;
  url: string;
  proxy_url?: string;
  height?: number | null;
  width?: number | null;
};

export type DiscordGuildMember = DiscordMember;

export type DiscordMember = {
  user?: DiscordUser;
  roles: Snowflake[];
  nick?: string | null;
  joined_at?: string;
  communication_disabled_until?: string | null;
};

export type DiscordMessage = {
  id: Snowflake;
  channel_id: Snowflake;
  guild_id?: Snowflake;
  author: DiscordUser;
  member?: DiscordMember;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  type: number;
  attachments: DiscordAttachment[];
  mentions?: DiscordUser[];
  message_reference?: { message_id?: Snowflake; channel_id?: Snowflake; guild_id?: Snowflake };
  thread?: { id: Snowflake; name?: string; parent_id?: Snowflake };
  webhook_id?: Snowflake;
};

export type DiscordChannel = {
  id: Snowflake;
  type: number;
  guild_id?: Snowflake;
  name?: string;
  parent_id?: Snowflake | null;
  topic?: string | null;
  position?: number;
  thread_metadata?: {
    archived?: boolean;
    auto_archive_duration?: number;
    archive_timestamp?: string;
    locked?: boolean;
  };
  owner_id?: Snowflake;
};

export type DiscordGuild = {
  id: Snowflake;
  name: string;
  icon?: string | null;
  owner_id?: Snowflake;
  permissions?: string;
};

export type DiscordRole = {
  id: Snowflake;
  name: string;
  color?: number;
  position: number;
  permissions?: string;
  managed?: boolean;
};

export type DiscordApplication = {
  id: Snowflake;
  name: string;
  description?: string;
  bot?: DiscordUser;
};

export type DiscordCommandOption = {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  choices?: { name: string; value: string | number }[];
  options?: DiscordCommandOption[];
  autocomplete?: boolean;
};

export type DiscordApplicationCommand = {
  name: string;
  description: string;
  type?: number;
  options?: DiscordCommandOption[];
  default_member_permissions?: string | null;
  dm_permission?: boolean;
  nsfw?: boolean;
};

export type DiscordInteractionData = {
  id?: Snowflake;
  name?: string;
  type?: number;
  custom_id?: string;
  component_type?: number;
  values?: string[];
  options?: { name: string; type: number; value?: string | number | boolean }[];
  target_id?: Snowflake;
};

export type DiscordInteraction = {
  id: Snowflake;
  application_id: Snowflake;
  type: number;
  data?: DiscordInteractionData;
  guild_id?: Snowflake;
  channel_id?: Snowflake;
  member?: DiscordMember;
  user?: DiscordUser;
  token: string;
  message?: DiscordMessage;
  app_permissions?: string;
};

export type GatewayPayload = {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
};

export type ReadyData = {
  v: number;
  user: DiscordUser;
  session_id: string;
  resume_gateway_url: string;
  application?: { id: Snowflake; flags?: number };
  guilds?: DiscordGuild[];
};

export type DiscordErrorBody = {
  code?: number;
  message?: string;
  retry_after?: number;
  global?: boolean;
  errors?: unknown;
};

export type DiscordMessageInput = {
  content?: string;
  components?: unknown[];
  embeds?: unknown[];
  allowed_mentions?: { parse?: string[]; users?: Snowflake[]; roles?: Snowflake[]; replied_user?: boolean };
  message_reference?: { message_id: Snowflake; channel_id?: Snowflake; guild_id?: Snowflake; fail_if_not_exists?: boolean };
  files?: { name: string; data: Uint8Array; mimeType?: string }[];
};

export type DiscordMessageRef = {
  channelId: Snowflake;
  messageId: Snowflake;
  /** Set when the message came from an interaction webhook rather than a channel send. */
  interactionToken?: string;
  applicationId?: Snowflake;
};
