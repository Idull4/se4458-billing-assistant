-- Billing database schema (PostgreSQL 14+)
-- Applied automatically by billing-api on startup (idempotent).

CREATE TABLE IF NOT EXISTS subscribers (
    id             SERIAL PRIMARY KEY,
    subscriber_no  VARCHAR(20)  NOT NULL UNIQUE,
    name           VARCHAR(100) NOT NULL,
    password_hash  VARCHAR(100) NOT NULL,
    role           VARCHAR(20)  NOT NULL DEFAULT 'subscriber'
                   CHECK (role IN ('subscriber', 'admin')),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- One row per Add Usage call: PHONE = 10 minutes, INTERNET = 1 MB.
CREATE TABLE IF NOT EXISTS usage_events (
    id             BIGSERIAL PRIMARY KEY,
    subscriber_id  INTEGER     NOT NULL REFERENCES subscribers(id),
    year           SMALLINT    NOT NULL CHECK (year BETWEEN 2000 AND 2100),
    month          SMALLINT    NOT NULL CHECK (month BETWEEN 1 AND 12),
    usage_type     VARCHAR(10) NOT NULL CHECK (usage_type IN ('PHONE', 'INTERNET')),
    quantity       INTEGER     NOT NULL CHECK (quantity > 0),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_usage_period ON usage_events (subscriber_id, year, month);

-- Stored bill per subscriber and billing period (created/updated by Calculate Bill).
CREATE TABLE IF NOT EXISTS bills (
    id               SERIAL PRIMARY KEY,
    subscriber_id    INTEGER       NOT NULL REFERENCES subscribers(id),
    year             SMALLINT      NOT NULL,
    month            SMALLINT      NOT NULL,
    phone_minutes    INTEGER       NOT NULL,
    internet_mb      INTEGER       NOT NULL,
    phone_charge     NUMERIC(10,2) NOT NULL,
    internet_charge  NUMERIC(10,2) NOT NULL,
    total            NUMERIC(10,2) NOT NULL,
    paid_amount      NUMERIC(10,2) NOT NULL DEFAULT 0,
    status           VARCHAR(20)   NOT NULL CHECK (status IN ('UNPAID', 'PARTIALLY_PAID', 'PAID')),
    due_date         DATE          NOT NULL,
    calculated_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    UNIQUE (subscriber_id, year, month)
);

-- Simulated payments. transaction_id is globally unique (duplicate protection).
CREATE TABLE IF NOT EXISTS payments (
    id              SERIAL PRIMARY KEY,
    bill_id         INTEGER       NOT NULL REFERENCES bills(id),
    transaction_id  VARCHAR(64)   NOT NULL UNIQUE,
    amount          NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);
