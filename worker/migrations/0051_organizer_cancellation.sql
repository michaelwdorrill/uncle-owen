-- Existing cancellations retain the wording they received when first processed.
ALTER TABLE events ADD COLUMN cancelled_by_organizer INTEGER NOT NULL DEFAULT 0
  CHECK (cancelled_by_organizer IN (0, 1));
