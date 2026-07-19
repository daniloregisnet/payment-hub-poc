# Istio Sidecar → Ambient Mode: evolução e mudança de paradigma

> Os diagramas abaixo são renderizados a partir das fontes [PlantUML](https://plantuml.com/) em
> [docs/](docs/) — edite o `.puml` correspondente e rode `plantuml -tsvg docs/*.puml` pra
> atualizar o SVG. Este projeto ([payment-hub](istio/)) já roda em **Ambient Mode** — os
> diagramas de L7 usam o caso real `payment-api → payment-cache` como exemplo, não um cenário
> genérico.

> **TL;DR sobre qual usar:** Ambient é o modelo **mais novo** e é a **recomendação atual do
> projeto Istio para implantações novas**, desde que graduou pra GA (Istio 1.24, nov/2024).
> Sidecar **não está descontinuado** — continua totalmente suportado — mas deixou de ser o único
> caminho padrão, e é hoje considerado o modelo "clássico"/anterior. Detalhes de quando cada um
> faz mais sentido: [seção 8](#8-quando-escolher-qual--e-qual-é-recomendado-hoje).

## Índice

1. [O problema que o service mesh resolve](#1-o-problema-que-o-service-mesh-resolve)
2. [Sidecar Mode: o modelo clássico](#2-sidecar-mode-o-modelo-clássico)
3. [Ambient Mode: o novo modelo](#3-ambient-mode-o-novo-modelo)
4. [ztunnel (L4) vs waypoint (L7): quem resolve o quê](#4-ztunnel-l4-vs-waypoint-l7-quem-resolve-o-quê)
5. [Comparação lado a lado](#5-comparação-lado-a-lado)
6. [Linha do tempo](#6-linha-do-tempo)
7. [Este projeto como exemplo prático](#7-este-projeto-como-exemplo-prático)
8. [Quando escolher qual — e qual é recomendado hoje](#8-quando-escolher-qual--e-qual-é-recomendado-hoje)
9. [Referências](#9-referências)

---

## 1. O problema que o service mesh resolve

Antes de comparar os dois modos, vale lembrar **por que** um service mesh existe: mTLS entre
serviços, retries, timeouts, circuit breaking, roteamento por path, autorização por identidade e
observabilidade (tracing/métricas) são requisitos transversais que, sem um mesh, cada time
reimplementa dentro do próprio código de aplicação — em cada linguagem, de novo, com bugs
diferentes.

O Istio resolve isso tirando essa responsabilidade do código da aplicação e colocando num proxy
(Envoy) que fica no caminho de rede. A pergunta que Sidecar e Ambient respondem de formas
diferentes é: **onde exatamente esse proxy deve rodar?**

---

## 2. Sidecar Mode: o modelo clássico

Desde o lançamento original do Istio, o modelo padrão foi: **um proxy Envoy por Pod**, injetado
como um container adicional (`istio-proxy`) dentro do mesmo Pod da aplicação. Um init-container
(`istio-init`) configura regras de `iptables` *dentro do namespace de rede do Pod* pra
redirecionar todo o tráfego de entrada e saída pro Envoy local, de forma transparente pra
aplicação.

![Arquitetura Sidecar](docs/sidecar-architecture.svg)
*Fonte: [docs/sidecar-architecture.puml](docs/sidecar-architecture.puml)*

### 2.1 Fluxo de uma requisição no modo Sidecar

![Fluxo de requisição — Modo Sidecar](docs/sidecar-sequence.svg)
*Fonte: [docs/sidecar-sequence.puml](docs/sidecar-sequence.puml)*

### 2.2 Limitações que motivaram o Ambient Mode

- **Overhead de recursos por Pod.** Cada Pod ganha um Envoy completo (CPU/memória reservados),
  mesmo que o serviço seja trivial e só precise de mTLS. Em clusters com centenas/milhares de
  Pods, isso vira um custo fixo relevante.
- **Acoplamento de ciclo de vida.** Atualizar a versão do proxy geralmente exige reiniciar
  (rolling restart) todos os Pods da malha — o Envoy não é um processo independente do Pod da
  aplicação.
- **Injeção via webhook é frágil.** Se o *mutating webhook* de injeção falhar ou não disparar (ex.:
  Pod criado antes do webhook estar pronto), o Pod sobe **sem** sidecar e sem aviso óbvio — ele
  simplesmente não participa da malha.
- **Ordem de inicialização/encerramento.** Historicamente, se o container da aplicação terminava
  antes do sidecar terminar de iniciar, ou terminava depois do sidecar já ter saído, requisições
  falhavam — sintoma clássico de "Job do Kubernetes preso" ou "sidecar ainda não pronto".
- **Tudo ou nada entre L4 e L7.** Não existe meio-termo: ou o Pod tem um Envoy completo (L4+L7),
  ou não tem proxy nenhum. Um serviço que só quer mTLS paga o mesmo preço de quem usa roteamento
  HTTP avançado.

---

## 3. Ambient Mode: o novo modelo

> Este é o modelo **mais moderno** dos dois, e a **recomendação atual do projeto Istio** para
> quem está começando um mesh do zero — ver [seção 8](#8-quando-escolher-qual--e-qual-é-recomendado-hoje)
> para o raciocínio completo de quando isso vale e quando não vale.

O Ambient Mode parte de uma pergunta diferente: **a maioria dos serviços só precisa de L4**
(mTLS, identidade, allow/deny simples). Só uma minoria precisa de **L7** (roteamento por path,
retries por rota, `AuthorizationPolicy` com `paths`). Então por que forçar todo mundo a rodar um
proxy L7 completo?

A resposta do Ambient é separar isso em dois componentes **sem nenhum container extra no Pod da
aplicação**:

- **ztunnel** ("zero trust tunnel") — `DaemonSet`, **um por nó**, escrito em Rust. Cobre só L4:
  mTLS automático (via um túnel HTTP/2 chamado **HBONE**), identidade SPIFFE, e
  `AuthorizationPolicy` sem `paths`/`hosts` (L4 puro).
- **waypoint** — `Deployment` Envoy, **opcional**, um por namespace (ou por ServiceAccount).
  Só existe se alguém no namespace realmente precisar de L7: `VirtualService`, `DestinationRule`,
  `AuthorizationPolicy` com `paths`. Namespaces que só querem mTLS **não têm waypoint nenhum**.

O redirecionamento de tráfego deixa de ser por `iptables` dentro de cada Pod e passa a ser feito
pelo plugin de CNI do Istio, a nível de **nó** — não há mais init-container `istio-init` por Pod.

![Arquitetura Ambient](docs/ambient-architecture.svg)
*Fonte: [docs/ambient-architecture.puml](docs/ambient-architecture.puml)*

### 3.1 Fluxo L4-only (sem waypoint no caminho)

Quando nenhum `VirtualService`/`AuthorizationPolicy` por path existe entre dois serviços, o
tráfego nunca passa por um waypoint — vai direto ztunnel-a-ztunnel:

![Fluxo de requisição — Ambient, só L4](docs/ambient-sequence-l4.svg)
*Fonte: [docs/ambient-sequence-l4.puml](docs/ambient-sequence-l4.puml)*

### 3.2 Fluxo L4+L7 (com waypoint) — caso real deste projeto

Este é exatamente o caminho `payment-api → payment-cache` deste projeto: existe um
`VirtualService` com timeout dedicado e uma `AuthorizationPolicy` restrita por `paths` em
[istio/payment-cache.yaml](istio/payment-cache.yaml), então o tráfego **precisa** passar pelo
waypoint do namespace `payment-hub`.

![Fluxo de requisição — Ambient, com Waypoint](docs/ambient-sequence-l7.svg)
*Fonte: [docs/ambient-sequence-l7.puml](docs/ambient-sequence-l7.puml)*

> Essa troca de identidade no último hop (`ZB` vê o **waypoint** como origem, não o Pod
> `payment-api` original) é a razão prática pela qual toda `AuthorizationPolicy` deste projeto
> usa `targetRefs` apontando pro waypoint em vez de `selector` no workload de destino — o
> comentário em [istio/payment-cache.yaml](istio/payment-cache.yaml) documenta isso.

### 3.3 O que se ganha

- **Footprint proporcional a nós, não a Pods.** Um ztunnel por nó cobre dezenas de Pods; um
  waypoint só existe onde há demanda de L7.
- **Adoção incremental.** Dá pra ligar mTLS (`ztunnel`) num namespace inteiro e só aplicar
  waypoint pros serviços que realmente precisam de roteamento/autorização L7 —
  `istioctl waypoint apply` é um passo separado e opcional.
- **Menor acoplamento de ciclo de vida.** Atualizar `ztunnel`/`waypoint` não exige reiniciar os
  Pods da aplicação — eles são processos independentes.
- **Degradação graciosa.** Se o waypoint cair, o tráfego L4 (mTLS via ztunnel) continua
  funcionando; só as regras L7 daquele namespace ficam indisponíveis, não a malha inteira.

### 3.4 O que se perde / cuidados

- **Mais uma camada conceitual.** Entender "quando o tráfego passa por waypoint" exige raciocinar
  sobre quais recursos (VirtualService, AuthorizationPolicy com `paths`) existem pro par
  origem/destino — não é tão direto quanto "todo Pod tem um Envoy".
- **Maturidade.** Ambient GA é bem mais recente que Sidecar (que já roda em produção desde os
  primeiros releases do Istio) — menos anos de "battle testing", menos material/ferramental de
  terceiros validado especificamente pra esse modo.
- **Dependência de recursos do nó.** Ambient usa eBPF/HBONE mais fortemente que o modelo Sidecar
  clássico — nem todo ambiente gerenciado suporta isso de forma idêntica.
- **Debug muda de mental model.** Como visto no [JAEGER-SETUP.md](JAEGER-SETUP.md), em Ambient só
  ingressgateway e waypoint geram spans de tracing — os apps não aparecem como "serviço" próprio
  no Jaeger, diferente do Sidecar onde cada Pod teria seu próprio Envoy gerando spans.

---

## 4. ztunnel (L4) vs waypoint (L7): quem resolve o quê

Esta é a divisão de trabalho central do Ambient Mode, e vale deixar inequívoca: **ztunnel nunca
decodifica HTTP** — ele só enxerga conexões (quem fala com quem, criptografado ou não). **Só o
waypoint enxerga o conteúdo da requisição** (path, método, header, status de resposta). Se um
recurso do Istio depende de olhar dentro do HTTP, ele *só* funciona onde há waypoint — não
importa quão simples a regra pareça.

### 4.1 O que o ztunnel resolve — Camada 4 (transporte)

Camada 4 é sobre **conexões**, não sobre o que trafega dentro delas: identidade de quem abriu a
conexão, se ela é criptografada, e regras do tipo "esta identidade/IP/porta pode ou não conectar
aqui" — tudo isso sem nunca abrir o pacote HTTP.

O ztunnel resolve isso automaticamente para **todo Pod de um namespace habilitado pro Ambient**,
sem nenhuma configuração extra por serviço:

- **mTLS** — criptografa e autentica toda conexão leste-oeste via HBONE, usando a identidade
  SPIFFE de origem/destino. É quem implementa o `PeerAuthentication` STRICT de
  [istio/mesh.yaml](istio/mesh.yaml).
- **Autorização L4** — a única forma de `AuthorizationPolicy` que o ztunnel sozinho consegue
  avaliar é a que usa **apenas** `source.principals`, `source.namespaces`, `source.ipBlocks` e
  `operation.ports`. Qualquer regra com `hosts`, `paths` ou `methods` é L7 e exige waypoint.
- **Telemetria L4** — bytes transferidos, RTT, conexões abertas/fechadas por identidade.

O que o ztunnel **não sabe fazer** — porque isso exigiria decodificar HTTP, e ele nunca faz isso:
rotear por path, aplicar timeout/retry por rota, autorizar por Host header, ou gerar um span de
tracing com método/status HTTP.

### 4.2 O que o waypoint resolve — Camada 7 (aplicação)

Camada 7 é sobre **o conteúdo da requisição HTTP**: qual path foi chamado, com qual método, qual
foi o status da resposta — e qualquer regra que dependa de enxergar isso.

O waypoint é um Envoy completo (o mesmo motor de proxy do modelo Sidecar, só que compartilhado
por namespace em vez de injetado por Pod). Ele resolve:

- **Roteamento HTTP** — `VirtualService` (`match.uri.prefix`, `timeout`, `retries`). Em
  [istio/payment-cache.yaml](istio/payment-cache.yaml) é o waypoint quem decide que
  `/get-card-limit` tem timeout de 16s e `/check-transaction-history` tem 5s.
- **Autorização L7** — `AuthorizationPolicy` com `hosts` (Host header), `paths` ou `methods`.
  **Todas** as policies deste projeto usam `hosts` no mínimo — por isso **todas** dependem do
  waypoint, mesmo `payment-api-authz` e `payment-queue-authz`, que não chegam a restringir por
  `paths`.
- **Circuit breaking HTTP-aware** — `DestinationRule.outlierDetection` conta erros
  **`consecutive5xxErrors`**, o que exige entender o status code da resposta HTTP — informação
  que só existe depois de decodificar a camada de aplicação.
- **Tracing L7** — é o waypoint (junto com o ingressgateway) quem gera os spans com
  `http.method`, `http.url`, `http.status_code` que aparecem no Jaeger (ver
  [README-SOLUCAO.md](README-SOLUCAO.md)) — o ztunnel nunca vê esses campos, só o volume de bytes
  trafegado.

### 4.3 Tabela-resumo

| Recurso Istio | Camada | Quem resolve | Funciona sem waypoint? |
|---|---|---|---|
| `PeerAuthentication` (mTLS) | L4 | ztunnel | Sim |
| `AuthorizationPolicy` só com `principals`/`namespaces`/`ipBlocks`/`ports` | L4 | ztunnel | Sim |
| `AuthorizationPolicy` com `hosts`/`paths`/`methods` | L7 | waypoint | **Não** |
| `VirtualService` (roteamento por path, timeout, retries) | L7 | waypoint | **Não** |
| `DestinationRule.outlierDetection` (circuit breaker por 5xx) | L7 | waypoint | **Não** |
| Métricas de bytes/RTT por conexão | L4 | ztunnel | Sim |
| Spans de tracing com method/path/status HTTP | L7 | waypoint + ingressgateway | **Não** |

> **Consequência prática, usando este projeto como exemplo:** se o waypoint de `payment-hub`
> fosse removido hoje, o mTLS de [istio/mesh.yaml](istio/mesh.yaml) continuaria garantido pelo
> ztunnel — mas **toda** `AuthorizationPolicy` em `istio/*.yaml` pararia de ser avaliada (todas
> usam `hosts`), a malha voltaria a permitir qualquer serviço falar com qualquer outro
> (inclusive `payment-queue` → `payment-db`, que hoje é bloqueado), e rotas/timeouts/circuit
> breaker parariam de ser aplicados. Cada capacidade L7 é opt-in — e some junto com o waypoint
> que a implementa.

---

## 5. Comparação lado a lado

| Aspecto | Sidecar | Ambient |
|---|---|---|
| Proxy roda em | Cada Pod (container extra) | ztunnel: por nó · waypoint: por namespace (opcional) |
| Quem paga custo de L7 | Todos os Pods, sempre | Só quem tem VirtualService/AuthorizationPolicy L7 |
| Redirecionamento de tráfego | `iptables` por Pod (`istio-init`) | CNI a nível de nó, sem init-container por Pod |
| Reinício do Pod ao atualizar proxy | Geralmente sim | Não — ztunnel/waypoint são independentes |
| Falha silenciosa de onboarding | Webhook de injeção pode falhar sem aviso | Label de namespace habilita ztunnel de forma mais previsível |
| Granularidade de L4 vs L7 | Inexistente (sempre os dois juntos) | Explícita (L4 sempre; L7 só com waypoint) |
| Nomes de serviço no tracing | Cada Pod aparece individualmente | Só ingressgateway/waypoint aparecem como "serviço" |
| Maturidade | GA desde os primeiros releases do Istio | GA desde Istio 1.24 (nov/2024) |

---

## 6. Linha do tempo

![Linha do tempo Sidecar → Ambient](docs/istio-timeline.svg)
*Fonte: [docs/istio-timeline.puml](docs/istio-timeline.puml)*

> Datas/versões de graduação de feature são aproximadas — confira o changelog oficial do Istio
> se for citar isso formalmente.

---

## 7. Este projeto como exemplo prático

O `payment-hub` já roda em Ambient Mode, e cada peça teórica acima tem um artefato correspondente
no repositório:

| Conceito | Onde está neste projeto |
|---|---|
| ztunnel (DaemonSet, L4) | Cobre `payment-hub` inteiro; garante o mTLS `STRICT` de [istio/mesh.yaml](istio/mesh.yaml) mesmo sem waypoint |
| waypoint (Deployment, L7) | `kubectl get pods -n payment-hub` mostra o Pod `waypoint-...`; aplicado via `istioctl waypoint apply -n payment-hub --enroll-namespace` |
| AuthorizationPolicy anexada ao waypoint, não ao workload | Todas as policies em `istio/*.yaml` usam `targetRefs: kind: Gateway, name: waypoint` — nunca `selector` |
| Degradação L4-only | `payment-db`/`payment-queue` não têm VirtualService de saída própria — só recebem, então o mTLS STRICT continua garantido pelo ztunnel independente do waypoint |
| Granularidade L7 real | `istio/payment-cache.yaml` tem `AuthorizationPolicy` restrita por `paths: ["/check-transaction-history", "/get-card-limit"]` — só possível porque existe waypoint no caminho |
| Tracing muda com o modo | [JAEGER-SETUP.md](JAEGER-SETUP.md) documenta que só `istio-ingressgateway.istio-system` e `waypoint.payment-hub` aparecem como serviços no Jaeger — os 4 apps Go não têm proxy próprio gerando spans |

---

## 8. Quando escolher qual — e qual é recomendado hoje

**Recomendação atual do projeto Istio:** para uma implantação nova, comece por **Ambient**. É o
modelo mais moderno, é para onde o projeto está investindo desenvolvimento desde que graduou pra
GA (Istio 1.24, nov/2024), e é hoje a opção oficialmente recomendada na documentação do Istio
para novos meshes. Isso **não** significa que Sidecar esteja depreciado ou vá deixar de ser
suportado — ele continua sendo uma opção de primeira classe, só deixou de ser o único caminho e
de ser o default "óbvio".

**Ambient tende a fazer mais sentido quando:**
- O cluster tem muitos serviços "simples" que só precisam de mTLS (a maioria dos casos reais).
- Reduzir footprint de recursos/operacional é uma prioridade.
- O projeto está começando do zero (sem automação legada em cima do modelo Sidecar).

**Sidecar ainda pode ser a escolha certa quando:**
- Já existe produção madura, com anos de automação/observabilidade construídas especificamente
  em cima do modelo Sidecar (dashboards, alertas, runbooks assumindo 1 Envoy por Pod).
- Há dependência de filtros WASM ou extensões L7 customizadas *por Pod específico*, algo mais
  direto no modelo Sidecar do que num waypoint compartilhado.
- O ecossistema de ferramentas de terceiros em uso ainda não tem suporte validado pra Ambient.

---

## 9. Referências

- Documentação oficial do Ambient Mode: `https://istio.io/latest/docs/ambient/overview/`
- Anúncio original do Ambient Mesh (2022): `https://istio.io/latest/blog/2022/introducing-ambient-mesh/`
- PlantUML (para renderizar os diagramas deste arquivo): `https://plantuml.com/`
- Fontes editáveis dos 6 diagramas: [docs/](docs/) — `plantuml -tsvg docs/*.puml` regenera os
  SVGs após qualquer alteração.
