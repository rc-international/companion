/** Common fields sent by Claude Code on every hook event */
export interface HookCommonInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  agent_id?: string;
  agent_type?: string;
}

export interface SessionStartInput extends HookCommonInput {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact";
  model: string;
}

export interface SessionEndInput extends HookCommonInput {
  hook_event_name: "SessionEnd";
  reason:
    | "clear"
    | "logout"
    | "prompt_input_exit"
    | "bypass_permissions_disabled"
    | "other";
}

export interface PreToolUseInput extends HookCommonInput {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

export interface PostToolUseInput extends HookCommonInput {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  tool_use_id: string;
}

export interface StopInput extends HookCommonInput {
  hook_event_name: "Stop";
  stop_hook_active: boolean;
  last_assistant_message: string;
}

/** Union of all hook inputs */
export type HookInput =
  | SessionStartInput
  | SessionEndInput
  | PreToolUseInput
  | PostToolUseInput
  | StopInput;

/** Standard hook response — mirrors Claude Code's JSON output schema */
export interface HookResponse {
  /** If false, Claude stops processing entirely */
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  /** Top-level decision for PostToolUse, Stop, etc. */
  decision?: "block";
  reason?: string;
  /** Event-specific output */
  hookSpecificOutput?: Record<string, unknown>;
}

/** SessionStart-specific response */
export interface SessionStartResponse extends HookResponse {
  hookSpecificOutput?: {
    hookEventName: "SessionStart";
    additionalContext?: string;
  };
}
