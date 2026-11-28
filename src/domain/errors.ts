export type AppErrorCode =
  | "NETWORK"
  | "AUTH_REQUIRED"
  | "SUBSCRIPTION_REQUIRED"
  | "TOKEN_EXPIRED"
  | "MUSICKIT_INIT_FAILED"
  | "PLAYBACK_FAILED"
  | "CONTENT_UNAVAILABLE"
  | "RATE_LIMITED"
  | "UPDATER_FAILED"
  | "UNKNOWN";

export interface PlayerError {
  code: AppErrorCode;
  message: string;
}
