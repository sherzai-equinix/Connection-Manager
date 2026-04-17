-- 016: Live User Presence / Aktive Benutzer
-- Zeigt welche Benutzer gerade online sind und woran sie arbeiten.
-- Kann sauber zurueckgenommen werden: DROP TABLE IF EXISTS user_presence;

CREATE TABLE IF NOT EXISTS user_presence (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL,
    username        VARCHAR(100) NOT NULL,
    login_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    current_page    VARCHAR(100),
    last_action     VARCHAR(200),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_presence_user UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS ix_presence_active ON user_presence (is_active, last_seen);
