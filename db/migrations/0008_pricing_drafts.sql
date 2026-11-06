-- Draft tariff slots only; actual RUB / Stars prices require owner configuration.
-- Duration is fixed seconds. 60/90 days are NOT calendar-month billing.
BEGIN;
CREATE TABLE pricing_drafts (
 product text NOT NULL CHECK(product IN ('vpn','smart_dns','bundle')),
 duration_seconds bigint NOT NULL CHECK(duration_seconds>0),
 title text NOT NULL,
 rub_minor bigint CHECK(rub_minor>0),
 stars bigint CHECK(stars>0),
 dns_quota_bytes bigint CHECK(dns_quota_bytes>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(product,duration_seconds)
);
INSERT INTO pricing_drafts(product,duration_seconds,title)
 VALUES
 ('vpn',15*86400,'VPN · 15 дней'),
 ('vpn',30*86400,'VPN · 30 дней'),
 ('vpn',60*86400,'VPN · 60 дней'),
 ('vpn',90*86400,'VPN · 90 дней'),
 ('smart_dns',15*86400,'Smart DNS · 15 дней'),
 ('smart_dns',30*86400,'Smart DNS · 30 дней'),
 ('smart_dns',60*86400,'Smart DNS · 60 дней'),
 ('smart_dns',90*86400,'Smart DNS · 90 дней');
REVOKE ALL ON pricing_drafts FROM PUBLIC;
COMMIT;
