-- An import keeps the same Google time window across pages. Only a complete
-- pass may remove old imports that the current pass did not see.
ALTER TABLE google_calendar_connections ADD COLUMN import_run_id TEXT;
ALTER TABLE google_calendar_connections ADD COLUMN import_window_start INTEGER;
ALTER TABLE google_calendar_connections ADD COLUMN import_page_token TEXT;
ALTER TABLE personal_events ADD COLUMN google_seen_run TEXT;

CREATE TRIGGER reset_google_import_cursor AFTER UPDATE OF read_calendar_id, refresh_token_ciphertext
ON google_calendar_connections WHEN OLD.read_calendar_id IS NOT NEW.read_calendar_id
  OR OLD.refresh_token_ciphertext IS NOT NEW.refresh_token_ciphertext
BEGIN
  UPDATE google_calendar_connections SET import_run_id = NULL, import_window_start = NULL, import_page_token = NULL
  WHERE user_id = NEW.user_id;
END;
