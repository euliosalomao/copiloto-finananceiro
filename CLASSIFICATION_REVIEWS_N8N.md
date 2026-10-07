# Fila de classificações pelo WhatsApp

O backend guarda o estado da revisão. O n8n apenas orquestra as chamadas e a
Evolution transporta as mensagens do WhatsApp.

## Base URL e autenticação

Dentro da rede Docker da VPS:

```text
http://copiloto_backend:3333
```

Todas as chamadas usam a credencial Header Auth:

```http
Authorization: Bearer TOKEN_DO_N8N
```

## 1. Iniciar ou continuar a fila

```http
POST /classification-reviews/next
```

Não possui body. Somente classificações com as três condições abaixo entram:

```text
status = PENDING_REVIEW
classified_by = AI
category_id preenchida
```

Quando existe uma pendência disponível:

```json
{
  "queueState": "READY",
  "review": {
    "reviewId": "UUID",
    "status": "CLAIMED",
    "reclaimed": false,
    "claimExpiresAt": "2026-09-30T12:15:00.000Z",
    "transaction": {
      "id": "UUID",
      "description": "Supermercado BH",
      "amount": "74.84",
      "transactionDate": "2026-08-03",
      "direction": "OUTFLOW",
      "operationType": "EXPENSE",
      "account": {
        "id": "UUID",
        "name": "Inter PF",
        "context": "PF"
      }
    },
    "suggestion": {
      "categoryId": "UUID",
      "categoryName": "Alimentação",
      "categoryType": "EXPENSE",
      "confidence": 87.5,
      "reasoning": "Descrição compatível com alimentação."
    }
  }
}
```

Quando não há trabalho para enviar, `review` é `null` e `queueState` explica:

```text
EMPTY             nenhuma sugestão da IA pendente
WAITING_REPLY     uma mensagem já aguarda resposta
CLAIM_IN_PROGRESS outro fluxo reivindicou uma review há menos de 15 minutos
```

Um `CLAIMED` não associado a uma mensagem expira em 15 minutos. Depois disso,
o próximo `/next` devolve a mesma review com `reclaimed: true`. Isso recupera
uma execução do n8n que morreu entre buscar a pendência e enviar o WhatsApp.

## 2. Associar a mensagem enviada pela Evolution

Depois de enviar o WhatsApp, use o identificador devolvido pela Evolution:

```http
PATCH /classification-reviews/UUID_DA_REVIEW/message
Content-Type: application/json

{
  "externalMessageId": "ID_DA_MENSAGEM_EVOLUTION"
}
```

Resposta:

```json
{
  "reviewId": "UUID",
  "status": "WAITING_REPLY",
  "externalMessageId": "ID_DA_MENSAGEM_EVOLUTION",
  "messageSentAt": "2026-09-30T12:00:00.000Z"
}
```

Repetir a chamada com a mesma review e o mesmo ID é seguro. Usar outro ID na
mesma review, ou reutilizar o mesmo ID em outra review, retorna conflito.

## 3. Resolver uma resposta

O webhook da Evolution deve chegar primeiro ao n8n. O n8n responde rapidamente
à Evolution e interpreta a mensagem. A IA do n8n pode escolher uma ação, mas
somente o backend escreve no banco.

### Aceitar a sugestão

```http
POST /classification-reviews/reply
Content-Type: application/json

{
  "quotedMessageId": "ID_DA_MENSAGEM_EVOLUTION",
  "message": "sim",
  "action": "ACCEPT_SUGGESTION",
  "createMerchantRule": false
}
```

O n8n não precisa reenviar o `categoryId`: o backend usa a sugestão original.

### Trocar a categoria

```http
POST /classification-reviews/reply
Content-Type: application/json

{
  "quotedMessageId": "ID_DA_MENSAGEM_EVOLUTION",
  "message": "não, lazer",
  "action": "CHANGE_CATEGORY",
  "categoryId": "UUID_DA_CATEGORIA",
  "createMerchantRule": true,
  "merchantRule": {
    "pattern": "STEAM",
    "matchType": "CONTAINS"
  }
}
```

Para descobrir categorias válidas, o n8n pode consultar:

```http
GET /categories
```

O endpoint de reply executa na mesma transação de banco:

1. confirma a categoria;
2. atualiza `transactions.primary_category_id`;
3. cria a merchant rule, quando solicitada;
4. marca a review como `RESOLVED`;
5. salva a resposta textual para auditoria.

Depois ele reivindica a próxima review e responde:

```json
{
  "resolved": {
    "reviewId": "UUID",
    "transactionId": "UUID",
    "categoryId": "UUID",
    "merchantRuleCreated": false,
    "merchantRuleId": null,
    "alreadyResolved": false
  },
  "queueState": "READY",
  "next": {
    "reviewId": "UUID",
    "transaction": {},
    "suggestion": {}
  }
}
```

Se não houver outra sugestão, `next` é `null`. O n8n simplesmente encerra.
Repetir um webhook de uma review já resolvida é idempotente e retorna
`alreadyResolved: true` sem confirmar ou criar regra novamente.

## Fluxos no n8n

### Schedule diário

```text
Schedule
→ POST /classification-reviews/next
→ review é null? encerra
→ formata mensagem
→ Evolution SEND
→ PATCH /classification-reviews/:reviewId/message
→ encerra
```

### Webhook da Evolution

```text
Webhook
→ responde 200 rapidamente para a Evolution
→ lê quotedMessageId e texto
→ interpreta ACCEPT_SUGGESTION ou CHANGE_CATEGORY
→ POST /classification-reviews/reply
→ next é null? encerra
→ formata próxima mensagem
→ Evolution SEND
→ PATCH da nova review/message
→ encerra
```

