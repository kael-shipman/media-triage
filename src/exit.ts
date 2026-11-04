/** The process's exit statuses. */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  /** The daemon upgraded itself and wants to be started again (EX_TEMPFAIL; the systemd unit restarts on it). */
  upgraded: 75,
} as const;
