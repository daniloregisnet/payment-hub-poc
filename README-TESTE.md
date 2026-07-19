# Como testar: Distributed Tracing (Jaeger) no Payment Hub

Este guia assume o cluster (`docker-desktop`) já com Istio Ambient Mode e o namespace
`payment-hub` no ar. Para entender o que está sendo testado, veja
[README-SOLUCAO.md](README-SOLUCAO.md).

## 0. Pré-requisitos

```bash
kubectl config current-context   # deve ser docker-desktop
kubectl get pods -n payment-hub  # payment-api, payment-cache, payment-db, payment-queue, waypoint — todos Running
kubectl get svc -n istio-system tracing zipkin jaeger-collector  # addon Jaeger já instalado
```

Se `kubectl get svc -n istio-system tracing` não retornar nada, o addon Jaeger ainda não foi
aplicado neste cluster — nesse caso aplique o addon padrão do Istio 1.30.2
(`release-1.30/samples/addons/jaeger.yaml`) antes de continuar.

## 1. Aplicar a configuração de tracing (pular se já aplicada)

```bash
# habilita o extensionProvider "jaeger-zipkin" no mesh
kubectl apply -f istio-configmap-tracing-patch.yaml

# liga esse provider mesh-wide com sampling 100%
kubectl apply -f telemetry-tracing.yaml
```

O ingressgateway só lê a nova config do ConfigMap ao reiniciar:

```bash
kubectl rollout restart deployment/istio-ingressgateway -n istio-system
kubectl rollout status deployment/istio-ingressgateway -n istio-system
```

## 2. Buildar e subir os serviços Go com a propagação de headers

Os binários rodando no cluster precisam ser rebuildados a partir do código atual
(`payment-hub-services/api/main.go` e `cache/main.go`, com a função `forward`). Como o cluster é
o Kubernetes do Docker Desktop, `docker build` já deixa a imagem visível para o cluster (não
precisa `docker push` nem `kind load`):

```bash
cd payment-hub-services/api && docker build -t payment-api:latest . && cd ../..
cd payment-hub-services/cache && docker build -t payment-cache:latest . && cd ../..

kubectl rollout restart deployment/payment-api deployment/payment-cache -n payment-hub
kubectl rollout status deployment/payment-api -n payment-hub
kubectl rollout status deployment/payment-cache -n payment-hub
```

`payment-db` e `payment-queue` não mudaram — não precisam rebuild/restart.

## 3. Port-forwards

Em dois terminais separados (deixe rodando durante o teste):

```bash
# terminal 1 — entrada do tráfego (porta 8090 neste ambiente, não 8080)
kubectl port-forward -n istio-system svc/istio-ingressgateway 8090:80

# terminal 2 — UI do Jaeger
kubectl port-forward -n istio-system svc/tracing 16686:80
```

## 4. Gerar tráfego

```bash
curl -s http://localhost:8090/check-fraud
```

Rode algumas vezes (cada chamada gera um trace novo).

## 5. Validar no Jaeger

1. Abra `http://localhost:16686`.
2. No seletor **Service**, escolha `istio-ingressgateway.istio-system` (em Ambient Mode é aqui
   que a árvore completa aparece — os apps Go não têm proxy próprio, ver nota no
   README-SOLUCAO.md).
3. Clique em **Find Traces** e abra o trace mais recente.
4. **Critério de aceite**: um único trace deve mostrar 4 spans aninhados sob o mesmo `trace_id`:
   - `payment-api.../*` — ingressgateway recebendo a requisição
   - `router outbound|80||payment-api...; egress` — ingressgateway roteando pro payment-api
   - `payment-cache.../get-card-limit*` — waypoint interceptando a chamada api → cache
   - `payment-db.../get-chargeback-history*` — waypoint interceptando a chamada cache → db

   Cada span deve ter relação pai/filho correta e duração própria (não instantânea/zerada).

   Se cada chamada aparecer como um **trace separado** (sem os 4 spans juntos), a propagação de
   headers não está funcionando — confira se as imagens `payment-api`/`payment-cache` rodando no
   cluster realmente contêm a mudança do passo 2 (`kubectl rollout status` deve mostrar o rollout
   concluído, e os pods devem ter sido recriados após o build).

## 6. Teste de regressão (garantir que nada quebrou)

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8090/process-payment
# esperado: 200

curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8090/check-fraud?error=true"
# esperado: 500 (erro real propagado da cadeia, não mascarado)

curl -s -o /dev/null -w "time_total=%{time_total}\n" "http://localhost:8090/check-fraud?delay=1000"
# esperado: time_total ~1.0s (delay propagado até o fim da cadeia)
```

## Troubleshooting

- **API REST do Jaeger dá 404 em `/api/...`**: neste addon (Jaeger 2.x) o base path é
  `/jaeger/api/...`, não `/api/...`. Isso só afeta chamadas diretas à API — a UI em
  `http://localhost:16686` funciona normalmente.
- **`curl: (7) Failed to connect to localhost port 8090`**: o port-forward do ingressgateway caiu
  (comum depois de um `kubectl rollout restart`, já que o pod antigo é substituído). Reabra o
  comando do passo 3.
- **Traces órfãos (sem os 4 spans juntos)**: ver a nota no final do passo 5.
