ALTER TABLE checkout_leases ADD COLUMN checkout_url TEXT;
ALTER TABLE haul_checkouts ADD COLUMN outcome TEXT NOT NULL DEFAULT 'pending';
UPDATE haul_checkouts SET outcome='opened' WHERE cart_token<>'';
INSERT INTO schema_migrations(version) VALUES(8);
