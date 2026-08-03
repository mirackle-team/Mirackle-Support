CREATE TABLE IF NOT EXISTS tickets (
  ticket        TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  priority      TEXT,
  category      TEXT,
  warranty      INTEGER DEFAULT 0,
  company       TEXT,
  invoice       TEXT,
  contact       TEXT,
  email         TEXT,
  phone         TEXT,
  purchase_date TEXT,
  site          TEXT,
  model         TEXT,
  lang          TEXT,
  report        TEXT,
  payload       TEXT,
  files         TEXT,
  token         TEXT,
  status        TEXT DEFAULT 'new',
  resolution    TEXT,
  part_used     TEXT,
  closed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_created  ON tickets(created_at);
CREATE INDEX IF NOT EXISTS idx_company  ON tickets(company);
CREATE INDEX IF NOT EXISTS idx_invoice  ON tickets(invoice);
CREATE INDEX IF NOT EXISTS idx_model    ON tickets(model);
CREATE INDEX IF NOT EXISTS idx_category ON tickets(category);
CREATE INDEX IF NOT EXISTS idx_warranty ON tickets(warranty);
