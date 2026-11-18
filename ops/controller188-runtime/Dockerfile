# Separate central-controller Node 22 + SSH execution image.
# BASE_IMAGE MUST be locally present immutable sha256:<64> identifier
# of the reviewed MNEBYVPN web runtime. No mutable tags.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
WORKDIR /srv/mnebyvpn

# Existing reviewed RU188 web image derives from node:22.16.0-alpine.
# The only additional package is the OpenSSH client.
# No signing keys, DB URLs or SSH credentials are available at build time.
RUN test "$(node -v)" = "v22.16.0" && \
    test -f /etc/alpine-release && \
    apk add --no-cache openssh-client && \
    test -x /usr/bin/ssh && \
    node -e 'require("pg");' && \
    rm -rf /srv/mnebyvpn/apps /srv/mnebyvpn/packages /srv/mnebyvpn/ops

# No public app, public bot, site code, running config or secrets in image.
COPY --chown=0:0 packages/provisioning/src /srv/mnebyvpn/packages/provisioning/src
COPY --chown=0:0 apps/service/src/fi-enrollment-controller.ts /srv/mnebyvpn/apps/service/src/
COPY --chown=0:0 apps/service/src/awg-controller-delivery-worker.ts /srv/mnebyvpn/apps/service/src/
COPY --chown=0:0 ops/controller188-runtime/probe.mjs /srv/mnebyvpn/ops/controller188-runtime/probe.mjs

# No network listener or client entitlement side effects.
ENTRYPOINT ["node", "--experimental-strip-types", "/srv/mnebyvpn/ops/controller188-runtime/probe.mjs"]
