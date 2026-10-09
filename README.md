# Rastreio do produto enviado ao criador

API de rastreio com um agregador fictício acessado por HTTP. Eventos repetidos ou recebidos fora de ordem são reconciliados sem duplicar o histórico nem fazer um evento antigo substituir o estado atual. Um código desconhecido da transportadora fica explícito como `desconhecido`, nunca como `entregue`.

Comece por [src/domain/tracking-service.js](src/domain/tracking-service.js), depois pelo [adaptador HTTP](src/providers/aggregator-http-client.js) e pelos [testes](test/). O [enunciado original](docs/enunciado.txt) foi preservado.

## Executar

Requer Node.js 22; não há dependências de terceiros. `.nvmrc` e `engines` registram essa versão.

```sh
npm ci
npm test
npm run verify:http
npm run demo
```

A demonstração sobe dois servidores reais, ambos em loopback: API em **http://127.0.0.1:3007** e agregador fictício em **http://127.0.0.1:4007**. Abra a API no navegador e use Cadastrar → Consultar agregador → Consultar agregador novamente. `Ctrl+C` encerra os dois processos.

Também podem ser executados separadamente em dois terminais:

```sh
npm run mock
```

```sh
npm start
```

`CTY123` tem uma entrega concluída, eventos fora de ordem, duplicação e um estado inventado posterior à entrega. `CTYLATE` começa o trânsito 96 horas antes do cadastro e ativa o alerta padrão de 72 horas. `CTYUNKNOWN` possui somente um estado desconhecido. Outros códigos válidos começam sem eventos. O mock congela os timestamps no primeiro cadastro: repetir a consulta não muda a identidade dos eventos.

## API

| Método e caminho | Comportamento |
| --- | --- |
| `POST /shipments` | Cadastra `{ "code": "CTY123" }` no agregador. Retorna `201`; repetir retorna `200` e não chama o provedor novamente. |
| `POST /shipments/:code/sync` | Consulta o agregador, valida o lote inteiro e incorpora eventos. Retorna o estado reconciliado. |
| `GET /shipments/:code` | Lê o histórico já salvo e reavalia o alerta com o relógio atual, sem consultar o agregador. |
| `GET /health` | Informa disponibilidade local e armazenamento em memória. |
| `GET /` | Demonstração que utiliza os mesmos endpoints; não simula respostas no navegador. |

```sh
curl -sS -X POST http://127.0.0.1:3007/shipments \
  -H 'Content-Type: application/json' -d '{"code":"CTY123"}'
curl -sS -X POST http://127.0.0.1:3007/shipments/CTY123/sync
curl -sS -X POST http://127.0.0.1:3007/shipments/CTY123/sync
curl -sS http://127.0.0.1:3007/shipments/CTY123
```

O código é normalizado para maiúsculas, tem entre 3 e 40 caracteres e aceita letras, números e hífen. Entrada inválida retorna `400`; código não cadastrado, `404`; método incorreto, `405` com `Allow`; falha, timeout ou resposta inválida do provedor, `502`. O erro de integração preserva o histórico anterior. O corpo de cadastro está limitado a 64 KiB.

### Payload bruto e normalizado

O [payload bruto completo](fixtures/aggregator-raw.json) possui seis entradas, incluindo uma ocorrência repetida:

```json
{
  "tracking_code": "CTY123",
  "checkpoints": [
    { "event_uuid": "e-delivered", "created_at": "2026-10-08T16:00:00.000Z", "state": "DELIVERY_CONFIRMED" },
    { "event_uuid": "e-transit", "created_at": "2026-10-08T10:00:00.000Z", "state": "MOVING_BETWEEN_HUBS" },
    { "event_uuid": "e-unknown", "created_at": "2026-10-08T17:00:00.000Z", "state": "DELIVERED_TO_ANOTHER_DIMENSION" }
  ]
}
```

Esse recorte ilustra o dialeto; o arquivo completo inclui também postagem, saída para entrega e a duplicação. A [resposta normalizada completa](docs/example-normalized.json) foi produzida pelo comando `npm run verify:http`, passando por dois servidores HTTP reais com relógio fixo em `2026-10-10T08:00:00.000Z`:

```json
{
  "code": "CTY123",
  "status": "entregue",
  "statusAt": "2026-10-08T16:00:00.000Z",
  "lastEventAt": "2026-10-08T17:00:00.000Z",
  "transitStartedAt": "2026-10-08T08:00:00.000Z",
  "alert": {
    "active": false,
    "reason": "entrega_concluida",
    "elapsedMs": 28800000,
    "thresholdMs": 259200000,
    "evaluatedAt": "2026-10-10T08:00:00.000Z"
  }
}
```

O exemplo é um recorte; a resposta também possui `registeredAt` e `history` com **cinco** eventos únicos. `lastEventAt` inclui o evento desconhecido; `statusAt` aponta para a entrega reconhecida, preservando a diferença para auditoria.

## Regras e decisões

### Fronteira do provedor

O domínio recebe um objeto com duas operações assíncronas:

```js
await provider.register(code);
const events = await provider.getEvents(code);
// [{ id, occurredAt, status, carrierStatus }]
```

`carrierStatus` é apenas texto de diagnóstico. A regra de negócio não interpreta esse texto nem conhece `event_uuid`, `created_at`, `state` ou `checkpoints`. Para trocar de agregador, implemente essas duas operações e injete o novo cliente em `TrackingService`. [src/server.js](src/server.js) faz a composição.

| Estado do agregador fictício | Estado estável |
| --- | --- |
| `PACKAGE_ACCEPTED` | `postado` |
| `MOVING_BETWEEN_HUBS` | `em_transito` |
| `DRIVER_ROUTE` | `saiu_para_entrega` |
| `DELIVERY_CONFIRMED` | `entregue` |
| `DELIVERY_PROBLEM` | `excecao` |
| Qualquer outro texto | `desconhecido` |

`desconhecido` é o estado de segurança para informação não reconhecida; `sem_eventos` descreve um cadastro ainda sem ocorrências. O estado desconhecido permanece no histórico, não substitui um estado conhecido e não inventa o início do trânsito.

### Ordem, idempotência e atomicidade

- Timestamps devem conter fuso explícito e são convertidos para UTC. Datas inexistentes ou eventos malformados fazem o lote inteiro falhar, antes de qualquer alteração local.
- O histórico é ordenado pelo instante numérico do evento (`Date.parse`), incluindo offsets que geram um ano UTC expandido. Em empate, a prioridade é `desconhecido < postado < em_transito < saiu_para_entrega < excecao < entregue`; depois usa texto bruto e id em comparação lexical determinística. A ordem de chegada não participa da decisão.
- Um id repetido com o mesmo conteúdo é idempotente. Reutilizar o id com conteúdo diferente é erro de protocolo e preserva o histórico anterior.
- Ocorrências com a mesma combinação normalizada `(instante, estado, texto bruto)` são únicas mesmo quando o agregador reemite outro id. O representante usa o menor id lexical. Os ids anteriores continuam registrados para detectar colisões futuras.
- O estado atual é o evento conhecido mais recente. `entregue` é terminal para este pacote: scans atrasados, estados desconhecidos ou atualizações posteriores inconsistentes não reabrem uma entrega. Devoluções não fazem parte deste fluxo e precisariam de um contrato próprio.
- Consultas concorrentes incorporam os eventos no mesmo registro, após cada resposta ser validada de forma síncrona. Uma resposta antiga concluída depois de uma nova não perde eventos nem regride o estado.

### Atraso com relógio controlado

O início é a primeira ocorrência de **postado, em trânsito ou saiu para entrega**, isto é, o primeiro sinal de que o pacote já foi entregue à logística. Cadastro sozinho, exceção isolada e estado desconhecido não contam como início.

Para pacotes sem entrega confirmada: `elapsedMs = max(0, now - transitStartedAt)`. O alerta fica ativo somente quando `elapsedMs > thresholdMs`; no instante exato do limite ainda está dentro do prazo. Uma exceção não apaga o tempo já em trânsito.

Com entrega confirmada, a contagem termina em `deliveredAt` e o alerta ativo é sempre falso, com razão `entrega_concluida`. Assim, consultar uma entrega normal dias depois não a transforma em atraso. Essa regra também encerra um alerta que existia enquanto o pacote ainda estava em trânsito. Não se calcula SLA histórico de entregas concluídas.

O relógio é injetável. A configuração padrão é 72 horas; `TRANSIT_LIMIT_HOURS` aceita inteiro positivo. `PORT`, `AGGREGATOR_URL` e `AGGREGATOR_TIMEOUT_MS` também são configuráveis; veja [.env.example](.env.example). A API permanece em `127.0.0.1`. Para carregar `.env`, use `node --env-file=.env src/server.js`.

## Validação e evidências

`npm test` executa **28 testes** em Node.js 22.23.3, sem rede externa. A suíte inclui domínio, cliente com servidor HTTP real e fluxo API → cliente → agregador. Testa eventos fora de ordem, repetições, empate de timestamps, status inventado, troca de fuso, ano UTC expandido por offset, erro/timeout HTTP, falhas de lote sem alteração parcial, concorrência, cópias do histórico e limites de atraso com data controlada.

- [Saída real da suíte](docs/evidence/test.txt).
- Regressão de ordenação com ano UTC expandido: [falha reproduzida antes da correção](docs/evidence/utc-expanded-before.txt) e [teste passando depois](docs/evidence/utc-expanded-after.txt).
- [Tráfego HTTP e respostas verificadas](docs/evidence/http-flow.json), gerado novamente por `npm run verify:http`.
- [Resposta normalizada](docs/example-normalized.json) e [payload bruto](fixtures/aggregator-raw.json).
- A demonstração no navegador utiliza HTTP real e pode ser usada para registrar o cadastro, consulta e consulta repetida.

## Escopo

Esta entrega usa dados sintéticos e armazenamento em memória para tornar a regra reproduzível. Reiniciar apaga cadastros e histórico. Não conecta uma transportadora real, não envia notificações e não inclui autenticação ou persistência distribuída. O aviso de atraso é retornado na API; entrega de notificações seria um consumidor desse sinal. Em produção, armazenamento transacional e deduplicação persistente seriam necessários.

## Uso de IA e revisão

O Codex gerou a implementação, o mock, os testes e esta documentação. O mesmo agente verificou o contrato, executou os testes em Node.js 22 e validou o fluxo por HTTP real, incluindo os casos de erro e borda descritos. Não houve revisão humana do código nesta etapa. Revisões independentes adicionais, quando concluídas, serão registradas junto às evidências antes do envio do desafio; este texto não as considera já realizadas.
