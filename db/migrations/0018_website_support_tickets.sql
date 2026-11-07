-- Support tickets for guest website visitors.
-- Operator answers from the same MNEBYVPN Telegram bot; the browser checks
-- the ticket using an opaque HttpOnly cookie, not a guessable ticket UUID.
CREATE TABLE IF NOT EXISTS website_support_tickets (
  id uuid PRIMARY KEY,
  token_sha256 char(64) NOT NULL,
  contact text NOT NULL,
  question text NOT NULL,
  delivery_state text NOT NULL DEFAULT 'PENDING'
    CHECK (delivery_state IN ('PENDING','DELIVERED','FAILED')),
  answer text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  answered_at timestamptz,
  CHECK (char_length(contact) BETWEEN 3 AND 120),
  CHECK (char_length(question) BETWEEN 10 AND 1500),
  CHECK (answer IS NULL OR char_length(answer) BETWEEN 1 AND 1500)
);
CREATE INDEX IF NOT EXISTS website_support_tickets_created_idx
  ON website_support_tickets(created_at DESC);
