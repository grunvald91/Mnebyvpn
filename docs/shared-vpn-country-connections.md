# Shared Germany + Finland VPN connection admission (V1, disabled)

Purchase creates ONE canonical VPN entitlement and ONE HTTPS subscription URL.
The same response may contain one independently verified German profile
`MNEBYVPN Германия` and one independently acknowledged Finnish profile
`MNEBYVPN Финляндия`. No second checkout, expiry clock or device_limit is created.

**Capacity is shared across countries**, not doubled. At limit 3, DE=1+FI=2
means DENY_LIMIT for the next connection from either region. Existing accepted
sessions continue during their valid lease. Release/expiry frees capacity.
The value is read from the immutable `order_terms.device_limit`, not mutable
`billing_plans`. A region failover must release the old session or wait
for its short lease to expire. One device connecting to two servers at the
same time counts as TWO connections.

Migration 0147 is an offline **controller-side primitive**, not live usage
enforcement: it installs no country identities, leaves its release flag false,
gives EXECUTE only to NOLOGIN `mnebyvpn_connection_admission`, and doesn't
touch existing VLESS/AWG, subscribers, DNS or payment. Only signed RU188
observer/worker credentials may later be allowed to call claim/refresh/release.

Before enabling this limit, both DE VLESS and FI AWG must verify signed node
identities, bind one unforgeable connection_id per session, call the common
serialized claim BEFORE allowing a new session, heartbeat while live, release
on disconnect, and fail closed locally on expired lease or lost control-plane.
A successful SQL receipt alone is NOT proof of node enforcement. The rollout
must account for preexisting unmetered live sessions, drain/migrate them,
test 1/2/3/4 simultaneous joins, 2-country races, controller outage, expiry,
refund, restarts, copied client keys, and independent mobile E2E. The scheme
cannot prove uniqueness of physical devices from a copied peer secret.

The Telegram MTProxy and personal DNS products have their own credentials
and metering and are NOT included in this VPN connection cap.
