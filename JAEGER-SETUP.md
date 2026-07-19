# Jaeger + propagação de trace headers no Payment Hub

## O que foi feito

1. **Addon Jaeger** (Istio 1.30.2, addon `release-1.30`) aplicado em `istio-system`. É o Jaeger 2.x
   (baseado em OpenTelemetry Collector), que expõe simultaneamente as APIs OTLP, Jaeger nativo e
   Zipkin no mesmo processo — por isso um único addon serve os três estilos de integração.
2. **Tracing habilitado no mesh** via `extensionProviders` (Zipkin) no `ConfigMap istio`, mais um
   recurso `Telemetry` mesh-wide com `randomSamplingPercentage: 100.0`.
3. **Propagação manual de headers de trace** nos mocks Go `payment-api` e `payment-cache`
   (`payment-db` e `payment-queue` não fazem chamadas de saída, não precisavam de alteração).

## Por que ConfigMap direto, não `istioctl install`

Este ambiente já sofreu um incidente nesta mesma sessão (documentado em memória de sessões
anteriores) em que um `istioctl install --set profile=empty` podou istiod/ztunnel/istio-cni por
engano. Para não repetir o risco, o provider de tracing foi adicionado editando diretamente o
`data.mesh` do `ConfigMap istio` em `istio-system` (backup do estado anterior salvo em
`istio-configmap-backup.yaml`) — istiod observa o ConfigMap e recarrega sozinho, sem precisar
reinstalar nada.

## Arquivos criados/modificados

| Arquivo | O que mudou |
|---|---|
| `istio-configmap-backup.yaml` | Backup do `ConfigMap istio` **antes** da alteração (para rollback, se precisar) |
| `istio-configmap-tracing-patch.yaml` | `ConfigMap istio` com `extensionProviders: [jaeger-zipkin]` adicionado (aplicado) |
| `telemetry-tracing.yaml` | Recurso `Telemetry` (namespace `istio-system`, mesh-wide) ligando o provider `jaeger-zipkin` com sampling 100% |
| `payment-hub-services/api/main.go` | `checkFraudHandler` passou a usar `forward(r, url)` em vez de `http.Get(url)`; adicionado helper `forward` + lista `traceHeaders` |
| `payment-hub-services/cache/main.go` | Mesma mudança em `getCardLimitHandler` |
| `payment-hub-services/db/main.go`, `payment-hub-services/queue/main.go` | **Não alterados** — nenhum dos dois faz chamada de saída, não há header pra propagar |

Nenhuma `AuthorizationPolicy`, `PeerAuthentication`, `DestinationRule` ou `VirtualService` existente
foi tocada. Nenhuma dependência Go externa foi adicionada — a propagação é feita copiando headers
manualmente, sem SDK de tracing.

## Comando de port-forward do Jaeger (testado e funcionando)

```bash
kubectl port-forward -n istio-system svc/tracing 16686:80
```

UI em `http://localhost:16686`. A API REST do Jaeger fica sob `/jaeger/api/...` (não
`/api/...` direto) — particularidade do Jaeger 2.x usado neste addon
(`jaeger_query.base_path: /jaeger` no ConfigMap `jaeger`).

## Passo a passo da demo em aula

1. Ter dois port-forwards ativos: o do ingressgateway (`kubectl port-forward -n istio-system
   svc/istio-ingressgateway 8090:80`, porta usada neste ambiente — não 8080) e o do Jaeger acima.
2. Gerar tráfego: `curl -s http://localhost:8090/check-fraud` (uma ou várias vezes — cada clique
   gera um trace novo).
3. Abrir `http://localhost:16686`, selecionar o serviço **`istio-ingressgateway.istio-system`**
   (é aqui que a árvore inteira aparece — ver nota abaixo sobre nomes de serviço em Ambient Mode),
   clicar em "Find Traces".
4. Abrir o trace mais recente — ele mostra 4 spans aninhados sob um único trace ID:
   - `payment-api.../* ` (ingressgateway recebendo a requisição)
   - `router outbound|80||payment-api...; egress` (ingressgateway roteando pro payment-api)
   - `payment-cache.../get-card-limit*` (waypoint interceptando a chamada api → cache)
   - `payment-db.../get-chargeback-history*` (waypoint interceptando a chamada cache → db)
5. Cada span mostra a duração individual — bom gancho pra explicar onde o tempo de uma
   requisição está sendo gasto entre os hops.

### Nota importante sobre nomes de serviço no Jaeger (Ambient Mode)

Diferente do modo Sidecar (onde cada pod tem seu próprio Envoy e apareceria como um serviço
Jaeger separado — `payment-api`, `payment-cache`, `payment-db`), em **Ambient Mode só o
ingressgateway e o waypoint compartilhado do namespace geram spans** (`istio-ingressgateway.istio-
system` e `waypoint.payment-hub`). Os apps Go em si não têm proxy embutido, então não aparecem
como "serviço" próprio no Jaeger — eles aparecem como o **destino** (`operationName`) dos spans
gerados pelo waypoint. É uma boa oportunidade pra explicar na aula a diferença de granularidade de
observabilidade entre Sidecar e Ambient: em Ambient, quem instrumenta o L7 é o proxy compartilhado
do namespace, não um proxy por pod.

## Critério de aceite — confirmado

Trace de amostra (`traceID 645e5747602890f665bc03c16c7f707e`, uma das 20 requisições geradas):

| Span | Serviço (processo) | Duração |
|---|---|---|
| `payment-api.../*` | istio-ingressgateway.istio-system | 4423 µs |
| `router outbound...egress` | istio-ingressgateway.istio-system | 4301 µs |
| `payment-cache.../get-card-limit*` | waypoint.payment-hub | 2456 µs |
| `payment-db.../get-chargeback-history*` | waypoint.payment-hub | 1074 µs |

Um único `trace_id` cobrindo os 4 hops (ingressgateway → payment-api → payment-cache →
payment-db), cada span com relação pai/filho correta e duração própria. **Critério de aceite
atendido** — sem a propagação de headers, cada hop apareceria como um trace órfão separado (o
comportamento observado antes da mudança nos Go mocks).

## Teste de regressão

- `GET /process-payment` → `200` ✅
- `GET /check-fraud?error=true` → `500` ✅ (propagação de status já corrigida em sessão anterior)
- `GET /check-fraud?delay=1000` → atraso de ~1s confirmado (`time_total: 1.02s`) ✅
- Circuit breaker (`DestinationRule` `outlierDetection`) não foi tocado — nenhuma alteração em
  `istio-config.yaml` neste trabalho.

## Desvios do plano original

- **Provider escolhido**: Zipkin (`jaeger-zipkin`), não OpenTelemetry — mais maduro no tracer
  nativo do Envoy/Istio 1.30 e evita depender do envoy OTel tracer (feature mais recente). O addon
  Jaeger 2.x aceita os dois simultaneamente (`receivers: [otlp, jaeger, zipkin]`), então trocar
  para OTLP no futuro é só mudar o `extensionProviders` no ConfigMap.
- **`/check-fraud` já chamava `/get-card-limit`** (não `/check-transaction-history`) — essa
  mudança já tinha sido feita numa sessão anterior deste mesmo projeto (para os cenários de
  Timeout/Circuit Breaker alcançarem o DB). O prompt original presumia o estado antigo; a Tarefa
  3.3 já estava arquiteturalmente satisfeita, só faltava trocar `http.Get` por `forward`.
- **`settlement-queue` já não existe** — foi renomeado para `payment-queue` numa sessão anterior.
  O prompt original usa o nome antigo; usei `payment-queue` em todo lugar, que é o nome real hoje.
  Como nem `payment-db` nem `payment-queue` fazem chamadas de saída, isso não afetou o escopo da
  Tarefa 3.
- **Porta do ingressgateway**: este ambiente usa port-forward na **8090**, não 8080 (8080 está
  ocupada por outro container nesta máquina). Usei 8090 em todos os testes; documentado acima.
- O port-forward antigo do ingressgateway (ativo desde sessões anteriores) caiu quando o
  deployment foi reiniciado (`kubectl rollout restart`, necessário pra pegar o novo provider de
  tracing) — precisei reabri-lo na mesma porta 8090.
