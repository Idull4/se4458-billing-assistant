# Azure deployment

Target layout (Azure for Students subscription):

| Component | Azure service | Exposure |
|---|---|---|
| PostgreSQL 16 | Azure Database for PostgreSQL Flexible Server (Burstable B1ms) | Public endpoint, Azure services only, SSL required |
| Billing API | Azure Container Apps (`billing-api`) | HTTPS ingress, but **only requests carrying the gateway key** (`X-Gateway-Key`, added by Kong) are accepted; direct calls get 403 |
| API Gateway | Azure Container Apps (`gateway`, Kong 3.9, same routes as `gateway/kong.yml`) | External HTTPS ingress |
| MCP server | Azure Container Apps (`mcp-server`, Streamable HTTP) | External HTTPS ingress (separate from the gateway) |
| Container images | Azure Container Registry (built locally with Docker, then pushed) | – |
| AI Agent | Runs locally (CLI), pointed at the cloud gateway and MCP URLs | – |

Commands are for Windows `cmd`. Azure for Students only allows some regions (`az policy assignment list --query "[].parameters"`); this deployment uses `polandcentral`, and every create command passes `--location` explicitly. Settings and generated secrets live in `scripts/azure-env.cmd` and
`gateway/kong.cloud.yml` (both git-ignored). To recreate them: copy `gateway/kong.yml` to `gateway/kong.cloud.yml`,
set the service `url` to `https://billing-api.<env-domain>`, the `jwt_secrets.secret` to a new random value (same value
in `JWT_SECRET`), and add the `request-transformer` plugin with a random `X-Gateway-Key` (same value in `GATEWAY_SHARED_SECRET`).

## 1. Sign in and prepare

```cmd
az login
call scripts\azure-env.cmd
az extension add --name containerapp --upgrade
az provider register --namespace Microsoft.App
az provider register --namespace Microsoft.OperationalInsights
az provider register --namespace Microsoft.ContainerRegistry
az provider register --namespace Microsoft.DBforPostgreSQL
az group create --name %RG% --location %LOC%
```

## 2. Database

```cmd
az postgres flexible-server create --resource-group %RG% --name %PG% --location %LOC% --tier Burstable --sku-name Standard_B1ms --storage-size 32 --version 16 --admin-user %PGUSER% --admin-password %PGPASS% --public-access 0.0.0.0 --yes
az postgres flexible-server db create --resource-group %RG% --server-name %PG% --name billing
```

`--public-access 0.0.0.0` allows connections from Azure services only. The schema and demo data are created by the
Billing API on its first start (`SEED_ON_START=true`).

## 3. Container images

ACR Tasks (`az acr build`, cloud builds) are not permitted on Azure for Students subscriptions, so the images are
built locally with Docker and pushed. `docker compose up --build` already builds the API and MCP images.

```cmd
az acr create --resource-group %RG% --name %ACR% --sku Basic --admin-enabled true --location %LOC%
az acr login --name %ACR%
docker compose build billing-api mcp-server
docker tag se4458-billing-assistant-billing-api %ACR%.azurecr.io/billing-api:v1
docker push %ACR%.azurecr.io/billing-api:v1
docker tag se4458-billing-assistant-mcp-server %ACR%.azurecr.io/mcp-server:v1
docker push %ACR%.azurecr.io/mcp-server:v1
docker build -t %ACR%.azurecr.io/gateway:v1 -f gateway/Dockerfile .
docker push %ACR%.azurecr.io/gateway:v1
```

## 4. Container Apps

```cmd
az containerapp env create --name %ENVNAME% --resource-group %RG% --location %LOC%

az containerapp create --name billing-api --resource-group %RG% --environment %ENVNAME% --image %ACR%.azurecr.io/billing-api:v2 --registry-server %ACR%.azurecr.io --target-port 3000 --ingress external --min-replicas 1 --secrets "db-url=%DATABASE_URL%" "jwt-secret=%JWT_SECRET%" "gateway-key=%GATEWAY_SHARED_SECRET%" --env-vars DATABASE_URL=secretref:db-url JWT_SECRET=secretref:jwt-secret GATEWAY_SHARED_SECRET=secretref:gateway-key SEED_ON_START=true

az containerapp create --name mcp-server --resource-group %RG% --environment %ENVNAME% --image %ACR%.azurecr.io/mcp-server:v1 --registry-server %ACR%.azurecr.io --target-port 3001 --ingress external --min-replicas 1

az containerapp create --name gateway --resource-group %RG% --environment %ENVNAME% --image %ACR%.azurecr.io/gateway:v5 --registry-server %ACR%.azurecr.io --target-port 8000 --ingress external --min-replicas 1
```

**Why the Billing API is not internal-only.** Azure for Students creates an *Express* Container Apps environment.
There, Kong could not reach an internal-only app: the short name did not resolve in Kong's DNS client, the
`.internal` FQDN was not routed, and `--allow-insecure` is not supported. The API therefore gets an HTTPS ingress
and enforces gateway-only access itself. `gateway/kong.cloud.yml` points the service at
`https://billing-api.<env-domain>` and uses the `request-transformer` plugin to remove any client-supplied
`X-Gateway-Key` and add the real one. The API (`GATEWAY_SHARED_SECRET` set) rejects requests without it with
`403 GATEWAY_REQUIRED`.

## 5. URLs and checks

```cmd
az containerapp show --name gateway --resource-group %RG% --query properties.configuration.ingress.fqdn -o tsv
az containerapp show --name mcp-server --resource-group %RG% --query properties.configuration.ingress.fqdn -o tsv
```

- Swagger: `https://<gateway-fqdn>/api/v1/docs`
- Public route: `https://<gateway-fqdn>/api/v1/bills?subscriberNo=5551001&month=10&year=2026`
- Protected route without a token → `401` from Kong: `https://<gateway-fqdn>/api/v1/bills/detailed?month=10&year=2026`
- Direct call to the API, bypassing the gateway → `403 GATEWAY_REQUIRED`: `https://billing-api.<env-domain>/api/v1/bills?subscriberNo=5551001&month=10&year=2026`
- Agent against the cloud: in `.env` set `GATEWAY_URL=https://<gateway-fqdn>` and `MCP_URL=https://<mcp-fqdn>/mcp`, then `npm run agent`.

Logs: `az containerapp logs show --name billing-api --resource-group %RG% --follow`

## 6. Clean up (stops all costs)

```cmd
az group delete --name %RG% --yes --no-wait
```
