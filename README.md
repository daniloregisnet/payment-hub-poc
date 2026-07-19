# Payment Hub — Laboratório de Service Mesh com Istio (Ambient Mode)

## Overview

Este projeto é um **laboratório prático de aula** sobre service mesh: uma plataforma de
pagamentos fictícia, composta por microsserviços Go propositalmente simples, usada como pretexto
para demonstrar — ao vivo e com um clique — padrões de resiliência e observabilidade que um
service mesh (Istio, em **Ambient Mode**) provê sem exigir nenhuma dessas features embutida no
código da aplicação.

Não é um sistema de pagamentos real. É um ambiente controlado onde dá pra **causar** um timeout,
um circuit breaker abrindo, uma fila sob backpressure ou uma chamada barrada por autorização — e
observar exatamente o que o mesh faz a respeito, com tracing distribuído mostrando o caminho
completo da requisição através de todos os hops.

A cadeia simulada é a de uma checagem de fraude num pagamento:

```
admin-panel (Angular)
      │  clique num cenário
      ▼
payment-port  ── orquestra os 5 cenários de demo
      │
      ▼
payment-api  ──►  payment-cache  ──►  payment-db
                                         ▲
                        payment-queue ───┘ (não deveria conseguir falar
                                              direto com o DB — cenário 5)
```

Toda essa malha roda sob **Istio Ambient Mode**: mTLS `STRICT` automático entre todos os hops
(via `ztunnel`), e roteamento/timeout/retry/autorização por path aplicados por um `waypoint`
compartilhado do namespace — sem sidecar em nenhum Pod. Para entender a fundo essa escolha de
arquitetura (e por que ela é diferente do Istio "clássico" com sidecar), veja
[ISTIO-SIDECAR-VS-AMBIENT.md](ISTIO-SIDECAR-VS-AMBIENT.md).

## Os 5 cenários de demonstração

Servidos por `payment-port` e disparados com um clique pelo `admin-panel`:

| # | Cenário | O que mostra |
|---|---|---|
| 1 | **Happy Path** | 10 requisições normais, linha de base de latência |
| 2 | **Timeout + Retry** | Backend responde em 15s contra um timeout de 5s no `VirtualService` — a chamada falha por timeout, não por erro do serviço |
| 3 | **Backpressure** | 100 requisições paralelas contra uma fila com capacidade máxima 50 — mostra o `429` real de saturação |
| 4 | **Circuit Breaker** | Força erros 5xx consecutivos até o `outlierDetection` da `DestinationRule` ejetar o destino, espera o `baseEjectionTime`, testa a recuperação |
| 5 | **Autorização Negada** | `payment-port` roda com a mesma ServiceAccount do `payment-queue` — reproduz o `403` real que a malha aplicaria se a fila tentasse falar direto com o banco de fraude |

## Serviços

| Serviço | Porta | Papel |
|---|---|---|
| `payment-api` | 8000 | Entrada da cadeia — `process-payment`, `check-fraud` |
| `payment-cache` | 8001 | Cache de transações; encaminha `get-card-limit` pro DB |
| `payment-db` | 8002 | "Banco" de histórico de fraude/chargeback |
| `payment-queue` | 8003 | Fila de liquidação com limite de 50 itens (cenário de Backpressure) |
| `payment-port` | 8004 | Orquestra os 5 cenários; expõe `/api/scenarios/*` (JSON e SSE) pro painel |
| `admin-panel` | 4200 (dev) | Painel Angular que dispara os cenários e renderiza o resultado em tempo real |

## O mesh Istio

- **mTLS mesh-wide** (`STRICT`), sem certificado nenhum gerenciado manualmente — o `istiod` é sua
  própria CA e emite/rotaciona os certificados de cada workload sozinho: [istio/mesh.yaml](istio/mesh.yaml)
- **Contrato de rede isolado por serviço** (`VirtualService` + `DestinationRule` +
  `AuthorizationPolicy` juntos, um arquivo por serviço): [istio/](istio/)
- **Entrada pública** (Gateway + rota pro `admin-panel` e pro `payment-port`): [ingress.yaml](ingress.yaml)
- **Tracing distribuído** (Jaeger, propagação de headers ponta a ponta): ver seção de
  documentação abaixo

## Estrutura do repositório

```
payment-hub-services/   Microsserviços Go (api, cache, db, queue, payment-port)
admin-panel/            Painel Angular (frontend dos 5 cenários)
istio/                  Contrato de rede Istio — um arquivo por serviço + mesh.yaml
docs/                   Diagramas PlantUML (fonte .puml + .svg renderizado)
manifests.yaml          Deployments + Services + ServiceAccount (namespace payment-hub)
ingress.yaml            Gateway + rota pública (payment-gateway)
payment-port.yaml       Deployment do orquestrador de cenários
istio-configmap-*.yaml,
telemetry-tracing.yaml  Addon Jaeger e tracing mesh-wide
```

## Documentação

| Documento | Conteúdo |
|---|---|
| [README-SOLUCAO.md](README-SOLUCAO.md) | A solução de tracing distribuído (Jaeger): o que foi implementado e por quê |
| [README-TESTE.md](README-TESTE.md) | Passo a passo validado pra testar/reproduzir o tracing distribuído |
| [JAEGER-SETUP.md](JAEGER-SETUP.md) | Registro histórico da sessão que implementou o tracing (decisões operacionais, desvios do plano) |
| [ISTIO-SIDECAR-VS-AMBIENT.md](ISTIO-SIDECAR-VS-AMBIENT.md) | Evolução e mudança de paradigma: Istio Sidecar → Ambient Mode, com diagramas |
| [istio/](istio/) | Contrato de rede Istio, isolado por serviço |
| [docs/](docs/) | Fontes PlantUML (`.puml`) e diagramas renderizados (`.svg`) usados na documentação |
