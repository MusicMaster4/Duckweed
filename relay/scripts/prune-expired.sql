-- Apply the existing seven-day retention before a migration needs extra space.
-- Pairing credentials and all unexpired deliveries remain intact.
DELETE FROM messages WHERE expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000;
DELETE FROM commands WHERE expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000;
DELETE FROM pairing_rate_limits WHERE window_start < CAST(strftime('%s', 'now') AS INTEGER) / 60 - 2880;
SELECT COUNT(*) AS pending_messages, SUM(length(payload_ciphertext)) AS ciphertext_bytes FROM messages;
