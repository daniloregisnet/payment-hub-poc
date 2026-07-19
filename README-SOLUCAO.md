# Solução: Distributed Tracing (Jaeger) no Payment Hub

## Problema

O Payment Hub é composto por 4 serviços encadeados (`payment-api` → `payment-cache` →
`payment-db`, mais `payment-queue` em paralelo) rodando num cluster Kubernetes com **Istio em
Ambient Mode** (namespace `payment-hub`). Até esta mudança, não havia como visualizar uma
requisição de ponta a ponta atravessando esses hops — cada chamada HTTP feita pelos próprios
serviços Go (`http.Get`) não repassava nenhum header de correlação, então mesmo com tracing
habilitado no mesh, cada hop apareceria no Jaeger como um **trace órfão** desconectado dos demais.

## O que foi implementado

A solução tem três partes:

1. **Addon Jaeger** (Istio 1.30.2, addon `release-1.30`) aplicado em `istio-system`. É o Jaeger
   2.x (baseado em OpenTelemetry Collector), que expõe simultaneamente as APIs OTLP, Jaeger
   nativo e Zipkin no mesmo processo.
2. **Tracing habilitado no mesh** via um `extensionProvider` Zipkin (`jaeger-zipkin`) adicionado
   ao `ConfigMap istio`, mais um recurso `Telemetry` mesh-wide (`istio-system`) apontando para
   esse provider com `randomSamplingPercentage: 100.0` (100% só para fins de demonstração — em
   produção seria um percentual bem menor).
3. **Propagação manual dos headers de trace** nos serviços Go `payment-api` e `payment-cache`,
   que fazem chamadas de saída (`payment-db` e `payment-queue` não fazem, não precisaram de
   alteração).

### Por que editar o ConfigMap direto, e não `istioctl install`

Rodar `istioctl install` de novo neste ambiente é arriscado (pode reconfigurar/podar componentes
já instalados por engano). Para evitar esse risco, o provider de tracing foi adicionado editando
diretamente o campo `data.mesh` do `ConfigMap istio` em `istio-system` — istiod observa o
ConfigMap e recarrega sozinho, sem precisar reinstalar nada. O estado anterior do ConfigMap foi
salvo em `istio-configmap-backup.yaml` antes da alteração, para rollback se necessário.

### Por que propagação manual de headers, e não um SDK de tracing

Os serviços Go são mocks simples (ver `setup-services.sh` / `payment-hub-services/*/main.go`) sem
nenhuma dependência externa. Em vez de adicionar um SDK OpenTelemetry ao projeto, a propagação foi
feita copiando explicitamente os headers de trace do request de entrada para o request de saída
(função `forward`, em `api/main.go` e `cache/main.go`):

```go
var traceHeaders = []string{
    "x-request-id", "traceparent", "tracestate",
    "x-b3-traceid", "x-b3-spanid", "x-b3-parentspanid", "x-b3-sampled", "x-b3-flags", "b3",
    "x-ot-span-context", "x-cloud-trace-context", "grpc-trace-bin",
}
```

Sem isso, o Envoy do waypoint/ingressgateway não consegue juntar os spans de cada serviço num
único trace — cada hop vira uma árvore órfã no Jaeger, mesmo com o tracing habilitado no mesh.
`checkFraudHandler` (api) e `getCardLimitHandler` (cache) passaram a usar `forward(r, url)` em vez
de `http.Get(url)`.

## Nuance importante: nomes de serviço no Jaeger (Ambient Mode)

Diferente do modo Sidecar — onde cada pod tem seu próprio Envoy e apareceria como um serviço
Jaeger separado (`payment-api`, `payment-cache`, `payment-db`) — em **Ambient Mode só o
ingressgateway e o waypoint compartilhado do namespace geram spans**
(`istio-ingressgateway.istio-system` e `waypoint.payment-hub`). Os apps Go não têm proxy embutido,
então não aparecem como "serviço" próprio no Jaeger — eles aparecem como o **destino**
(`operationName`) dos spans gerados pelo waypoint.

## Arquivos criados/modificados

| Arquivo | O que é |
|---|---|
| `istio-configmap-backup.yaml` | Backup do `ConfigMap istio` **antes** da alteração (rollback) |
| `istio-configmap-tracing-patch.yaml` | `ConfigMap istio` com `extensionProviders: [jaeger-zipkin]` adicionado (aplicado) |
| `telemetry-tracing.yaml` | Recurso `Telemetry` (namespace `istio-system`, mesh-wide) ligando o provider `jaeger-zipkin` com sampling 100% |
| `payment-hub-services/api/main.go` | `checkFraudHandler` usa `forward(r, url)`; helper `forward` + `traceHeaders` |
| `payment-hub-services/cache/main.go` | Mesma mudança em `getCardLimitHandler` |
| `payment-hub-services/db/main.go`, `payment-hub-services/queue/main.go` | **Não alterados** — não fazem chamada de saída |

Nenhuma `AuthorizationPolicy`, `PeerAuthentication`, `DestinationRule` ou `VirtualService`
existente (`istio/*.yaml`) foi tocada. Nenhuma dependência Go externa foi adicionada.

## Desvios do plano original

- **Provider escolhido**: Zipkin (`jaeger-zipkin`), não OpenTelemetry — mais maduro no tracer
  nativo do Envoy/Istio 1.30. O addon Jaeger 2.x aceita os dois simultaneamente, então trocar para
  OTLP no futuro é só mudar o `extensionProviders` no ConfigMap.
- **Porta do ingressgateway**: este ambiente usa port-forward na **8090**, não 8080 (ocupada por
  outro processo nesta máquina).
- A API REST do Jaeger fica sob `/jaeger/api/...` (não `/api/...` direto) — particularidade do
  Jaeger 2.x usado neste addon (`jaeger_query.base_path: /jaeger`).

Para o passo a passo de como validar tudo isso, veja [README-TESTE.md](README-TESTE.md).
