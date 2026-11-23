# Kong gateway image for Azure Container Apps (build context: repository root).
# gateway/kong.cloud.yml = gateway/kong.yml with the cloud upstream (http://billing-api) and the cloud JWT secret.
FROM kong:3.9
COPY gateway/kong.cloud.yml /kong/kong.yml
ENV KONG_DATABASE=off \
    KONG_DECLARATIVE_CONFIG=/kong/kong.yml \
    KONG_PROXY_LISTEN=0.0.0.0:8000 \
    KONG_ADMIN_LISTEN=off \
    KONG_PROXY_ACCESS_LOG=/dev/stdout \
    KONG_PROXY_ERROR_LOG=/dev/stderr \
    KONG_TRUSTED_IPS=0.0.0.0/0,::/0 \
    KONG_REAL_IP_HEADER=X-Forwarded-For
EXPOSE 8000
